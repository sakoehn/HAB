"""
index.py
--------
In-memory indexes built once at startup and queried at runtime.

Structures
~~~~~~~~~~
_SEARCH_INDEX        inverted text index: (source, token) → set of annotation_ids
_SEARCH_INDEX_SORTED sorted key list per source (enables binary-search prefix matching)
_ANN_META            one canonical record per (source, annotation_id)
_MAPPING_INDEX       source → annotation_id → [(sample_name, row_dict)]
_INDEX_READY         True once build_search_index() completes

All structures are module-level so they survive across requests.  Nothing
here performs file I/O directly — that is delegated to cache.py.
"""

from typing import Any

from .cache import (
    AnnotationSource,
    extract_annotation_name,
    extract_egc,
    extract_norm_egc,
    extract_parent,
    get_all_sample_names,
    get_timepoint,
    load_annotations_by_source_uncached,
    load_tsv,
    _TSV_CACHE,
)

# ── Index data structures ─────────────────────────────────────────────────────

_SOURCES = ("kegg", "cog", "enzyme", "taxonomy")

_SEARCH_INDEX: dict[str, dict[str, set[str]]] = {s: {} for s in _SOURCES}
_SEARCH_INDEX_SORTED: dict[str, list[str]]    = {s: [] for s in _SOURCES}

_ANN_META: dict[str, dict[str, dict]] = {s: {} for s in _SOURCES}

_MAPPING_INDEX: dict[str, dict[str, list[tuple[str, dict]]]] = {s: {} for s in _SOURCES}

_INDEX_READY = False


# ── Datetime sorting helpers ──────────────────────────────────────────────────

def _parse_any_datetime(dt_str: str):
    """
    Parse a datetime string that may be unpadded "M/D/YY H:MM" (as used in
    JGI_ID_Timepoints_128.csv), padded "MM/DD/YY HH:MM", ISO format, or a
    bare "YYYY-MM-DD" date (as sent by <input type="date"> pickers, e.g.
    /annotations/top's date_from/date_to).
    Returns a datetime object, or None if no format matches.
    """
    from datetime import datetime
    for fmt in ("%m/%d/%y %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(dt_str, fmt)
        except ValueError:
            continue
    return None


def timepoint_sort_key(sample_name: str) -> float:
    """
    Sort key for chronological ordering by timepoint datetime.

    Returns a Unix timestamp (float).  Returns -1.0 for samples with no
    timepoint so missing data sorts first predictably.

    IMPORTANT: never compare raw DateTime strings from JGI_ID_Timepoints_128.csv
    directly — they are unpadded ("M/D/YY H:MM") and sort incorrectly as
    plain strings (e.g. "6/9/21" > "6/18/21").
    """
    tp     = get_timepoint(sample_name)
    dt_str = (tp or {}).get("datetime")
    if not dt_str:
        return -1.0
    parsed = _parse_any_datetime(dt_str)
    return parsed.timestamp() if parsed is not None else -1.0


def timepoint_dt_sort_key(datetime_str: str | None) -> float:
    """
    Same as timepoint_sort_key but accepts a raw datetime string directly,
    for sorting result dicts that already carry a 'datetime' field.
    """
    if not datetime_str:
        return -1.0
    parsed = _parse_any_datetime(datetime_str)
    return parsed.timestamp() if parsed is not None else -1.0


def is_within_date_range(dt_str: str | None, date_from: str | None, date_to: str | None) -> bool:
    """
    True if a sample's raw datetime string falls within [date_from, date_to]
    (both bounds inclusive, either may be None/omitted).

    date_from/date_to are bare "YYYY-MM-DD" strings from the frontend's
    <input type="date"> pickers -- comparing them against dt_str as plain
    text is wrong, since dt_str is unpadded "M/D/YY H:MM"
    (e.g. "6/9/21 8:00" < "6/18/21 ..." lexically, even though June 9 is
    earlier than June 18). Both sides are parsed to datetime objects first.

    date_to is treated as covering the whole day (through 23:59:59), so a
    sample timestamped e.g. "6/5/21 21:00" still matches date_to=2021-06-05.
    A dt_str/date_from/date_to that fails to parse is treated as not
    matching that bound (dt_str: excluded entirely; a bound: that bound is
    ignored) rather than raising, since malformed input shouldn't 500 the
    endpoint.
    """
    dt = _parse_any_datetime(dt_str) if dt_str else None
    if dt is None:
        return False
    if date_from:
        from_dt = _parse_any_datetime(date_from)
        if from_dt is not None and dt < from_dt:
            return False
    if date_to:
        to_dt = _parse_any_datetime(date_to)
        if to_dt is not None and dt.date() > to_dt.date():
            return False
    return True


def compute_date_range() -> tuple[str, str] | tuple[None, None]:
    """
    Derive the ISO date range from TIMEPOINTS, sorting by parsed datetime
    rather than raw string to avoid the unpadded-date ordering bug.
    """
    from .cache import TIMEPOINTS

    datetimes = [tp["datetime"] for tp in TIMEPOINTS.values() if tp.get("datetime")]
    if not datetimes:
        return None, None

    parsed = [(s, _parse_any_datetime(s)) for s in datetimes]
    parsed = [(s, d) for s, d in parsed if d is not None]
    if not parsed:
        return None, None

    parsed.sort(key=lambda pair: pair[1])

    def _to_iso(dt_str: str) -> str:
        dt = _parse_any_datetime(dt_str)
        if dt is not None:
            return dt.strftime("%Y-%m-%d")
        return dt_str[:10] if len(dt_str) >= 10 else dt_str

    return _to_iso(parsed[0][0]), _to_iso(parsed[-1][0])


# Computed once at import time so /status and astronomy.py can read it cheaply.
DATA_DATE_MIN, DATA_DATE_MAX = compute_date_range()


# ── Index build logic ─────────────────────────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    return [t.lower() for t in text.split() if t]


def _index_annotation(source: str, annotation_id: str, value: Any) -> None:
    """Add one annotation to the inverted index. Idempotent."""
    idx  = _SEARCH_INDEX[source]
    name = extract_annotation_name(value) or ""

    for token in _tokenize(annotation_id) + _tokenize(name):
        idx.setdefault(token, set()).add(annotation_id)

    idx.setdefault(annotation_id.lower(), set()).add(annotation_id)


def _build_sorted_key_lists() -> None:
    for src in _SOURCES:
        _SEARCH_INDEX_SORTED[src] = sorted(_SEARCH_INDEX[src].keys())


def build_search_index() -> None:
    """
    Populate all in-memory indexes from the JSON caches in a single
    O(samples × annotations) pass.

    Builds simultaneously:
    - Inverted search index + sorted key lists (text search)
    - _ANN_META              (per-annotation aggregate stats)

    Must be called after the JSON caches are warm (i.e. after load_kegg /
    load_cog / … have been called for every sample).
    """
    global _INDEX_READY

    source_loaders = [
        (AnnotationSource.kegg,     "kegg"),
        (AnnotationSource.cog,      "cog"),
        (AnnotationSource.enzyme,   "enzyme"),
        (AnnotationSource.taxonomy, "taxonomy"),
    ]

    all_samples = sorted(get_all_sample_names(), key=timepoint_sort_key)

    # Accumulates raw egc/norm_egc values per annotation for aggregate stats.
    egc_acc:      dict[str, dict[str, list[float]]] = {src: {} for _, src in source_loaders}
    norm_egc_acc: dict[str, dict[str, list[float]]] = {src: {} for _, src in source_loaders}

    for sample_name in all_samples:
        for source_enum, src in source_loaders:
            data = load_annotations_by_source_uncached(sample_name, source_enum)
            meta = _ANN_META[src]
            acc  = egc_acc[src]
            nacc = norm_egc_acc[src]

            for annotation_id, value in data.items():
                _index_annotation(src, annotation_id, value)

                if annotation_id not in meta:
                    meta[annotation_id] = {
                        "annotation_id": annotation_id,
                        "name":          extract_annotation_name(value),
                        "parent":        extract_parent(value, src),
                        "value":         value,
                        "mean_egc":      None,
                        "max_egc":       None,
                        "mean_norm_egc": None,
                        "max_norm_egc":  None,
                        "sample_count":  0,
                    }

                egc      = extract_egc(value)
                norm_egc = extract_norm_egc(value)

                if egc is not None:
                    acc.setdefault(annotation_id, []).append(egc)
                if norm_egc is not None:
                    nacc.setdefault(annotation_id, []).append(norm_egc)

    # Compute aggregates — O(unique annotations).
    for _, src in source_loaders:
        meta = _ANN_META[src]
        nacc = norm_egc_acc[src]
        for annotation_id, vals in egc_acc[src].items():
            if annotation_id not in meta:
                continue
            norm_vals = nacc.get(annotation_id, [])
            meta[annotation_id]["mean_egc"]     = sum(vals) / len(vals)
            meta[annotation_id]["max_egc"]      = max(vals)
            meta[annotation_id]["sample_count"] = len(vals)
            if norm_vals:
                meta[annotation_id]["mean_norm_egc"] = sum(norm_vals) / len(norm_vals)
                meta[annotation_id]["max_norm_egc"]  = max(norm_vals)

    _INDEX_READY = True
    _build_sorted_key_lists()


def build_mapping_index() -> None:
    """
    Build an inverted index from all cached TSV mapping files.

    Maps (source, annotation_id) → [(sample_name, row)], where row is the
    same MappingRow NamedTuple stored in _TSV_CACHE (not a dict -- see
    MappingRow's own docstring in api/cache.py), so /mappings/search is
    O(1) instead of O(128 × tsv_rows).

    Must be called after TSVs are warm in _TSV_CACHE.
    """
    source_to_col: dict[str, str] = {
        "kegg":     "kegg_id",
        "enzyme":   "enzyme",
        "cog":      "cog_id",
        "taxonomy": "taxonomy",
    }

    for sample_name, rows in _TSV_CACHE.items():
        for row in rows:
            for source, col in source_to_col.items():
                val = getattr(row, col)
                if not val:
                    continue
                ann_id = val.strip()
                _MAPPING_INDEX[source].setdefault(ann_id, []).append((sample_name, row))


def search_index(source: str, q: str) -> set[str]:
    """
    Return annotation_ids matching query q via token lookup.

    Supports exact-token matches and substring matches, so a short query
    like "iro" or "cohol" matches longer indexed words ("iron", "alcohol").
    Multiple tokens are AND-ed so a query like "photosystem II" only returns
    annotations that contain both tokens.

    Deliberately one-directional (query is a substring of the indexed word,
    never the reverse): matching whenever a SHORT indexed word is a
    substring of the query flooded results with unrelated annotations (W3).
    E.g. searching "ferredoxin" matched every taxonomy entry with "f" as one
    of its tokens (a single-letter strain suffix, tokenized on whitespace),
    since "f" in "ferredoxin" is trivially true -- 113 unrelated matches on
    real data. Raising a length threshold on the indexed word doesn't fully
    fix it either: "ferredoxin" happens to contain the real English
    substrings "red" and "err" (fer-RED-oxin, f-ERR-edoxin), so even a
    3+ char indexed word can coincidentally collide. The reverse direction
    has no real use case here (nothing in this codebase's tests or callers
    relies on it) and isn't worth that false-positive risk.
    """
    idx     = _SEARCH_INDEX.get(source, {})
    keys    = _SEARCH_INDEX_SORTED.get(source, [])
    tokens  = q.lower().strip().split()
    if not tokens:
        return set()

    result: set[str] | None = None
    for token in tokens:
        matched: set[str] = set()

        if token in idx:
            matched |= idx[token]

        for key in keys:
            if token in key:
                matched |= idx.get(key, set())

        result = matched if result is None else result & matched
        if not result:
            break

    return result or set()
