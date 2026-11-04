"""
routes.py
---------
All FastAPI endpoints except the correlation routes (in correlation_sql.py).

Endpoints
~~~~~~~~~
GET /status
GET /timepoints
GET /samples
GET /tides
GET /sun-times
GET /mappings/search
GET /search/annotations
GET /series/annotations
GET /taxonomy/children
GET /annotations/top
GET /annotations/scaffolds
GET /annotations/scaffolds/summary
GET /taxonomy/export
GET /series/export/summary
GET /series/export
GET /series/export/review
POST /series/export/summary
POST /series/export

All business logic (pagination, search, EGC extraction) lives here or in
cache.py / index.py — endpoints are intentionally thin.

Each route opens its own short-lived connect_to_sql() connection instead
of reusing the single connection main.py's lifespan stashes on
app.state.sql_conn (still opened there, but now only for the one-time
startup sample-order check). A single sqlite3.Connection shared across
every request/thread produced non-deterministic hangs and
sqlite3.InterfaceError: bad parameter or other API misuse under real
concurrent traffic in production (2026-09-25) -- confirmed via a live
py-spy stack dump (multiple threads permanently stuck mid-conn.execute())
and ruled out as a cache/RAM sizing issue by running the identical query
through an independent connection, which returned in under a second. This
mirrors the per-call connection pattern correlation_sql.py's _connect()
already used successfully.
"""

import csv
import io
import json
import re
import time
from collections import OrderedDict
from itertools import groupby
from operator import itemgetter

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .cache_sql import (
    _cog_node_depth,
    _enzyme_node_exists,
    _expand_to_leaf_ids,
    _kegg_node_depth,
    _MANY_LEAVES_THRESHOLD,
    _MAX_SAMPLES_FOR_MANY_LEAVES,
    _MAPPINGS_ROW_LIMIT,
    _ROW_VOLUME_THRESHOLD,
    count_taxa_under_sql,
    estimate_mapping_row_count_sql,
    count_annotation_scaffolds_sql,
    get_annotation_scaffolds_sql,
    get_annotation_series_sql,
    get_all_sample_names_sql,
    get_cog_children_sql,
    get_cog_path_sql,
    get_enzyme_children_sql,
    get_enzyme_path_sql,
    get_kegg_children_sql,
    get_cog_immediate_parents_bulk_sql,
    get_kegg_immediate_parents_bulk_sql,
    get_kegg_path_sql,
    get_taxonomy_children_sql,
    get_top_annotations_sql,
    taxon_exists_sql,
    get_mappings_sql,
    iter_mappings_sql,
    mapping_rows_per_sample_sql,
    samples_within_row_budget,
    get_search_annotations,
    get_top_annotations_from_catalog_sql,
    get_taxa_at_rank_sql,
    get_path_review_sql,
    get_paths_under_at_depth_sql,
    get_taxa_under_at_rank_sql,
    iter_series_for_ids_sql,
    strip_any_source_prefix,
    strip_source_prefix,
    RANK_COLUMNS
)

from .astronomy import SUN_TIMES
from .cache import (
    TIMEPOINTS,
    TIDES,
    AnnotationSource,
    get_timepoint,
)
from .db import connect_to_sql, close_sql_connection
from .config import (
    LOCATION_LAT,
    LOCATION_LON,
    LOCATION_NAME,
    TIDE_SHIFT_HOURS,
)
from . import index as index_module
from .index import (
    DATA_DATE_MIN,
    DATA_DATE_MAX,
    timepoint_sort_key,
    timepoint_dt_sort_key,
    is_within_date_range,
    _parse_any_datetime,
)

router = APIRouter()


# ── Pagination helpers ────────────────────────────────────────────────────────

# paginate() itself has no input guards -- page_size=0 divides by zero
# computing total_pages, and page<1 or page_size<1 produces a negative
# slice start, which Python silently reads as an index from the END of the
# list ("page -1" would return a real, wrong page). Every route that calls
# it declares page/page_size as Query(..., ge=1, le=...), so FastAPI
# rejects an out-of-range value with a 422 before paginate() ever runs.
def paginate(data: list, page: int, page_size: int) -> dict:
    """Generic pagination for any list."""
    total = len(data)
    start = (page - 1) * page_size
    return {
        "total":       total,
        "page":        page,
        "page_size":   page_size,
        "total_pages": -(-total // page_size),
        "data":        data[start : start + page_size],
    }


# ── Annotation search / normalisation helpers ─────────────────────────────────

# ── Top-annotations cache ─────────────────────────────────────────────────────

# Each entry keeps only the top _TOP_ANN_MAX_LIMIT rows (~50 KB; the full
# taxonomy ranking would be ~68,800 rows, tens of MB), and a server lifetime can
# accumulate one entry per (source, date_from, date_to) combination ever
# requested (unparseable dates are rejected before a key is built, see
# top_annotations_by_egc). This process also has no hook to learn that a
# catalog rebuild happened: unlike the SQL-table-backed correlations_cache,
# which the migration script invalidates directly, this cache lives in
# THIS process's memory. An LRU size cap (an OrderedDict, oldest-accessed evicted first) bounds
# memory; a TTL bounds how long a pre-rebuild result can keep being
# served -- 30 minutes is long enough that a user paging through results
# never pays for the same (source, date range) aggregation twice in one
# sitting, short enough that a catalog rebuild (a manual, infrequent
# operator action, not a hot path) is never stale for more than half an
# hour without anyone needing to restart the process.
_TOP_ANN_CACHE_MAX_ENTRIES = 64
_TOP_ANN_CACHE_TTL_SECONDS = 30 * 60
# The most rows /annotations/top can return (its `limit` cap) -- all an
# entry needs to keep, rather than the full ranking.
_TOP_ANN_MAX_LIMIT = 200

_TOP_ANN_CACHE_SQL: "OrderedDict[tuple, tuple[float, list]]" = OrderedDict()


def _top_ann_cache_get(key: tuple):
    """Return the cached (data, sample_count) for `key`, or None on a
    miss/expired entry. Touches the entry's LRU position on a hit."""
    entry = _TOP_ANN_CACHE_SQL.get(key)
    if entry is None:
        return None
    inserted_at, value = entry
    if time.time() - inserted_at > _TOP_ANN_CACHE_TTL_SECONDS:
        del _TOP_ANN_CACHE_SQL[key]
        return None
    _TOP_ANN_CACHE_SQL.move_to_end(key)
    return value


def _top_ann_cache_set(key: tuple, value) -> None:
    """Insert/update `key`, evicting the least-recently-used entry first
    if this would push the cache past its size cap."""
    _TOP_ANN_CACHE_SQL[key] = (time.time(), value)
    _TOP_ANN_CACHE_SQL.move_to_end(key)
    while len(_TOP_ANN_CACHE_SQL) > _TOP_ANN_CACHE_MAX_ENTRIES:
        _TOP_ANN_CACHE_SQL.popitem(last=False)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/status")
def api_status():
    """Returns index readiness and the data date range."""
    return {
        "index_ready": index_module._INDEX_READY,
        "date_min":    DATA_DATE_MIN,
        "date_max":    DATA_DATE_MAX,
    }

def _filter_timepoints_to_real_samples(timepoints: dict, real_samples) -> list[dict]:
    """Keep only TIMEPOINTS entries whose taxon_oid is an actual, processed
    sample.

    JGI_ID_Timepoints_128.csv (TIMEPOINTS' source) actually has 132 rows --
    4 real-looking taxon_oids with plausible dates in the sampling window
    that were never processed into mapping/annotation data (confirmed live:
    they're absent from both the raw mapping TSVs and the database's
    samples). Without this filter, /timepoints reports 132 while
    /samples reports 128 for the same dataset.
    """
    real_samples = set(real_samples)
    return [tp for taxon_oid, tp in timepoints.items() if taxon_oid in real_samples]


@router.get("/timepoints")
def list_timepoints(
    request: Request, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=1000),
):
    """Return all samples with their readable dates, paginated."""
    if not TIMEPOINTS:
        raise HTTPException(status_code=404, detail="Timepoints data not found")
    conn = connect_to_sql()
    try:
        real_samples = get_all_sample_names_sql(conn)
    finally:
        close_sql_connection(conn)
    rows = _filter_timepoints_to_real_samples(TIMEPOINTS, real_samples)
    return paginate(rows, page, page_size)


@router.get("/samples")
def list_samples(
    request: Request, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=1000),
):
    """Return all sample names with their readable dates, paginated."""
    conn = connect_to_sql()
    try:
        samples = get_all_sample_names_sql(conn)
    finally:
        close_sql_connection(conn)
    return paginate([{"sample": s, "timepoint": get_timepoint(s)} for s in samples], page, page_size)


@router.get("/tides")
def get_tides():
    """
    Return tide predictions (predicted water level, metres) at 6-minute
    resolution for the Rosario/Orcas Island station.

    Timestamps are pre-shifted by TIDE_SHIFT_HOURS so they align directly
    with /timepoints — no further conversion needed by callers.
    """
    if not TIDES:
        raise HTTPException(status_code=404, detail="Tide data not found")
    return {
        "station":          LOCATION_NAME,
        "shift_applied_hr": TIDE_SHIFT_HOURS,
        "unit":             "meters",
        "total":            len(TIDES),
        "data":             TIDES,
    }


@router.get("/sun-times")
def get_sun_times():
    """
    Return sunrise/sunset times for each date in the dataset's range,
    computed for Rosario/Orcas Island.  Times are in PDT (UTC-7) to match
    /timepoints — no further conversion needed by callers.
    """
    if not SUN_TIMES:
        raise HTTPException(status_code=404, detail="Sun times not available (no date range)")
    return {
        "location":  LOCATION_NAME,
        "lat":       LOCATION_LAT,
        "lon":       LOCATION_LON,
        "tz_offset": -7,
        "date_min":  DATA_DATE_MIN,
        "date_max":  DATA_DATE_MAX,
        "data":      SUN_TIMES,
    }


@router.get("/mappings/search")
def search_mappings(
    request:Request,
    annotation_id: str = Query(..., description="Annotation ID to search for"),
    source: AnnotationSource = Query(..., description="Source type: kegg, cog, enzyme, taxonomy"),
    sample_count: int = Query(128, ge=1, le=128),
    unique_pairs: bool = Query(False),
    bypass_cap: bool = Query(
        False,
        description="Skip the broad-category sample cap. For an explicit, "
                     "deliberate full export (e.g. CSV download) -- never "
                     "set by the default interactive search/browse path.",
    ),
    # le=50_000 matches _MAPPINGS_ROW_LIMIT -- the real ceiling
    # get_mappings_sql's own hard row limit already imposes, so a
    # legitimate bypass_cap=true full export can still request everything
    # in a single page without hitting an artificially lower cap here.
    page: int = Query(1, ge=1), page_size: int = Query(100, ge=1, le=50_000),
):
    """
    Search mappings for a given annotation ID and source.

    For kegg/enzyme/cog, annotation_id can be a pathway/class/category
    node, not just a leaf id -- it's expanded to every real leaf id
    beneath it (e.g. source=kegg, annotation_id=00910 returns every gene
    mapped to any KO under Nitrogen metabolism).

    Results are deduplicated (if unique_pairs), sorted chronologically,
    then paginated. sample_count is clamped to _MAX_SAMPLES_FOR_MANY_LEAVES
    regardless of what was requested when either: annotation_id resolves
    to more than _MANY_LEAVES_THRESHOLD real leaves (a broad category
    times all 128 samples can be millions of raw rows -- measured: a
    269-member COG category is 3,015,883 rows at 128 samples), or -- found
    live in production, 2026-09-25 -- a single common leaf id alone
    already matches more than _ROW_VOLUME_THRESHOLD rows (K02014 is one
    leaf but 271,284 rows at 128 samples, a 249.8s query). Either way,
    unless bypass_cap is set, for a caller that explicitly wants the
    full, uncapped export and is willing to wait. The response's
    sample_count always reflects what was actually used, not what was
    requested.

    Separately, results_were_truncated discloses a DIFFERENT failure
    mode: get_mappings_sql's hard _MAPPINGS_ROW_LIMIT (50,000 raw rows)
    can trigger even when sample_count was never capped at all -- found
    live in production, 2026-09-25, a single real leaf-level organism
    (leaf_count=1, not a broad category, so the caps above never fire)
    can itself have millions of rows across 128 samples (the single most
    abundant organism in this dataset has 2,235,509). That case first
    crashed the whole server via the kernel OOM killer before this limit
    existed; it's now a silent, safe truncation instead, disclosed here.
    """
    conn = connect_to_sql()
    try:
        samples = get_all_sample_names_sql(conn)
        if not samples:
            raise HTTPException(status_code=404, detail="No samples found")

        samples_sorted  = sorted(samples, key=timepoint_sort_key)
        allowed_samples = samples_sorted[:sample_count]

        # An id this source doesn't have (e.g. a COG id with source=kegg)
        # is "not found", as on /series/annotations -- not an empty result.
        if conn.execute(
            "SELECT 1 FROM annotation_catalog WHERE source = ? AND annotation_id = ? LIMIT 1",
            (source.value, strip_source_prefix(source.value, annotation_id)),
        ).fetchone() is None:
            raise HTTPException(
                status_code=404,
                detail=f"No {source.value} annotation {annotation_id!r}",
            )

        leaf_count = None
        samples_were_capped = False
        if source.value in ("kegg", "cog", "enzyme"):
            # Must strip the same KO:/EC: prefix get_mappings_sql strips
            # internally, or a prefixed id (a supported form) resolves to
            # zero leaves here -- every cap check below then sees nothing
            # to cap, and the uncapped query runs in full (a real
            # 271,284-row / 250s query, which this cap exists to prevent).
            leaf_ids = _expand_to_leaf_ids(conn, source.value, strip_source_prefix(source.value, annotation_id))
            leaf_count = len(leaf_ids)
            if leaf_count > _MANY_LEAVES_THRESHOLD and not bypass_cap:
                allowed_samples = allowed_samples[:_MAX_SAMPLES_FOR_MANY_LEAVES]
                samples_were_capped = True
            elif not bypass_cap:
                estimated_rows = estimate_mapping_row_count_sql(
                    conn, source.value, leaf_ids, allowed_samples
                )
                if estimated_rows > _ROW_VOLUME_THRESHOLD:
                    allowed_samples = allowed_samples[:_MAX_SAMPLES_FOR_MANY_LEAVES]
                    samples_were_capped = True
        elif source.value == "taxonomy":
            # Never capped at all until this fix (2026-09-25) -- a broad
            # node (e.g. a domain) went straight to the uncapped full
            # query. source=taxonomy, annotation_id=Bacteria touches
            # 59,780,871 of ~74M total mappings rows (81% of the entire
            # dataset) and hung indefinitely. count_taxa_under_sql is
            # taxonomy's leaf_count analog (real leaf taxa at or under
            # this lineage prefix, via the much smaller taxon_paths
            # table -- see its docstring for why the row-volume-estimate
            # approach used for kegg/cog/enzyme doesn't work here).
            leaf_count = count_taxa_under_sql(conn, annotation_id)
            if leaf_count > _MANY_LEAVES_THRESHOLD and not bypass_cap:
                allowed_samples = allowed_samples[:_MAX_SAMPLES_FOR_MANY_LEAVES]
                samples_were_capped = True

        # Fit whole samples, in time order, within the hard row limit --
        # otherwise an abundant node (e.g. a single common organism, which
        # no leaf-count cap catches) hits get_mappings_sql's LIMIT partway
        # through an unordered scan and returns an arbitrary partial subset
        # while still reporting every requested sample.
        if not bypass_cap:
            budgeted = samples_within_row_budget(
                conn, source.value, strip_source_prefix(source.value, annotation_id),
                allowed_samples, _MAPPINGS_ROW_LIMIT,
            )
            if len(budgeted) < len(allowed_samples):
                allowed_samples = budgeted
                samples_were_capped = True

        seen_keys: set[str] = set()

        mappings = get_mappings_sql(
            conn, source.value, annotation_id, samples=allowed_samples, bypass_cap=bypass_cap,
        )
        # A DIFFERENT failure mode from samples_were_capped, disclosed
        # separately: get_mappings_sql's hard _MAPPINGS_ROW_LIMIT can
        # truncate raw results even when the sample-count cap above never
        # triggered at all -- found live in production, 2026-09-25, a
        # single real leaf-level organism (leaf_count=1, not a broad
        # category) has 2,235,509 rows across all 128 samples on its
        # own. len(mappings) is a reliable proxy for "the raw subquery hit
        # the limit" for all four sources: mappings.id is the table's
        # primary key, so kegg/taxonomy's per-row subqueries can never
        # produce duplicates the later GROUP BY would collapse, and
        # cog/enzyme's junction-table subqueries now select DISTINCT
        # mapping ids -- a bare SELECT would let a gene matching more than
        # one of several searched leaf ids produce duplicate ids inside the
        # LIMIT, so the post-GROUP-BY count could land under
        # _MAPPINGS_ROW_LIMIT even though real data was dropped (e.g.
        # cog/H over 5 samples: 100,275 real genes, only 49,969 returned).
        results_were_truncated = len(mappings) >= _MAPPINGS_ROW_LIMIT
    finally:
        close_sql_connection(conn)

    for row in mappings:
        row['timepoint'] = get_timepoint(row['sample'])
    # Chronological (then sample, gene) before de-duplicating, so "unique
    # pairs" keeps each pair's earliest occurrence, the same every time.
    mappings.sort(key=lambda r: (
        timepoint_dt_sort_key((r.get("timepoint") or {}).get("datetime")),
        r.get("sample") or "", r.get("gene_id") or "",
    ))
    results = []
    for row in mappings:
        if unique_pairs:
            key = f"{row['taxonomy']}|{row['kegg_id']}|{row['enzyme']}|{row['cog_id']}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            results.append(row)
        else:
            results.append(row)

    results.sort(key=lambda r: timepoint_dt_sort_key((r.get("timepoint") or {}).get("datetime")))
    return {
        "annotation_id":       annotation_id,
        "source":              source.value,
        "sample_count":            len(allowed_samples),
        "samples_were_capped":     samples_were_capped,
        "results_were_truncated":  results_were_truncated,
        "leaf_count":              leaf_count,
        **paginate(results, page, page_size),
    }


# ── Mappings export ("Export all" in the Mappings panel) ─────────────────────

# Above this many gene records the export is refused rather than started:
# it covers every single organism and pathway, but not a whole domain or a
# top-level KEGG/COG class (tens of millions of rows, many GB).
_MAPPINGS_EXPORT_MAX_ROWS = 5_000_000

_MAPPINGS_EXPORT_HEADER = [
    "annotation_id", "source", "sample", "date", "time", "gene_id", "scaffold_id",
    "taxonomy", "kegg_id", "enzyme", "cog_id",
]


def _mappings_export_plan(
    db, source: AnnotationSource, annotation_id: str, date_from: str | None, date_to: str | None,
) -> dict:
    """Check an export request and work out its size: the samples in the
    date range (in date order, with ISO dates), each one's row count, and
    the total. Raises HTTPException for a bad request."""
    for label, value in (("date_from", date_from), ("date_to", date_to)):
        if value is not None and _parse_any_datetime(value) is None:
            raise HTTPException(status_code=400, detail=f"{label} is not a recognized date: {value!r}")
    bare_id = strip_source_prefix(source.value, annotation_id)
    if db.execute(
        "SELECT 1 FROM annotation_catalog WHERE source = ? AND annotation_id = ? LIMIT 1",
        (source.value, bare_id),
    ).fetchone() is None:
        raise HTTPException(status_code=404, detail=f"No {source.value} annotation {annotation_id!r}")
    rows_per_sample = mapping_rows_per_sample_sql(db, source.value, bare_id)
    samples = _export_samples(db, date_from, date_to)
    return {
        "samples":         samples,
        "rows_per_sample": rows_per_sample,
        "rows":            sum(rows_per_sample.get(sample, 0) for sample, _ in samples),
    }


def _mappings_export_csv(db, source: str, annotation_id: str, plan: dict, unique_pairs: bool):
    """Yield the CSV sample by sample, in date order, genes in the order
    they were loaded (gene id order) within a sample. Rows go out every
    _EXPORT_CHUNK_ROWS as they are read, and the header goes out first, so
    the proxy never waits long for data even on a slow disk. Closes `db`
    when done (or when the download is abandoned)."""
    try:
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\n")
        writer.writerow(_MAPPINGS_EXPORT_HEADER)
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        pending = 0
        seen_keys: set[tuple] = set()
        for sample, iso_date in plan["samples"]:
            if not plan["rows_per_sample"].get(sample):
                continue
            date, _, time_of_day = iso_date.partition(" ")
            for r in iter_mappings_sql(db, source, annotation_id, samples=[sample], bypass_cap=True, row_limit=None):
                if unique_pairs:
                    # Samples arrive in date order, so the first row of each
                    # combination kept is its earliest, as in /mappings/search.
                    key = (r["taxonomy"], r["kegg_id"], r["enzyme"], r["cog_id"])
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                writer.writerow([
                    annotation_id, source, sample, date, time_of_day, r["gene_id"], r["contig_id"],
                    r["taxonomy"] or "", r["kegg_id"] or "", r["enzyme"] or "", r["cog_id"] or "",
                ])
                pending += 1
                if pending >= _EXPORT_CHUNK_ROWS:
                    yield buf.getvalue()
                    buf.seek(0)
                    buf.truncate(0)
                    pending = 0
        yield buf.getvalue()
    finally:
        close_sql_connection(db)


@router.get("/mappings/export/summary")
def mappings_export_summary(
    request:       Request,
    annotation_id: str = Query(...),
    source:        AnnotationSource = Query(...),
    date_from:     str | None = Query(None),
    date_to:       str | None = Query(None),
):
    """Size of a /mappings/export before downloading it: how many samples
    the date range covers and how many gene records (rows) the file will
    hold. "Unique pairs only" can make the file smaller than `rows`, never
    larger. `max_rows` is the largest export the server will start."""
    db = connect_to_sql()
    try:
        plan = _mappings_export_plan(db, source, annotation_id, date_from, date_to)
    finally:
        close_sql_connection(db)
    return {
        "annotation_id": annotation_id,
        "source":        source.value,
        "samples":       len(plan["samples"]),
        "rows":          plan["rows"],
        "max_rows":      _MAPPINGS_EXPORT_MAX_ROWS,
    }


@router.get("/mappings/export")
def mappings_export(
    request:       Request,
    annotation_id: str = Query(...),
    source:        AnnotationSource = Query(...),
    date_from:     str | None = Query(None),
    date_to:       str | None = Query(None),
    unique_pairs:  bool = Query(False),
):
    """CSV of every gene record for an annotation (a node includes every
    gene under it) in the date range, all samples if no range is given:
    one row per gene per sample, with its gene id, scaffold and
    annotations in all four sources. Not limited to 50,000 rows like
    /mappings/search; instead an export over _MAPPINGS_EXPORT_MAX_ROWS is
    refused with 413 before anything is sent. Streamed one sample at a
    time, so a large file never has to be held in memory."""
    db = connect_to_sql()
    try:
        plan = _mappings_export_plan(db, source, annotation_id, date_from, date_to)
        if plan["rows"] > _MAPPINGS_EXPORT_MAX_ROWS:
            raise HTTPException(
                status_code=413,
                detail=f"This export would be {plan['rows']:,} rows, over the "
                       f"{_MAPPINGS_EXPORT_MAX_ROWS:,}-row limit. Narrow the date range, "
                       f"or use Bulk Download for per-sample totals.",
            )
    except Exception:
        close_sql_connection(db)
        raise
    parts = [annotation_id, "mappings"]
    if date_from or date_to:
        parts.append(f"{date_from or 'start'}_to_{date_to or 'end'}")
    filename = re.sub(r"[^A-Za-z0-9._-]+", "_", "_".join(parts)) + ".csv"
    return StreamingResponse(
        _mappings_export_csv(db, source.value, annotation_id, plan, unique_pairs),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


_MATCH_TIERS = {"exact": 0, "starts": 1, "contains": 2}


def _search_match(row: dict, text: str) -> str:
    """How closely a search result matches the typed text: "exact" (the id
    or name is the text, or for a KEGG ortholog one of the gene symbols
    before the ';' in its name, e.g. "psbA"), "starts" (the id or name
    starts with it) or "contains". Case-insensitive. A taxonomy id is the
    whole lineage, so only the taxon's own name counts there."""
    text = text.lower()
    name = (row.get("name") or "").lower()
    ids = [] if row["source"] == "taxonomy" else [row["annotation_id"].lower()]
    symbols = [s.strip() for s in name.split(";", 1)[0].split(",")] if row["source"] == "kegg" and ";" in name else []
    if text in ids or text == name or text in symbols:
        return "exact"
    if any(i.startswith(text) for i in ids) or name.startswith(text):
        return "starts"
    return "contains"


@router.get("/search/annotations")
def search_annotations(
    request:Request,
    q:             str | None = Query(None, min_length=1),
    annotation_id: str | None = Query(None),
    name_exact:    str | None = Query(None),
    # Typed as the real enum so FastAPI rejects an unknown source name with
    # a 422 -- as plain strings, "bogus" would silently match nothing and
    # come back 200/total:0, indistinguishable from "no results".
    sources: list[AnnotationSource] = Query(...),
    # le=5000: AnalyzePage fetches every match for a term in one call
    # (page_size=5000), and real broad terms exceed 2000 ("protein" matches
    # 6,117). tests/test_frontend_page_size_contract.py pins this pairing.
    page: int = Query(1, ge=1), page_size: int = Query(500, ge=1, le=5000),
):
    """
    Search across all samples for one or more annotation sources.

    Substring match (LIKE) on id or name; a leading KO:/EC: is ignored.
    Each row's `match` says how close it is (exact, starts, contains);
    rows are ordered closest first, by mean_egc within each group. A `q`
    shorter than 3 characters is an exact, case-insensitive ID lookup
    instead (COG letters, EC classes).
    """
    if not q and not annotation_id and not name_exact:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one of: q, annotation_id, or name_exact",
        )
    # A 1-2 character q would substring-match nearly everything, so it is an
    # exact, case-insensitive ID lookup instead of a substring search. The
    # only real IDs that short are the 25 COG category letters and the 7 EC
    # classes ("E", "3"), which used to be unsearchable here (a 400) from
    # every search box in the app.
    if q is not None and not q.strip():
        raise HTTPException(status_code=400, detail="Search text is blank.")
    # Ids are stored bare, but are often written "KO:K00001" / "EC:1.1.1.1"
    # (KEGG, papers, the Methods page); either form finds the same rows.
    search_q = strip_any_source_prefix(q.strip()) if q is not None else None
    search_id = strip_any_source_prefix(annotation_id) if annotation_id else annotation_id
    if search_q is not None and len(search_q) < 3 and not annotation_id:
        search_q, search_id = None, search_q.upper()
    source_values = [s.value for s in sources]
    db = connect_to_sql()
    try:
        results = get_search_annotations(db, source_values, search_q, search_id, name_exact)
    finally:
        close_sql_connection(db)
    for row in results:
        row["match"] = _search_match(row, search_q) if search_q is not None else "exact"
    # Closest matches first, most abundant first within each group, before
    # paginating, so a short page (Lookup shows 25) always holds them.
    results.sort(key=lambda r: (_MATCH_TIERS[r["match"]], -(r.get("mean_egc") or 0)))
    return {
        "query":         q,
        "annotation_id": annotation_id,
        "name_exact":    name_exact,
        "sources":       source_values,
        "total":         len(results),
        **paginate(results, page, page_size),
    }


@router.get("/series/annotations")
def annotation_time_series(
    request: Request,
    source:        AnnotationSource = Query(...),
    annotation_id: str = Query(...),
    page: int = Query(1, ge=1), page_size: int = Query(100, ge=1, le=500),
):
    """Return EGC and norm_egc for one annotation across all samples,
    sorted chronologically."""
    results: list[dict] = []

    conn = connect_to_sql()
    try:
        # Accepts kegg's "KO:" / enzyme's "EC:" prefix, as mappings does.
        rows = get_annotation_series_sql(conn, source.value, strip_source_prefix(source.value, annotation_id))
    finally:
        close_sql_connection(conn)
    for row in rows:
        value_out = {
            "name":     row.get("name"),
            "category": row.get("category"),
            "egc":      row.get("egc"),
            "norm_egc": row.get("norm_egc"),
        }
        results.append({
            "source":        source.value,
            "sample":        row["sample_name"],
            "timepoint":     get_timepoint(row["sample_name"]),
            "annotation_id": annotation_id,
            "name":          row.get("name"),
            "egc":           row.get("egc"),
            "norm_egc":      row.get("norm_egc"),
            "value":         value_out,
        })

    if not results:
        raise HTTPException(
            status_code=404,
            detail=f"No annotation '{annotation_id}' found for source '{source.value}' across samples",
        )

    results.sort(
        key=lambda item: timepoint_dt_sort_key((item.get("timepoint") or {}).get("datetime"))
    )
    return {"source": source.value, "annotation_id": annotation_id, **paginate(results, page, page_size)}


@router.get("/taxonomy/children")
def taxonomy_children(request: Request, parent: str | None = Query(None)):
    """
    Direct children of a taxon (structure only — no egc values), for lazily
    populating an expandable tree without shipping the full ~38k-taxon index.

    parent omitted/empty -> the 4 domain roots (value['parent'] is None).
    """
    # An explicitly empty `parent=` query value arrives here as "" (a real
    # string), not None -- FastAPI only supplies the None default when the
    # param is omitted entirely. Left as "", it would be matched as a
    # lineage prefix that matches nothing, returning 0 children instead of
    # the 4 domain roots. Normalizing here makes "" behave exactly like
    # omission for every check and lookup below (same in the other three
    # hierarchy routes).
    parent = parent or None
    db = connect_to_sql()
    try:
        if parent is not None and not taxon_exists_sql(db, parent):
            raise HTTPException(status_code=404, detail=f"Unknown taxon '{parent}'")
        children = get_taxonomy_children_sql(db, parent)
    finally:
        close_sql_connection(db)
    return {'parent': parent, 'count': len(children), 'data': children}


@router.get("/kegg/children")
def kegg_children(request: Request, parent: str | None = Query(None)):
    """
    Direct children of a KEGG node (structure only — no egc values), for
    the BRITE hierarchy popup.

    parent omitted/empty -> the 8 top-level branches (Metabolism, Human
    Diseases, Brite Hierarchies, etc.).

    Read from `kegg_paths` (built from ko00001.keg, capturing every real
    multi-parent occurrence — see migrate_kegg_paths_to_sql.py).
    """
    # An explicitly empty `parent=` arrives as "", not None -- treat it as
    # omission (see taxonomy_children), not as an unknown node to 404 on.
    parent = parent or None
    db = connect_to_sql()
    try:
        if parent is not None and _kegg_node_depth(db, parent) is None:
            raise HTTPException(status_code=404, detail=f"Unknown KEGG node '{parent}'")

        children = get_kegg_children_sql(db, parent)
    finally:
        close_sql_connection(db)
    return {'parent': parent, 'count': len(children), 'data': children}


@router.get("/kegg/path")
def kegg_path(request: Request, id: str = Query(...)):
    """
    Ancestor path (root to node) for a KEGG node, for auto-expanding and
    highlighting a node in the hierarchy popup when opened from a chart
    for one specific annotation.
    """

    db = connect_to_sql()
    try:
        result = get_kegg_path_sql(db, id)
    finally:
        close_sql_connection(db)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown KEGG node '{id}'")
    return result


@router.get("/kegg/parents")
def kegg_parents_bulk(request: Request, ids: str = Query(...)):
    """
    Every real IMMEDIATE parent (one level up) for each of a comma-separated
    list of KEGG node ids, in one request. "Annotations by Parent" groups up to 200 rows at once, and a KO's
    stored `parent` is last-occurrence-wins (only one of its possibly-many
    real parents), so the panel needs every real parent for every row to
    bucket a multi-parent KO into every group it actually belongs to --
    one /kegg/path call per row would be 200 round trips; this is one.
    """
    id_list = [i for i in ids.split(",") if i]
    db = connect_to_sql()
    try:
        result = get_kegg_immediate_parents_bulk_sql(db, id_list)
    finally:
        close_sql_connection(db)
    return {"parents": result}


@router.get("/cog/parents")
def cog_parents_bulk(request: Request, ids: str = Query(...)):
    """
    Every real category for each of a comma-separated list of COG ids, in
    one request -- the COG counterpart of /kegg/parents. A COG id's stored
    `parent` holds only one of its categories, so Explore needs every real
    category to file a multi-category COG under each one it belongs to.
    """
    id_list = [i for i in ids.split(",") if i]
    db = connect_to_sql()
    try:
        result = get_cog_immediate_parents_bulk_sql(db, id_list)
    finally:
        close_sql_connection(db)
    return {"parents": result}


@router.get("/enzyme/children")
def enzyme_children(request: Request, parent: str | None = Query(None)):
    """
    Direct children of an Enzyme (EC) node (structure only — no egc
    values), for the same BRITE-hierarchy-popup feature as /kegg/children.

    parent omitted/empty -> the 7 top-level EC classes (Oxidoreductases,
    Transferases, etc.).

    Read from enzyme_paths (see migrate_enzyme_paths_to_sql.py). Unlike KEGG, every EC id has exactly one real parent (see
    get_enzyme_children_sql's docstring), so this exists purely for
    consistent tree-browsing UI, not to work around a multi-parent bug.
    """
    # An explicitly empty `parent=` arrives as "" -- treat it as omission
    # (see taxonomy_children).
    parent = parent or None
    db = connect_to_sql()
    try:
        if parent is not None and not _enzyme_node_exists(db, parent):
            raise HTTPException(status_code=404, detail=f"Unknown Enzyme node '{parent}'")

        children = get_enzyme_children_sql(db, parent)
    finally:
        close_sql_connection(db)
    return {'parent': parent, 'count': len(children), 'data': children}


@router.get("/enzyme/path")
def enzyme_path(request: Request, id: str = Query(...)):
    """
    Ancestor path (root to node) for an Enzyme (EC) node, for auto-
    expanding and highlighting a node in the hierarchy popup when opened
    from a chart for one specific annotation.
    """

    db = connect_to_sql()
    try:
        result = get_enzyme_path_sql(db, id)
    finally:
        close_sql_connection(db)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown Enzyme node '{id}'")
    return result


@router.get("/cog/children")
def cog_children(request: Request, parent: str | None = Query(None)):
    """
    Direct children of a COG node (structure only — no egc values), for
    the same BRITE-hierarchy-popup feature as /kegg/children.

    parent omitted/empty -> the 25 top-level category letters (Energy
    production and conversion, etc.) -- 25 in the real db, not 26.

    Read from cog_paths (see migrate_cog_paths_to_sql.py). A COG id can
    belong to more than one category, same as KEGG -- cog_paths has one row
    per real (category, COG) membership. The hierarchy is only 2 levels deep
    (category -> specific COG id), not 4.
    """
    # An explicitly empty `parent=` arrives as "" -- treat it as omission
    # (see taxonomy_children).
    parent = parent or None
    db = connect_to_sql()
    try:
        if parent is not None and _cog_node_depth(db, parent) is None:
            raise HTTPException(status_code=404, detail=f"Unknown COG node '{parent}'")

        children = get_cog_children_sql(db, parent)
    finally:
        close_sql_connection(db)
    return {'parent': parent, 'count': len(children), 'data': children}


@router.get("/cog/path")
def cog_path(request: Request, id: str = Query(...)):
    """
    Ancestor path (root to node) for a COG node, for auto-expanding and
    highlighting a node in the hierarchy popup when opened from a chart
    for one specific annotation.
    """

    db = connect_to_sql()
    try:
        result = get_cog_path_sql(db, id)
    finally:
        close_sql_connection(db)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown COG node '{id}'")
    return result


@router.get("/annotations/top")
def top_annotations_by_egc(
    request:   Request,
    source:    AnnotationSource = Query(...),
    limit:     int = Query(25, ge=1, le=_TOP_ANN_MAX_LIMIT),
    date_from: str | None = Query(None),
    date_to:   str | None = Query(None),
    ids:       list[str] | None = Query(None, max_length=_TOP_ANN_MAX_LIMIT),
):
    """
    Return the top N annotations by mean EGC, optionally filtered by date range.
    Each result includes mean_egc, max_egc, mean_norm_egc, max_norm_egc.

    `ids` (repeatable) returns just those annotations instead, worked out
    the same way and over the same dates as the top list, so a page can
    show a category's own total next to the members it listed. Not cached.

    Cached per (source, date_from, date_to). date_from/date_to, if given,
    must parse as a real date (see _parse_any_datetime) -- a bound that
    doesn't parse is rejected with 400 rather than silently ignored --
    ignoring it would fall through to the FULL unfiltered dataset while
    still echoing the bound back as if it had been applied (e.g. a
    US-format "06/10/2021" or a typo'd "2021-13-99").
    """
    # Validate before anything else -- a bad bound must never reach the
    # cache key (each distinct junk string would mint a fresh multi-MB
    # cache entry) or the per-sample scan below.
    if date_from is not None and _parse_any_datetime(date_from) is None:
        raise HTTPException(status_code=400, detail=f"date_from is not a recognized date: {date_from!r}")
    if date_to is not None and _parse_any_datetime(date_to) is None:
        raise HTTPException(status_code=400, detail=f"date_to is not a recognized date: {date_to!r}")

    db = connect_to_sql()
    try:
        samples = get_all_sample_names_sql(db)
        if not samples:
            raise HTTPException(status_code=404, detail="No samples found")

        # Keyed by the parsed dates, so one date written two ways (e.g.
        # "2021-05-20" and "2021-05-20T00:00:00") shares an entry.
        cache_key = (
            source.value,
            _parse_any_datetime(date_from).isoformat() if date_from else "",
            _parse_any_datetime(date_to).isoformat() if date_to else "",
        )

        if ids:
            if not date_from and not date_to:
                rows, n = get_top_annotations_from_catalog_sql(db, source.value, ids), len(samples)
            else:
                active_samples = [
                    s for s in samples
                    if is_within_date_range((get_timepoint(s) or {}).get("datetime"), date_from, date_to)
                ]
                rows = get_top_annotations_sql(db, source.value, active_samples, ids) if active_samples else []
                n = len(active_samples)
            return {"source": source.value, "sample_count": n, "date_from": date_from, "date_to": date_to, "data": rows}

        cached_entry = _top_ann_cache_get(cache_key)
        if cached_entry is None:
            if not date_from and not date_to:
                # Unfiltered requests are the common case -- go straight to the
                # precomputed annotation_catalog table instead of the per-sample
                # timepoint scan below, which exists only to resolve date-range
                # filters and would otherwise run needlessly on every request.
                cached_entry = (get_top_annotations_from_catalog_sql(db, source.value)[:_TOP_ANN_MAX_LIMIT], len(samples))
            else:
                active_samples = [
                    s for s in samples
                    if is_within_date_range((get_timepoint(s) or {}).get("datetime"), date_from, date_to)
                ]
                cached_entry = (
                    (get_top_annotations_sql(db, source.value, active_samples)[:_TOP_ANN_MAX_LIMIT], len(active_samples))
                    if active_samples else ([], 0)
                )
            _top_ann_cache_set(cache_key, cached_entry)
    finally:
        close_sql_connection(db)

    cached, filtered_sample_count = cached_entry
    return {
        "source":       source.value,
        "sample_count": filtered_sample_count,
        "date_from":    date_from,
        "date_to":      date_to,
        "data":         cached[:limit],
    }


@router.get("/annotations/scaffolds")
def annotation_scaffolds(
    request:       Request,
    source:        AnnotationSource = Query(...),
    annotation_id: str = Query(...),
    sample:        str = Query(..., description="The sample to list this annotation's scaffolds for"),
    page:          int = Query(1, ge=1),
    page_size:     int = Query(500, ge=1, le=5000),
):
    """
    Return the scaffolds associated with an annotation in one sample, paginated.

    `sample` is required: across all 128 samples a high-level node has
    tens of millions of scaffold rows (31M for taxonomy "Bacteria").
    Paging is done in SQL, so a request only ever reads `page_size` rows.

    Returns { annotation_id, source, sample, total, page, page_size, data }
    where data is [{ sample, date, scaffold, count }].
    """
    conn = connect_to_sql()
    try:
        total = count_annotation_scaffolds_sql(conn, source.value, annotation_id, sample)
        scaffolds = get_annotation_scaffolds_sql(
            conn, source.value, annotation_id, sample,
            limit=page_size, offset=(page - 1) * page_size,
        )
    finally:
        close_sql_connection(conn)

    if total == 0:
        raise HTTPException(
            status_code=404,
            detail=f"No scaffolds found for '{annotation_id}' in source '{source.value}' sample '{sample}'",
        )

    dt = (get_timepoint(sample) or {}).get('datetime', '')
    return {
        "annotation_id": annotation_id,
        "source":        source.value,
        "sample":        sample,
        "total":         total,
        "page":          page,
        "page_size":     page_size,
        "data":          [
            {"sample": s["sample_name"], "date": dt, "scaffold": s["scaffold_id"], "count": s["gene_count"]}
            for s in scaffolds
        ],
    }


@router.get("/annotations/scaffolds/summary")
def annotation_scaffolds_summary(
    request:       Request,
    source:        AnnotationSource = Query(...),
    annotation_id: str = Query(...),
):
    """
    Return per-sample scaffold summary for one annotation.

    Each row: { sample, date, scaffold_count, gene_count }
    scaffold_count = unique scaffolds in that sample
    gene_count     = sum of all scaffold hit counts

    """
    conn = connect_to_sql()
    try:
        docs = get_annotation_series_sql(conn, source.value, annotation_id)
    finally:
        close_sql_connection(conn)
    rows: list[dict] = []
    for doc in docs:
        if not doc.get("scaffold_count"):
             continue
        dt = (get_timepoint(doc["sample_name"]) or {}).get("datetime", "")
        rows.append({
             "sample":         doc["sample_name"],
             "date":           dt,
             "scaffold_count": doc["scaffold_count"],
             "gene_count":     doc["gene_count"],
        })
    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No scaffolds found for '{annotation_id}' in source '{source.value}'",
        )
    rows.sort(key=lambda r: timepoint_dt_sort_key(r["date"]) if r["date"] else -1.0)
    return {"annotation_id": annotation_id, "source": source.value, "total": len(rows), "data": rows}


def _taxonomy_rank_depth(rank: str) -> int | None:
    """Depth (1=domain..8=strain) for a rank name like "family", or None
    if it isn't one."""
    for d, column in RANK_COLUMNS.items():
        # strip('"') undoes "order"'s SQL-reserved-word quoting;
        # rstrip('_') undoes class_'s Python-keyword-avoidance suffix
        if column.strip('"').rstrip('_') == rank:
            return d
    return None


@router.get("/taxonomy/export")
def taxonomy_rank_export(request: Request, rank: str):
    """Return every lineage at the given taxonomic rank (e.g. "genus",
    "order") as {"taxon", "lineage"}; same-named taxa in different lineages
    are listed separately."""
    depth = _taxonomy_rank_depth(rank)
    if depth is None:
        raise HTTPException(status_code=400, detail=f"Rank '{rank}' not found")
    db = connect_to_sql()
    try:
        rows = get_taxa_at_rank_sql(db, depth)
    finally:
        close_sql_connection(db)
    return rows


# ── Bulk time-series download ─────────────────────────────────────────────────

# Above this many rows (Excel's row limit, minus the header) the CSV lists
# only the samples each term was detected in, instead of also writing an
# explicit 0 row for every sample it wasn't.
_EXPORT_DENSE_ROW_LIMIT = 1_048_575

# Rows written before each chunk is handed to the response.
_EXPORT_CHUNK_ROWS = 5000

_EXPORT_HEADER = ["taxon", "rank", "lineage", "sample", "date", "egc", "norm_egc", "detected"]

# kegg/cog/enzyme files carry ids and names separately, with lineages
# joined by " > " (KEGG names themselves contain ";").
_EXPORT_PATHS_HEADER = [
    "annotation_id", "name", "level", "lineage_ids", "lineage", "also_in_other_paths", "is_starting_term",
    "sample", "date", "egc", "norm_egc", "detected",
]
_LINEAGE_SEP = " > "

# Level names /series/export accepts per source, mapped to depth. Sources
# not listed here (besides taxonomy) aren't available for bulk download yet.
_EXPORT_LEVELS = {
    "enzyme": {"class": 1, "subclass": 2, "subsubclass": 3, "ec": 4},
    "kegg":   {"category": 1, "subcategory": 2, "pathway": 3, "ko": 4},
    "cog":    {"category": 1, "cog": 2},
}


def _taxonomy_rank_name(depth: int) -> str:
    return RANK_COLUMNS[depth].strip('"').rstrip('_')


def _export_samples(db, date_from: str | None, date_to: str | None) -> list[tuple[str, str]]:
    """(sample, ISO date) pairs in date order, limited to the date range."""
    samples = []
    for sample in sorted(get_all_sample_names_sql(db), key=timepoint_sort_key):
        dt = (get_timepoint(sample) or {}).get("datetime")
        if (date_from or date_to) and not is_within_date_range(dt, date_from, date_to):
            continue
        parsed = _parse_any_datetime(dt) if dt else None
        samples.append((sample, parsed.strftime("%Y-%m-%d %H:%M") if parsed else ""))
    return samples


def _taxonomy_export_entries(db, parent: str | None, rank: str, include_parent: bool):
    depth = _taxonomy_rank_depth(rank)
    if depth is None:
        raise HTTPException(status_code=400, detail=f"Rank '{rank}' not found")
    if parent is not None:
        if not taxon_exists_sql(db, parent):
            raise HTTPException(status_code=404, detail=f"Unknown taxon '{parent}'")
        if depth <= len(parent.split(";")):
            raise HTTPException(status_code=400, detail=f"Rank '{rank}' is not below '{parent}'")

    entries = [
        {"annotation_id": t["annotation_id"], "labels": [t["name"], rank, t["annotation_id"]]}
        for t in get_taxa_under_at_rank_sql(db, parent, depth)
    ]
    start = None
    if include_parent and parent is not None:
        parent_rank = _taxonomy_rank_name(len(parent.split(";")))
        start = {"annotation_id": parent, "labels": [parent.rsplit(";", 1)[-1], parent_rank, parent]}
    return _EXPORT_HEADER, entries, start, 0


def _paths_parent_depth(db, source: str, parent: str) -> int | None:
    """Level of a kegg/cog/enzyme term, or None if it isn't a real one."""
    if source == "enzyme":
        return len(parent.split(".")) if _enzyme_node_exists(db, parent) else None
    if source == "kegg":
        return _kegg_node_depth(db, parent)
    if source == "cog":
        return _cog_node_depth(db, parent)
    return None


def _paths_levels(db, source: str, parent: str | None, rank: str) -> tuple[int, int]:
    """(depth of `rank`, depth of `parent` or 0) for a kegg/cog/enzyme
    request, or HTTPException if either isn't valid."""
    depth = _EXPORT_LEVELS[source].get(rank)
    if depth is None:
        raise HTTPException(status_code=400, detail=f"Level '{rank}' not found for {source}")
    parent_depth = 0
    if parent is not None:
        parent_depth = _paths_parent_depth(db, source, parent)
        if parent_depth is None:
            raise HTTPException(status_code=404, detail=f"Unknown {source} term '{parent}'")
        if depth <= parent_depth:
            raise HTTPException(status_code=400, detail=f"Level '{rank}' is not below '{parent}'")
    return depth, parent_depth


def _kegg_level3_name(name: str | None) -> str:
    """The level column for a KEGG third-level entry. KEGG's file also puts
    its Brite protein-family tables ([BR:...], e.g. Transporters) and its
    "Not Included in Pathway or Brite" bins at the pathway level, so only a
    [PATH:...] entry is called a pathway; the frontend labels them the same
    way (stats.ts keggLevel3Label)."""
    name = name or ""
    if "[PATH:" in name:
        return "pathway"
    if "[BR:" in name:
        return "brite_table"
    return "kegg_group"


def _paths_export_entries(
    db, source: str, parent: str | None, rank: str, include_parent: bool, exclude: set[tuple[str, str]],
):
    levels = _EXPORT_LEVELS[source]
    depth, parent_depth = _paths_levels(db, source, parent, rank)

    level_names = {d: name for name, d in levels.items()}

    def labels(path: dict, level: str, repeated: bool, is_start: bool) -> list:
        if source == "kegg" and level == "pathway":
            level = _kegg_level3_name(path["name"])
        return [
            path["annotation_id"], path["name"], level,
            _LINEAGE_SEP.join(path["lineage_ids"]), _LINEAGE_SEP.join(path["lineage_names"]),
            "true" if repeated else "false", "true" if is_start else "false",
        ]

    paths = get_paths_under_at_depth_sql(db, source, parent, parent_depth, depth)
    path_counts: dict[str, int] = {}
    for path in paths:
        path_counts[path["annotation_id"]] = path_counts.get(path["annotation_id"], 0) + 1
    multi_path_terms = sum(1 for n in path_counts.values() if n > 1)
    # The user's unticked paths: (term, the path's immediate parent) pairs.
    if exclude and depth > 1:
        paths = [p for p in paths if (p["annotation_id"], p["lineage_ids"][-2]) not in exclude]
        path_counts = {}
        for path in paths:
            path_counts[path["annotation_id"]] = path_counts.get(path["annotation_id"], 0) + 1
    entries = [
        {"annotation_id": p["annotation_id"], "labels": labels(p, rank, path_counts[p["annotation_id"]] > 1, False)}
        for p in paths
    ]

    start = None
    if include_parent and parent is not None:
        parent_path = next(
            p for p in get_paths_under_at_depth_sql(db, source, None, 0, parent_depth) if p["annotation_id"] == parent
        )
        start = {"annotation_id": parent, "labels": labels(parent_path, level_names[parent_depth], False, True)}
    return _EXPORT_PATHS_HEADER, entries, start, multi_path_terms


def _series_export_plan(
    db, source: AnnotationSource, parent: str | None, rank: str,
    date_from: str | None, date_to: str | None, include_parent: bool = False,
    exclude: set[tuple[str, str]] | None = None,
) -> dict:
    """Check a bulk-download request and work out what it covers: the
    file's header, one entry per block of rows (one block per term, or per
    term per path for a KO in several pathways), the optional starting-term
    block, the samples (in date order, with ISO dates) and whether the file
    is too big to also list undetected samples. Raises HTTPException for a
    bad request, so both routes reject it before anything is sent.
    """
    if source != AnnotationSource.taxonomy and source.value not in _EXPORT_LEVELS:
        raise HTTPException(status_code=400, detail=f"Bulk download is not available for '{source.value}' yet")
    for label, value in (("date_from", date_from), ("date_to", date_to)):
        if value is not None and _parse_any_datetime(value) is None:
            raise HTTPException(status_code=400, detail=f"{label} is not a recognized date: {value!r}")

    if source == AnnotationSource.taxonomy:
        if exclude:
            raise HTTPException(status_code=400, detail="Path choices don't apply to taxonomy")
        header, entries, start, multi = _taxonomy_export_entries(db, parent, rank, include_parent)
    else:
        header, entries, start, multi = _paths_export_entries(
            db, source.value, parent, rank, include_parent, exclude or set(),
        )

    samples = _export_samples(db, date_from, date_to)
    blocks = len(entries) + (1 if start else 0)
    max_rows = blocks * len(samples)
    return {
        "source":   source.value,
        "header":   header,
        "entries":  entries,
        "start":    start,
        "terms":    len({e["annotation_id"] for e in entries}),
        "multi_path_terms": multi,
        "samples":  samples,
        "max_rows": max_rows,
        "sparse":   max_rows > _EXPORT_DENSE_ROW_LIMIT,
    }


def _series_export_filename(
    source: AnnotationSource, parent: str | None, rank: str, date_from: str | None, date_to: str | None,
) -> str:
    if source == AnnotationSource.taxonomy:
        parts = [parent.rsplit(";", 1)[-1] if parent else "all", rank, "timeseries"]
    else:
        parts = [source.value, parent or "all", rank, "timeseries"]
    if date_from or date_to:
        parts.append(f"{date_from or 'start'}_to_{date_to or 'end'}")
    return re.sub(r"[^A-Za-z0-9._-]+", "_", "_".join(parts)) + ".csv"


def _series_export_csv(db, plan: dict):
    """Yield the CSV in chunks: the starting term's block first (if asked
    for), then one block of rows per entry in id order, samples in date
    order within each block. Closes `db` when done (or when the download
    is abandoned)."""
    try:
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\n")
        writer.writerow(plan["header"])
        pending = 0
        for entries in ([plan["start"]] if plan["start"] else [], plan["entries"]):
            # entries are sorted by annotation_id, the same order the
            # series rows come back in, so the two can be walked together.
            ids = list(dict.fromkeys(e["annotation_id"] for e in entries))
            groups = groupby(iter_series_for_ids_sql(db, plan["source"], ids), key=itemgetter("annotation_id"))
            group = next(groups, None)
            for annotation_id, same_id in groupby(entries, key=itemgetter("annotation_id")):
                detected = {}
                if group is not None and group[0] == annotation_id:
                    detected = {r["sample"]: r for r in group[1]}
                    group = next(groups, None)
                for entry in same_id:
                    for sample, date in plan["samples"]:
                        row = detected.get(sample)
                        if row is not None:
                            writer.writerow([*entry["labels"], sample, date, row["egc"], row["norm_egc"], "true"])
                        elif plan["sparse"]:
                            continue
                        else:
                            writer.writerow([*entry["labels"], sample, date, 0, 0, "false"])
                        pending += 1
                        if pending >= _EXPORT_CHUNK_ROWS:
                            yield buf.getvalue()
                            buf.seek(0)
                            buf.truncate(0)
                            pending = 0
        yield buf.getvalue()
    finally:
        close_sql_connection(db)


def _parse_selection(raw: bytes) -> set[tuple[str, str]]:
    """The user's path choices from a POST body. The browser sends a
    text/plain form, so the body is `selection=<json>` where the JSON is
    {"exclude": [[term_id, path_parent_id], ...]}. Read by hand because
    FastAPI's own form parsing would need the python-multipart package."""
    text = raw.decode("utf-8", errors="replace").strip()
    name, sep, value = text.partition("=")
    if name != "selection" or not sep:
        raise HTTPException(status_code=400, detail="Expected a 'selection' field")
    try:
        data = json.loads(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="selection is not valid JSON") from None
    exclude = data.get("exclude", []) if isinstance(data, dict) else None
    if not isinstance(exclude, list) or not all(
        isinstance(pair, list) and len(pair) == 2 and all(isinstance(x, str) for x in pair) for pair in exclude
    ):
        raise HTTPException(status_code=400, detail="selection.exclude must be a list of [term, parent] pairs")
    return {(term, path_parent) for term, path_parent in exclude}


def _series_export_summary(
    source: AnnotationSource, rank: str, parent: str | None, date_from: str | None, date_to: str | None,
    include_parent: bool, exclude: set[tuple[str, str]] | None = None,
) -> dict:
    parent = parent or None
    db = connect_to_sql()
    try:
        plan = _series_export_plan(db, source, parent, rank, date_from, date_to, include_parent, exclude)
    finally:
        close_sql_connection(db)
    return {
        "source":           source.value,
        "parent":           parent,
        "rank":             rank,
        "taxa":             plan["terms"],
        "samples":          len(plan["samples"]),
        "max_rows":         plan["max_rows"],
        "sparse":           plan["sparse"],
        "multi_path_terms": plan["multi_path_terms"],
    }


def _series_export_response(
    source: AnnotationSource, rank: str, parent: str | None, date_from: str | None, date_to: str | None,
    include_parent: bool, exclude: set[tuple[str, str]] | None = None,
) -> StreamingResponse:
    parent = parent or None
    db = connect_to_sql()
    try:
        plan = _series_export_plan(db, source, parent, rank, date_from, date_to, include_parent, exclude)
    except Exception:
        close_sql_connection(db)
        raise
    filename = _series_export_filename(source, parent, rank, date_from, date_to)
    return StreamingResponse(
        _series_export_csv(db, plan),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/series/export/summary")
def series_export_summary(
    request:        Request,
    source:         AnnotationSource = Query(...),
    rank:           str = Query(...),
    parent:         str | None = Query(None),
    date_from:      str | None = Query(None),
    date_to:        str | None = Query(None),
    include_parent: bool = Query(False),
):
    """How big a /series/export download would be, shown before it starts:
    number of terms (`taxa`), samples, the most rows the file can have,
    whether it is too big to list undetected samples (sparse), and how many
    terms are reached through more than one path inside the start
    (multi_path_terms -- the KEGG/COG review list's size)."""
    return _series_export_summary(source, rank, parent, date_from, date_to, include_parent)


@router.post("/series/export/summary")
def series_export_summary_with_choices(
    request:        Request,
    source:         AnnotationSource = Query(...),
    rank:           str = Query(...),
    parent:         str | None = Query(None),
    date_from:      str | None = Query(None),
    date_to:        str | None = Query(None),
    include_parent: bool = Query(False),
    selection:      bytes = Body(..., media_type="text/plain"),
):
    """The summary with the user's unticked paths left out (see
    _parse_selection for the body)."""
    exclude = _parse_selection(selection)
    return _series_export_summary(source, rank, parent, date_from, date_to, include_parent, exclude)


@router.get("/series/export")
def series_export(
    request:        Request,
    source:         AnnotationSource = Query(...),
    rank:           str = Query(...),
    parent:         str | None = Query(None),
    date_from:      str | None = Query(None),
    date_to:        str | None = Query(None),
    include_parent: bool = Query(False),
):
    """CSV of every term at `rank` under `parent` (the whole dataset if
    omitted), one row per term per sample. Taxonomy columns: taxon, rank,
    lineage, sample, date, egc, norm_egc, detected. kegg/cog/enzyme columns:
    annotation_id, name, level, lineage_ids, lineage, also_in_other_paths,
    is_starting_term, then the same sample columns; a KO in several
    pathways gets one block of rows per pathway, flagged
    also_in_other_paths. include_parent adds the starting term's own rows
    first. Undetected samples are written as 0 with detected=false, unless
    the file would pass Excel's row limit, in which case only detected rows
    are written. Streamed, so a large file never has to be built in memory
    first."""
    return _series_export_response(source, rank, parent, date_from, date_to, include_parent)


@router.post("/series/export")
def series_export_with_choices(
    request:        Request,
    source:         AnnotationSource = Query(...),
    rank:           str = Query(...),
    parent:         str | None = Query(None),
    date_from:      str | None = Query(None),
    date_to:        str | None = Query(None),
    include_parent: bool = Query(False),
    selection:      bytes = Body(..., media_type="text/plain"),
):
    """The same CSV with the user's unticked paths left out. Sent as a
    text/plain form post (see _parse_selection) because the choices can be
    thousands of pairs -- too long for a link -- and a form post still lets
    the browser stream the file straight to disk."""
    exclude = _parse_selection(selection)
    return _series_export_response(source, rank, parent, date_from, date_to, include_parent, exclude)


@router.get("/series/export/review")
def series_export_review(
    request: Request,
    source:  AnnotationSource = Query(...),
    rank:    str = Query(...),
    parent:  str | None = Query(None),
):
    """The review list for a download: every term reached through more than
    one path inside the start, each with its paths most abundant first (see
    get_path_review_sql). Empty for taxonomy and enzyme, whose terms have
    one path each."""
    parent = parent or None
    if source == AnnotationSource.taxonomy:
        return {"terms": []}
    if source.value not in _EXPORT_LEVELS:
        raise HTTPException(status_code=400, detail=f"Bulk download is not available for '{source.value}' yet")
    db = connect_to_sql()
    try:
        depth, parent_depth = _paths_levels(db, source.value, parent, rank)
        terms = get_path_review_sql(db, source.value, parent, parent_depth, depth)
    finally:
        close_sql_connection(db)
    return {"terms": terms}
