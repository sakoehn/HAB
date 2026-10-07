"""
routes.py
---------
All FastAPI endpoints except /annotations/correlate (in correlation.py).

Endpoints
~~~~~~~~~
GET /debug
GET /sql-test
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

import os
import time
from collections import OrderedDict

from fastapi import APIRouter, HTTPException, Query, Request

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
    get_annotation_scaffolds_sql,
    get_annotation_series_sql,
    get_all_sample_names_sql,
    get_cog_children_sql,
    get_cog_path_sql,
    get_enzyme_children_sql,
    get_enzyme_path_sql,
    get_kegg_children_sql,
    get_kegg_immediate_parents_bulk_sql,
    get_kegg_path_sql,
    get_taxonomy_children_sql,
    get_top_annotations_sql,
    taxon_exists_sql,
    get_mappings_sql,
    get_search_annotations,
    get_top_annotations_from_catalog_sql,
    get_taxa_at_rank_sql,
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
    BASE_DIR,
    DATA_BACKEND,
    LOCATION_LAT,
    LOCATION_LON,
    LOCATION_NAME,
    TIDE_SHIFT_HOURS,
    TIMEPOINTS_CSV,
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

# A4 (docs/AUDIT-2026-10-05.md): this cache used to be a plain unbounded
# dict -- no size cap, no expiry, no way to clear it short of restarting
# the process. One real taxonomy entry measured 51.7 MB, and (before A5's
# fix, below) an unparseable date_from/date_to string was silently
# ignored but still used as the cache key, so every distinct junk string
# minted a fresh multi-MB entry. A5 already closes off the junk-string
# growth vector by rejecting bad dates before a cache key is ever built,
# but the cache still needs its own bound: a legitimate server lifetime
# can accumulate one entry per (source, date_from, date_to) combination
# a user has ever actually requested, and this process has no hook to
# learn a catalog rebuild happened (the in-process analog of CR11,
# docs/AUDIT-2026-09-22.md, which solved the equivalent problem for the
# SQL-table-backed correlations_cache by invalidating rows directly --
# not an option here, since this cache lives in THIS process's memory,
# not a table a separate migration script's process can reach into).
# An LRU size cap (an OrderedDict, oldest-accessed evicted first) bounds
# memory; a TTL bounds how long a pre-rebuild result can keep being
# served -- 30 minutes is long enough that a user paging through results
# never pays for the same (source, date range) aggregation twice in one
# sitting, short enough that a catalog rebuild (a manual, infrequent
# operator action, not a hot path) is never stale for more than half an
# hour without anyone needing to restart the process.
_TOP_ANN_CACHE_MAX_ENTRIES = 64
_TOP_ANN_CACHE_TTL_SECONDS = 30 * 60

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

@router.get("/debug")
def debug():
    return {
        "base_dir":              BASE_DIR,
        "timepoints_csv":        TIMEPOINTS_CSV,
        "timepoints_csv_exists": os.path.exists(TIMEPOINTS_CSV),
        "base_dir_exists":       os.path.exists(BASE_DIR),
        "base_dir_contents":     os.listdir(BASE_DIR) if os.path.exists(BASE_DIR) else "DIR NOT FOUND",
    }

@router.get("/sql-test")
def sql_test(request: Request):
    """ Test SQLite connection by a test query."""
    db = connect_to_sql()
    try:
        query = f"""
            SELECT *
            FROM annotation_series
            LIMIT 1
        """
        cursor = db.execute(query)
        return cursor.fetchall()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SQL operation failed: {str(e)}")
    finally:
        close_sql_connection(db)

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
    they're absent from both the JSON backend's mapping TSVs and the SQL
    backend's samples). Without this filter, /timepoints reports 132 while
    /samples reports 128 for the same dataset.
    """
    real_samples = set(real_samples)
    return [tp for taxon_oid, tp in timepoints.items() if taxon_oid in real_samples]


@router.get("/timepoints")
def list_timepoints(request: Request, page: int = 1, page_size: int = 50):
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
def list_samples(request: Request, page: int = 1, page_size: int = 50):
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
    page: int = 1, page_size: int = 100,
):
    """
    Search mappings for a given annotation ID and source.

    For kegg/enzyme/cog, annotation_id can be a pathway/class/category
    node, not just a leaf id -- it's expanded to every real leaf id
    beneath it (W24, docs/AUDIT-2026-09-22.md; e.g. source=kegg,
    annotation_id=00910 now returns every gene mapped to any KO under
    Nitrogen metabolism, not zero rows).

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

        leaf_count = None
        samples_were_capped = False
        if source.value in ("kegg", "cog", "enzyme"):
            leaf_ids = _expand_to_leaf_ids(conn, source.value, annotation_id)
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
        # mapping ids (A3, docs/AUDIT-2026-10-05.md) -- previously a bare
        # SELECT, which let a gene matching more than one of several
        # searched leaf ids produce duplicate ids inside the LIMIT, so the
        # post-GROUP-BY count could land under _MAPPINGS_ROW_LIMIT even
        # though real data was dropped (measured live: 100,275 real genes,
        # 49,969 (49.8%) returned, flagged results_were_truncated=False).
        results_were_truncated = len(mappings) >= _MAPPINGS_ROW_LIMIT
    finally:
        close_sql_connection(conn)

    results = []
    for row in mappings:
        row['timepoint'] = get_timepoint(row['sample'])
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


@router.get("/search/annotations")
def search_annotations(
    request:Request,
    q:             str | None = Query(None, min_length=1),
    annotation_id: str | None = Query(None),
    name_exact:    str | None = Query(None),
    sources: list[str] = Query(...),
    page: int = 1, page_size: int = 500,
):
    """
    Search across all samples for one or more annotation sources.

    Queries `annotation_series` directly with LIKE (native substring
    matching) and sorts by mean_egc. Enforces a 3-character minimum on `q`.
    """
    if not q and not annotation_id and not name_exact:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one of: q, annotation_id, or name_exact",
        )
    if q is not None and len(q) < 3:
        raise HTTPException(status_code=400, detail="Search must have at least 3 characters.")
    db = connect_to_sql()
    try:
        results = get_search_annotations(db, sources, q, annotation_id, name_exact)
    finally:
        close_sql_connection(db)
    results.sort(key=lambda r: r.get("mean_egc") or 0, reverse=True)
    return {
        "query":         q,
        "annotation_id": annotation_id,
        "name_exact":    name_exact,
        "sources":       sources,
        "total":         len(results),
        **paginate(results, page, page_size),
    }


@router.get("/series/annotations")
async def annotation_time_series(
    request: Request,
    source:        AnnotationSource = Query(...),
    annotation_id: str = Query(...),
    page: int = 1, page_size: int = 100,
):
    """Return EGC and norm_egc for one annotation across all samples,
    sorted chronologically."""
    results: list[dict] = []

    conn = connect_to_sql()
    try:
        rows = get_annotation_series_sql(conn, source.value, annotation_id)
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
async def taxonomy_children(request: Request, parent: str | None = Query(None)):
    """
    Direct children of a taxon (structure only — no egc values), for lazily
    populating an expandable tree without shipping the full ~38k-taxon index.

    parent omitted/empty -> the 4 domain roots (value['parent'] is None).
    """
    db = connect_to_sql()
    try:
        if parent and not taxon_exists_sql(db, parent):
            raise HTTPException(status_code=404, detail=f"Unknown taxon '{parent}'")
        children = get_taxonomy_children_sql(db, parent)
    finally:
        close_sql_connection(db)
    return {'parent': parent, 'count': len(children), 'data': children}


@router.get("/kegg/children")
async def kegg_children(request: Request, parent: str | None = Query(None)):
    """
    Direct children of a KEGG node (structure only — no egc values), for
    the BRITE hierarchy popup.

    parent omitted/empty -> the 8 top-level branches (Metabolism, Human
    Diseases, Brite Hierarchies, etc.).

    SQL backend only. `kegg_paths` (built from ko00001.keg, capturing every
    real multi-parent occurrence — see migrate_kegg_paths_to_sql.py) has no
    JSON-backend equivalent: the old per-sample .ko.json format only ever
    stored a single parent_id per node, which is the E14 bug this table
    exists to get past.
    """
    if DATA_BACKEND != 'sql':
        raise HTTPException(status_code=501, detail="KEGG hierarchy browsing requires DATA_BACKEND=sql")

    db = connect_to_sql()
    try:
        if parent is not None and _kegg_node_depth(db, parent) is None:
            raise HTTPException(status_code=404, detail=f"Unknown KEGG node '{parent}'")

        children = get_kegg_children_sql(db, parent)
    finally:
        close_sql_connection(db)
    return {'parent': parent, 'count': len(children), 'data': children}


@router.get("/kegg/path")
async def kegg_path(request: Request, id: str = Query(...)):
    """
    Ancestor path (root to node) for a KEGG node, for auto-expanding and
    highlighting a node in the hierarchy popup when opened from a chart
    for one specific annotation.

    SQL backend only, same reasoning as /kegg/children.
    """
    if DATA_BACKEND != 'sql':
        raise HTTPException(status_code=501, detail="KEGG hierarchy browsing requires DATA_BACKEND=sql")

    db = connect_to_sql()
    try:
        result = get_kegg_path_sql(db, id)
    finally:
        close_sql_connection(db)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown KEGG node '{id}'")
    return result


@router.get("/kegg/parents")
async def kegg_parents_bulk(request: Request, ids: str = Query(...)):
    """
    Every real IMMEDIATE parent (one level up) for each of a comma-separated
    list of KEGG node ids, in one request -- W30a (docs/AUDIT-2026-09-22.md):
    "Annotations by Parent" groups up to 200 rows at once, and a KO's
    stored `parent` is last-occurrence-wins (only one of its possibly-many
    real parents), so the panel needs every real parent for every row to
    bucket a multi-parent KO into every group it actually belongs to --
    one /kegg/path call per row would be 200 round trips; this is one.

    SQL backend only, same reasoning as /kegg/path.
    """
    if DATA_BACKEND != 'sql':
        raise HTTPException(status_code=501, detail="KEGG hierarchy browsing requires DATA_BACKEND=sql")

    id_list = [i for i in ids.split(",") if i]
    db = connect_to_sql()
    try:
        result = get_kegg_immediate_parents_bulk_sql(db, id_list)
    finally:
        close_sql_connection(db)
    return {"parents": result}


@router.get("/enzyme/children")
async def enzyme_children(request: Request, parent: str | None = Query(None)):
    """
    Direct children of an Enzyme (EC) node (structure only — no egc
    values), for the same BRITE-hierarchy-popup feature as /kegg/children.

    parent omitted/empty -> the 7 top-level EC classes (Oxidoreductases,
    Transferases, etc.).

    SQL backend only, same reasoning as /kegg/children -- enzyme_paths
    (see migrate_enzyme_paths_to_sql.py) has no JSON-backend equivalent.
    Unlike KEGG, every EC id has exactly one real parent (see
    get_enzyme_children_sql's docstring), so this exists purely for
    consistent tree-browsing UI, not to work around a multi-parent bug.
    """
    if DATA_BACKEND != 'sql':
        raise HTTPException(status_code=501, detail="Enzyme hierarchy browsing requires DATA_BACKEND=sql")

    db = connect_to_sql()
    try:
        if parent is not None and not _enzyme_node_exists(db, parent):
            raise HTTPException(status_code=404, detail=f"Unknown Enzyme node '{parent}'")

        children = get_enzyme_children_sql(db, parent)
    finally:
        close_sql_connection(db)
    return {'parent': parent, 'count': len(children), 'data': children}


@router.get("/enzyme/path")
async def enzyme_path(request: Request, id: str = Query(...)):
    """
    Ancestor path (root to node) for an Enzyme (EC) node, for auto-
    expanding and highlighting a node in the hierarchy popup when opened
    from a chart for one specific annotation.

    SQL backend only, same reasoning as /kegg/children.
    """
    if DATA_BACKEND != 'sql':
        raise HTTPException(status_code=501, detail="Enzyme hierarchy browsing requires DATA_BACKEND=sql")

    db = connect_to_sql()
    try:
        result = get_enzyme_path_sql(db, id)
    finally:
        close_sql_connection(db)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown Enzyme node '{id}'")
    return result


@router.get("/cog/children")
async def cog_children(request: Request, parent: str | None = Query(None)):
    """
    Direct children of a COG node (structure only — no egc values), for
    the same BRITE-hierarchy-popup feature as /kegg/children.

    parent omitted/empty -> the 26 top-level category letters (Energy
    production and conversion, etc.).

    SQL backend only, same reasoning as /kegg/children -- cog_paths (see
    migrate_cog_paths_to_sql.py) has no JSON-backend equivalent. A COG id
    can belong to more than one category, same as KEGG (E17,
    docs/AUDIT-2026-09-22.md) -- cog_paths has one row per real
    (category, COG) membership. The hierarchy is only 2 levels deep
    (category -> specific COG id), not 4.
    """
    if DATA_BACKEND != 'sql':
        raise HTTPException(status_code=501, detail="COG hierarchy browsing requires DATA_BACKEND=sql")

    db = connect_to_sql()
    try:
        if parent is not None and _cog_node_depth(db, parent) is None:
            raise HTTPException(status_code=404, detail=f"Unknown COG node '{parent}'")

        children = get_cog_children_sql(db, parent)
    finally:
        close_sql_connection(db)
    return {'parent': parent, 'count': len(children), 'data': children}


@router.get("/cog/path")
async def cog_path(request: Request, id: str = Query(...)):
    """
    Ancestor path (root to node) for a COG node, for auto-expanding and
    highlighting a node in the hierarchy popup when opened from a chart
    for one specific annotation.

    SQL backend only, same reasoning as /kegg/children.
    """
    if DATA_BACKEND != 'sql':
        raise HTTPException(status_code=501, detail="COG hierarchy browsing requires DATA_BACKEND=sql")

    db = connect_to_sql()
    try:
        result = get_cog_path_sql(db, id)
    finally:
        close_sql_connection(db)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown COG node '{id}'")
    return result


@router.get("/annotations/top")
async def top_annotations_by_egc(
    request:   Request,
    source:    AnnotationSource = Query(...),
    limit:     int = Query(25, ge=1, le=200),
    date_from: str | None = Query(None),
    date_to:   str | None = Query(None),
):
    """
    Return the top N annotations by mean EGC, optionally filtered by date range.
    Each result includes mean_egc, max_egc, mean_norm_egc, max_norm_egc.

    Cached per (source, date_from, date_to). date_from/date_to, if given,
    must parse as a real date (see _parse_any_datetime) -- a bound that
    doesn't parse is rejected with 400 rather than silently ignored (A5,
    docs/AUDIT-2026-10-05.md): it used to fall through to the FULL
    unfiltered dataset while still being echoed back in the response as
    if it had been applied, so e.g. a US-format "06/10/2021" or a typo'd
    "2021-13-99" looked like a successful filter that just happened to
    match everything.
    """
    # A5: validate before anything else -- a bad bound must never reach
    # the cache key (that was A4's own worst symptom: a fresh junk string
    # minting a fresh multi-MB cache entry) or the per-sample scan below.
    if date_from is not None and _parse_any_datetime(date_from) is None:
        raise HTTPException(status_code=400, detail=f"date_from is not a recognized date: {date_from!r}")
    if date_to is not None and _parse_any_datetime(date_to) is None:
        raise HTTPException(status_code=400, detail=f"date_to is not a recognized date: {date_to!r}")

    db = connect_to_sql()
    try:
        samples = get_all_sample_names_sql(db)
        if not samples:
            raise HTTPException(status_code=404, detail="No samples found")

        cache_key = (source.value, date_from or "", date_to or "")

        cached_entry = _top_ann_cache_get(cache_key)
        if cached_entry is None:
            if not date_from and not date_to:
                # Unfiltered requests are the common case -- go straight to the
                # precomputed annotation_catalog table instead of the per-sample
                # timepoint scan below, which exists only to resolve date-range
                # filters and would otherwise run needlessly on every request.
                cached_entry = (get_top_annotations_from_catalog_sql(db, source.value), len(samples))
            else:
                active_samples = [
                    s for s in samples
                    if is_within_date_range((get_timepoint(s) or {}).get("datetime"), date_from, date_to)
                ]
                cached_entry = (
                    (get_top_annotations_sql(db, source.value, active_samples), len(active_samples))
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
async def annotation_scaffolds(
    request:       Request,
    source:        AnnotationSource = Query(...),
    annotation_id: str = Query(...),
    sample:        str | None = Query(
        None, description="Restrict to one sample — strongly recommended for interactive use"
    ),
    page:          int = Query(1, ge=1),
    page_size:     int = Query(500, ge=1, le=5000),
):
    """
    Return scaffolds associated with an annotation, paginated.

    Passing `sample` restricts results to one sample and is strongly
    recommended for interactive use — without it, results span every
    sample that has this annotation, which for high-level nodes (e.g. a
    taxonomy domain) can still be very large even paginated, since sorting
    a mixed-sample result requires materializing everything first.

    Returns { annotation_id, source, sample, total, page, page_size, data }
    where data is [{ sample, date, scaffold, count }], sorted by date.
    """
    conn = connect_to_sql()
    try:
        scaffolds = get_annotation_scaffolds_sql(conn, source.value, annotation_id, sample=sample)
    finally:
        close_sql_connection(conn)
    rows: list[dict] = []
    for scaff in scaffolds:
        dt = (get_timepoint(scaff['sample_name']) or {}).get('datetime', '')
        rows.append({
                 "sample":   scaff["sample_name"],
                 "date":     dt,
                 "scaffold": scaff['scaffold_id'],
                 "count":    scaff["gene_count"],
        })

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No scaffolds found for '{annotation_id}' in source '{source.value}'"
                   + (f" sample '{sample}'" if sample else ""),
        )

    rows.sort(key=lambda r: timepoint_dt_sort_key(r["date"]) if r["date"] else -1.0)

    total = len(rows)
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]

    return {
        "annotation_id": annotation_id,
        "source":        source.value,
        "sample":        sample,
        "total":         total,
        "page":          page,
        "page_size":     page_size,
        "data":          page_rows,
    }


@router.get("/annotations/scaffolds/summary")
async def annotation_scaffolds_summary(
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


@router.get("/taxonomy/export")
async def taxonomy_rank_export(request: Request, rank: str):
    """Return all taxa at the given taxonomic rank (e.g. "genus", "order")."""
    depth = None
    for d, column in RANK_COLUMNS.items():
        # strip('"') undoes "order"'s SQL-reserved-word quoting;
        # rstrip('_') undoes class_'s Python-keyword-avoidance suffix
        if column.strip('"').rstrip('_') == rank:
            depth = d
            break

    if depth is None:
        raise HTTPException(status_code=400, detail=f"Rank '{rank}' not found")
    db = connect_to_sql()
    try:
        rows = get_taxa_at_rank_sql(db, depth)
    finally:
        close_sql_connection(db)
    return rows