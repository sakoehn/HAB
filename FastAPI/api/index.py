"""
index.py
--------
In-memory indexes built once at startup and queried at runtime.

Structures
~~~~~~~~~~
_SEARCH_INDEX        inverted text index: (source, token) → set of annotation_ids
_SEARCH_INDEX_SORTED sorted key list per source (enables binary-search prefix matching)
_ANN_META            one canonical record per (source, annotation_id)
_EGC_MATRIX          source → annotation_id → [egc | None] per sample (chronological)
_NORM_EGC_MATRIX     source → annotation_id → [norm_egc | None] per sample
_EGC_NAME_MAP        source → annotation_id → name string
_EGC_PARENT_MAP      source → annotation_id → parent string
_EGC_SAMPLES         ordered sample list used when the matrices were built
_MAPPING_INDEX       source → annotation_id → [(sample_name, row_dict)]
_INDEX_READY         True once build_search_index() completes

All structures are module-level so they survive across requests.  Nothing
here performs file I/O directly — that is delegated to cache.py.
"""

import bisect
import threading
from typing import Any

from .cache import (
    AnnotationSource,
    extract_annotation_name,
    extract_egc,
    extract_norm_egc,
    extract_parent,
    get_all_sample_names,
    get_timepoint,
    load_annotations_by_source,
    load_tsv,
    _TSV_CACHE,
)

import math

# ── Index data structures ─────────────────────────────────────────────────────

_SOURCES = ("kegg", "cog", "enzyme", "taxonomy")

_SEARCH_INDEX: dict[str, dict[str, set[str]]] = {s: {} for s in _SOURCES}
_SEARCH_INDEX_SORTED: dict[str, list[str]]    = {s: [] for s in _SOURCES}

_ANN_META: dict[str, dict[str, dict]] = {s: {} for s in _SOURCES}

_EGC_MATRIX:      dict[str, dict[str, list[float | None]]] = {s: {} for s in _SOURCES}
_NORM_EGC_MATRIX: dict[str, dict[str, list[float | None]]] = {s: {} for s in _SOURCES}
_EGC_NAME_MAP:    dict[str, dict[str, str | None]]          = {s: {} for s in _SOURCES}
_EGC_PARENT_MAP:  dict[str, dict[str, str | None]]          = {s: {} for s in _SOURCES}

_EGC_SAMPLES: list[str] = []

_MAPPING_INDEX: dict[str, dict[str, list[tuple[str, dict]]]] = {s: {} for s in _SOURCES}

_INDEX_READY = False

# Prevents concurrent file-scan fallback during warmup from racing on the same
# I/O and timing out.
_EGC_BUILD_LOCK = threading.Lock()


# ── Datetime sorting helpers ──────────────────────────────────────────────────

def _parse_any_datetime(dt_str: str):
    """
    Parse a datetime string that may be unpadded "M/D/YY H:MM" (as used in
    JGI_ID_Timepoints_128.csv), padded "MM/DD/YY HH:MM", or ISO format.
    Returns a datetime object, or None if no format matches.
    """
    from datetime import datetime
    for fmt in ("%m/%d/%y %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
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
    - _EGC_MATRIX            (full EGC time-series for correlation)
    - _NORM_EGC_MATRIX       (full norm_egc time-series)

    Must be called after the JSON caches are warm (i.e. after load_kegg /
    load_cog / … have been called for every sample).
    """
    global _INDEX_READY, _EGC_SAMPLES

    source_loaders = [
        (AnnotationSource.kegg,     "kegg"),
        (AnnotationSource.cog,      "cog"),
        (AnnotationSource.enzyme,   "enzyme"),
        (AnnotationSource.taxonomy, "taxonomy"),
    ]

    all_samples    = sorted(get_all_sample_names(), key=timepoint_sort_key)
    _EGC_SAMPLES   = all_samples
    sample_idx_map = {s: i for i, s in enumerate(all_samples)}

    # Accumulates raw EGC values per annotation for aggregate stats.
    egc_acc: dict[str, dict[str, list[float]]] = {src: {} for _, src in source_loaders}

    for sample_name in all_samples:
        for source_enum, src in source_loaders:
            data     = load_annotations_by_source(sample_name, source_enum)
            meta     = _ANN_META[src]
            acc      = egc_acc[src]
            matrix   = _EGC_MATRIX[src]
            norm_mat = _NORM_EGC_MATRIX[src]
            nmap     = _EGC_NAME_MAP[src]
            pmap     = _EGC_PARENT_MAP[src]

            for annotation_id, value in data.items():
                _index_annotation(src, annotation_id, value)

                if annotation_id not in meta:
                    name   = extract_annotation_name(value)
                    parent = extract_parent(value, src)
                    meta[annotation_id] = {
                        "annotation_id": annotation_id,
                        "name":          name,
                        "parent":        parent,
                        "value":         value,
                        "mean_egc":      None,
                        "max_egc":       None,
                        "mean_norm_egc": None,
                        "max_norm_egc":  None,
                        "sample_count":  0,
                    }
                    nmap[annotation_id]     = name
                    pmap[annotation_id]     = parent
                    matrix[annotation_id]   = [None] * len(all_samples)
                    norm_mat[annotation_id] = [None] * len(all_samples)

                egc      = extract_egc(value)
                norm_egc = extract_norm_egc(value)
                idx      = sample_idx_map[sample_name]

                if egc is not None:
                    matrix[annotation_id][idx] = egc
                if norm_egc is not None:
                    norm_mat[annotation_id][idx] = norm_egc
                if egc is not None:
                    acc.setdefault(annotation_id, []).append(egc)

    # Compute aggregates — O(unique annotations).
    for _, src in source_loaders:
        meta     = _ANN_META[src]
        norm_mat = _NORM_EGC_MATRIX[src]
        for annotation_id, vals in egc_acc[src].items():
            if annotation_id not in meta:
                continue
            norm_vals = [v for v in norm_mat.get(annotation_id, []) if v is not None]
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

    Maps (source, annotation_id) → [(sample_name, row_dict)] so
    /mappings/search is O(1) instead of O(128 × tsv_rows).

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
                val = row.get(col)
                if not val:
                    continue
                ann_id = val.strip()
                _MAPPING_INDEX[source].setdefault(ann_id, []).append((sample_name, row))


# ── Search query ──────────────────────────────────────────────────────────────

def search_index(source: str, q: str) -> set[str]:
    """
    Return annotation_ids matching query q via binary-search prefix lookup.

    Complexity: O(log n + k) per token.  Multiple tokens are AND-ed so a
    query like "photosystem II" only returns annotations that contain both
    tokens.
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

        lo = bisect.bisect_left(keys, token)
        for key in keys[lo:]:
            if not key.startswith(token):
                break
            matched |= idx[key]

        result = matched if result is None else result & matched
        if not result:
            break

    return result or set()


# ── EGC vector access (used by correlation.py) ────────────────────────────────

def get_egc_vectors_from_matrix(
    source: AnnotationSource,
) -> tuple[dict[str, list[float | None]], dict[str, str | None], dict[str, str | None]]:
    """
    Return (egc_matrix, name_map, parent_map) for a source from the
    pre-built _EGC_MATRIX — O(1), no file I/O.

    Falls back to a file scan during startup warmup, serialised by a lock
    so concurrent requests don't race on the same I/O.
    """
    src = source.value
    if _EGC_MATRIX.get(src):
        return _EGC_MATRIX[src], _EGC_NAME_MAP[src], _EGC_PARENT_MAP[src]

    with _EGC_BUILD_LOCK:
        if _EGC_MATRIX.get(src):
            return _EGC_MATRIX[src], _EGC_NAME_MAP[src], _EGC_PARENT_MAP[src]
        vecs, names, parents = _build_egc_vectors_from_files(
            _EGC_SAMPLES or get_all_sample_names(), source
        )
        return vecs, names, parents


def _build_egc_vectors_from_files(
    samples_sorted: list[str],
    source: AnnotationSource,
) -> tuple[dict[str, list[float | None]], dict[str, str | None], dict[str, str | None]]:
    """Fallback: build EGC time vectors by scanning annotation files."""
    vectors:    dict[str, list[float | None]] = {}
    name_map:   dict[str, str | None]         = {}
    parent_map: dict[str, str | None]         = {}

    for sample_name in samples_sorted:
        data = load_annotations_by_source(sample_name, source)
        for ann_id, value in data.items():
            egc = extract_egc(value)
            if ann_id not in vectors:
                vectors[ann_id]    = []
                name_map[ann_id]   = extract_annotation_name(value)
                parent_map[ann_id] = extract_parent(value, source.value)
            vectors[ann_id].append(egc)

    return vectors, name_map, parent_map
