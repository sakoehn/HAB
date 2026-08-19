"""
routes.py
---------
All FastAPI endpoints except /annotations/correlate (in correlation.py).

Endpoints
~~~~~~~~~
GET /debug
GET /mongo-test
GET /mongo-samples-test
GET /mongo-annotations-test
GET /status
GET /timepoints
GET /samples
GET /tides
GET /sun-times
GET /samples/{sample_name}/mappings/summary
GET /samples/{sample_name}/mappings
GET /mappings/search
GET /samples/{sample_name}/cog
GET /samples/{sample_name}/kegg
GET /samples/{sample_name}/enzyme
GET /samples/{sample_name}/taxonomy
GET /samples/{sample_name}/full
GET /search/annotations
GET /samples/{sample_name}/search/annotations
GET /series/annotations
GET /taxonomy/children
GET /annotations/top
GET /annotations/scaffolds
GET /annotations/scaffolds/summary
GET /taxonomy/export

All business logic (pagination, search, EGC extraction) lives here or in
cache.py / index.py — endpoints are intentionally thin.
"""

import os

from fastapi import APIRouter, HTTPException, Query, Request
from .cache_mongo import (
    get_all_sample_names_mongo,
    get_annotation_scaffold_buckets_split,
    get_annotation_series_mongo,
    get_annotation_series_split,
    get_taxonomy_children_mongo,
    get_top_annotations_mongo,
    taxon_exists_mongo,
)
from .cache_sql import (
    get_annotation_scaffolds_sql, 
    get_annotation_series_sql,
    get_all_sample_names_sql,
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
from .config import (
    ACTIVE_DATASET_VERSION,
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
    _ANN_META,
    _MAPPING_INDEX,
    DATA_DATE_MIN,
    DATA_DATE_MAX,
    search_index,
    timepoint_sort_key,
    timepoint_dt_sort_key,
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


def paginate_dict(data: dict, page: int, page_size: int) -> dict:
    """Paginate a dict by converting items to {key, value} pairs."""
    return paginate([{"key": k, "value": v} for k, v in data.items()], page, page_size)


# ── Annotation search / normalisation helpers ─────────────────────────────────

def _normalize_annotation_dict(data: dict, source: str, sample_name: str) -> list[dict]:
    return [
        {
            "source":        source,
            "sample":        sample_name,
            "timepoint":     get_timepoint(sample_name),
            "annotation_id": annotation_id,
            "name":          annotation_id if source == "taxonomy" else extract_annotation_name(value),
            "value":         value,
        }
        for annotation_id, value in data.items()
    ]


def _search_dict_annotations(
    data:          dict,
    source:        str,
    sample_name:   str,
    q:             str | None = None,
    annotation_id: str | None = None,
    name_exact:    str | None = None,
) -> list[dict]:
    items = _normalize_annotation_dict(data, source, sample_name)

    if annotation_id:
        items = [i for i in items if (i.get("annotation_id") or "").lower() == annotation_id.lower()]

    if name_exact:
        items = [i for i in items if (i.get("name") or "").lower() == name_exact.lower()]

    if q:
        q_lower = q.lower().strip()
        items = [
            i for i in items
            if q_lower in (i.get("annotation_id") or "").lower()
            or q_lower in (i.get("name") or "").lower()
        ]

    return items


def _filter_mapping_rows(rows: list, source: str, annotation_id: str) -> list:
    """Return rows whose relevant column contains annotation_id (partial, case-insensitive)."""
    col_map = {"kegg": "kegg_id", "enzyme": "enzyme", "cog": "cog_id", "taxonomy": "taxonomy"}
    q   = annotation_id.lower()
    col = col_map.get(source)

    results = []
    for row in rows:
        if col:
            val = getattr(row, col, None)
            if val and q in val.lower():
                results.append(row)
        else:
            for c in ("taxonomy", "kegg_id", "enzyme", "cog_id"):
                val = getattr(row, c, None)
                if val and q in val.lower():
                    results.append(row)
                    break
    return results


def _annotation_endpoint(
    sample_name:   str,
    source:        str,
    loader,
    q:             str | None,
    annotation_id: str | None,
    name_exact:    str | None,
    page:          int,
    page_size:     int,
) -> dict:
    data = loader(sample_name)
    if not data:
        raise HTTPException(status_code=404, detail=f"{source} data for '{sample_name}' not found")
    items = _search_dict_annotations(
        data=data, source=source, sample_name=sample_name,
        q=q, annotation_id=annotation_id, name_exact=name_exact,
    )
    return {"sample": sample_name, "timepoint": get_timepoint(sample_name), **paginate(items, page, page_size)}


# ── Top-annotations cache ─────────────────────────────────────────────────────

_TOP_ANN_CACHE: dict[tuple, list] = {}
_TOP_ANN_CACHE_MONGO: dict[tuple, list] = {}
_TOP_ANN_CACHE_SQL: dict[tuple, list] = {}


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

@router.get("/mongo-test")
async def mongo_test(request: Request):
    """ Test MongoDB connection by inserting and retrieving a test document."""
    db = request.app.state.mongo_db
    try:
        result = await db.test_collection.insert_one({"test": "data"})
        doc = await db.test_collection.find_one({"_id": result.inserted_id})
        doc["_id"] = str(doc["_id"])
        return {"status": "success", "inserted_id": str(result.inserted_id), "found_doc": doc}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB operation failed: {str(e)}")

@router.get("/mongo-samples-test")
async def mongo_samples_test(request: Request):
    """ Test MongoDB connection by retrieving sample names from the 'samples' collection. """
    db = request.app.state.mongo_db
    names = await get_all_sample_names_mongo(db)
    return {"sample_names": names }

@router.get("/mongo-annotations-test")
async def mongo_annotations_test(request: Request, sample_name: str, source: str, annotation_id: str):
    """Test MongoDB connection by retrieving annotation series from the 'annotations' collection."""
    db = request.app.state.mongo_db
    series = await get_annotation_series_mongo(db, sample_name, source, annotation_id)
    return {"sample_name": sample_name, "source": source, "annotation_id": annotation_id, "series": series}

@router.get("/sql-test")
def sql_test(request: Request):
    """ Test SQLite connection by a test query."""
    db = request.app.state.sql_conn
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

@router.get("/status")
def api_status():
    """Returns index readiness and the data date range."""
    return {
        "index_ready": index_module._INDEX_READY,
        "date_min":    DATA_DATE_MIN,
        "date_max":    DATA_DATE_MAX,
    }

@router.get("/timepoints")
def list_timepoints(page: int = 1, page_size: int = 50):
    """Return all samples with their readable dates, paginated."""
    if not TIMEPOINTS:
        raise HTTPException(status_code=404, detail="Timepoints data not found")
    return paginate(list(TIMEPOINTS.values()), page, page_size)


@router.get("/samples")
def list_samples(request: Request, page: int = 1, page_size: int = 50):
    """Return all sample names with their readable dates, paginated."""
    if DATA_BACKEND == 'sql':
        samples = get_all_sample_names_sql(request.app.state.sql_conn)
    else:
        samples = get_all_sample_names()
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


@router.get("/samples/{sample_name}/mappings/summary")
def get_mappings_summary(sample_name: str):
    rows = load_tsv(sample_name)
    if not rows:
        raise HTTPException(status_code=404, detail=f"Sample '{sample_name}' not found")
    return {"sample": sample_name, "timepoint": get_timepoint(sample_name), "count": len(rows)}


@router.get("/samples/{sample_name}/mappings")
def get_mappings(sample_name: str, page: int = 1, page_size: int = 100):
    rows = load_tsv(sample_name)
    if not rows:
        raise HTTPException(status_code=404, detail=f"Sample '{sample_name}' not found")
    paged = paginate(rows, page, page_size)
    paged["data"] = [row._asdict() for row in paged["data"]]
    return {"sample": sample_name, "timepoint": get_timepoint(sample_name), **paged}


@router.get("/mappings/search")
# One route dispatching across json/sql backends inline -- accepted complexity,
# not a candidate for splitting apart while the 3-way backend comparison is ongoing.
# pylint: disable-next=too-many-locals,too-many-branches
def search_mappings(
    request:Request,
    annotation_id: str = Query(..., description="Annotation ID to search for"),
    source: AnnotationSource = Query(..., description="Source type: kegg, cog, enzyme, taxonomy"),
    sample_count: int = Query(128, ge=1, le=128),
    unique_pairs: bool = Query(False),
):
    """
    Search mapping TSVs for a given annotation ID and source.

    Uses the pre-built _MAPPING_INDEX for O(1) lookup when ready.
    Falls back to a full file scan during startup warmup.
    Results are sorted chronologically and limited to sample_count samples.
    """
    if DATA_BACKEND == 'sql':
        samples = get_all_sample_names_sql(request.app.state.sql_conn)
    else:
        samples = get_all_sample_names()
    if not samples:
        raise HTTPException(status_code=404, detail="No samples found")

    samples_sorted  = sorted(samples, key=timepoint_sort_key)
    allowed_samples = set(samples_sorted[:sample_count])
    seen_keys: set[str] = set()
    results: list[dict] = []

    if DATA_BACKEND == 'json':
        if _MAPPING_INDEX.get(source.value):
            src_index  = _MAPPING_INDEX[source.value]
            candidates = src_index.get(annotation_id, [])

            if not candidates:
                q_lower = annotation_id.lower()
                for ann_id, entries in src_index.items():
                    if q_lower in ann_id.lower():
                        candidates = candidates + entries

            for sample_name, row in candidates:
                if sample_name not in allowed_samples:
                    continue
                if unique_pairs:
                    key = f"{row.taxonomy}|{row.kegg_id}|{row.enzyme}|{row.cog_id}"
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                results.append({"sample": sample_name, "timepoint": get_timepoint(sample_name), **row._asdict()})

            results.sort(
                key=lambda r: timepoint_dt_sort_key((r.get("timepoint") or {}).get("datetime"))
            )

        else:
            for sample_name in samples_sorted[:sample_count]:
                rows    = load_tsv(sample_name)
                matched = _filter_mapping_rows(rows, source.value, annotation_id)
                for row in matched:
                    if unique_pairs:
                        key = f"{row.taxonomy}|{row.kegg_id}|{row.enzyme}|{row.cog_id}"
                        if key in seen_keys:
                            continue
                        seen_keys.add(key)
                    results.append({"sample": sample_name, "timepoint": get_timepoint(sample_name), **row._asdict()})

    elif DATA_BACKEND == 'sql':
        mappings = get_mappings_sql(request.app.state.sql_conn, source.value, annotation_id)
        results = []
        for row in mappings:
            if row['sample'] not in allowed_samples:
                continue
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
        "annotation_id": annotation_id,
        "source":        source.value,
        "sample_count":  min(sample_count, len(samples)),
        "total":         len(results),
        "data":          results,
    }


@router.get("/samples/{sample_name}/cog")
def get_cog(
    sample_name: str,
    q: str | None = Query(None, min_length=1),
    annotation_id: str | None = Query(None),
    name_exact: str | None = Query(None),
    page: int = 1, page_size: int = 100,
):
    from .cache import load_cog
    return _annotation_endpoint(sample_name, "cog", load_cog, q, annotation_id, name_exact, page, page_size)


@router.get("/samples/{sample_name}/kegg")
def get_kegg(
    sample_name: str,
    q: str | None = Query(None, min_length=1),
    annotation_id: str | None = Query(None),
    name_exact: str | None = Query(None),
    page: int = 1, page_size: int = 100,
):
    from .cache import load_kegg
    return _annotation_endpoint(sample_name, "kegg", load_kegg, q, annotation_id, name_exact, page, page_size)


@router.get("/samples/{sample_name}/enzyme")
def get_enzyme(
    sample_name: str,
    q: str | None = Query(None, min_length=1),
    annotation_id: str | None = Query(None),
    name_exact: str | None = Query(None),
    page: int = 1, page_size: int = 100,
):
    from .cache import load_enzyme
    return _annotation_endpoint(sample_name, "enzyme", load_enzyme, q, annotation_id, name_exact, page, page_size)


@router.get("/samples/{sample_name}/taxonomy")
def get_taxonomy(
    sample_name: str,
    q: str | None = Query(None, min_length=1),
    annotation_id: str | None = Query(None),
    name_exact: str | None = Query(None),
    page: int = 1, page_size: int = 100,
):
    from .cache import load_taxonomy
    return _annotation_endpoint(sample_name, "taxonomy", load_taxonomy, q, annotation_id, name_exact, page, page_size)


@router.get("/samples/{sample_name}/full")
def get_full_sample(sample_name: str, page: int = 1, page_size: int = 100):
    from .cache import load_cog, load_kegg, load_enzyme, load_taxonomy
    rows = load_tsv(sample_name)
    if not rows:
        raise HTTPException(status_code=404, detail=f"Sample '{sample_name}' not found")
    mappings = paginate(rows, page, page_size)
    mappings["data"] = [row._asdict() for row in mappings["data"]]
    return {
        "sample":    sample_name,
        "timepoint": get_timepoint(sample_name),
        "mappings":  mappings,
        "cog":       paginate_dict(load_cog(sample_name),      page, page_size),
        "kegg":      paginate_dict(load_kegg(sample_name),     page, page_size),
        "enzyme":    paginate_dict(load_enzyme(sample_name),   page, page_size),
        "taxonomy":  paginate_dict(load_taxonomy(sample_name), page, page_size),
    }


def _search_annotations_scan(q, annotation_id, name_exact, sources, page, page_size) -> dict:
    """Full scan fallback used when the inverted index is still warming up."""
    seen: set[str] = set()
    results: list[dict] = []

    for sample_name in get_all_sample_names():
        for source_str in sources:
            try:
                source = AnnotationSource(source_str)
            except ValueError:
                continue
            data = load_annotations_by_source(sample_name, source)
            if not data:
                continue
            for m in _search_dict_annotations(
                data=data, source=source.value, sample_name=sample_name,
                q=q, annotation_id=annotation_id, name_exact=name_exact,
            ):
                key = f"{m['annotation_id']}::{m['source']}"
                if key in seen:
                    continue
                seen.add(key)
                meta = _ANN_META.get(source.value, {}).get(m["annotation_id"], {})
                m.update({
                    "mean_egc":      meta.get("mean_egc"),
                    "max_egc":       meta.get("max_egc"),
                    "mean_norm_egc": meta.get("mean_norm_egc"),
                    "max_norm_egc":  meta.get("max_norm_egc"),
                    "sample_count":  meta.get("sample_count"),
                })
                results.append(m)

    results.sort(key=lambda r: r.get("mean_egc") or 0, reverse=True)
    return {
        "query": q, "annotation_id": annotation_id, "name_exact": name_exact,
        "sources": sources,
        **paginate(results, page, page_size),
    }


@router.get("/search/annotations")
# One route dispatching across json/sql backends inline -- accepted complexity,
# not a candidate for splitting apart while the 3-way backend comparison is ongoing.
# pylint: disable-next=too-many-locals,too-many-branches
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

    DATA_BACKEND=json: uses the inverted index for O(1) lookup when ready
    (falls back to a full scan during warmup), and scores results across 4
    relevance tiers (descending priority):
      4 — exact annotation_id match
      3 — exact name match
      2 — annotation_id starts with query / query is substring of name
      1 — token match (inverted index)

    DATA_BACKEND=sql: queries `annotation_series` directly with LIKE
    (native substring matching, no inverted index needed) and sorts by
    mean_egc only -- deliberately skips the 4-tier relevance scoring above
    for this first pass (see project notes). Also enforces a 3-character
    minimum on `q`, which the json branch does not.
    """
    if not q and not annotation_id and not name_exact:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one of: q, annotation_id, or name_exact",
        )
    if DATA_BACKEND == 'json':
        if not index_module._INDEX_READY:
            return _search_annotations_scan(q, annotation_id, name_exact, sources, page, page_size)

        q_lower  = q.lower().strip() if q else None
        results: list[dict] = []

        for source_str in sources:
            try:
                source = AnnotationSource(source_str)
            except ValueError:
                continue
            src = source.value

            if annotation_id:
                ann_ids = {annotation_id} if annotation_id in _ANN_META[src] else set()
            elif q:
                ann_ids = search_index(src, q)
            else:
                ann_ids = set(_ANN_META[src].keys())

            if name_exact:
                name_lower = name_exact.lower()
                ann_ids = {
                    aid for aid in ann_ids
                    if (_ANN_META[src].get(aid, {}).get("name") or "").lower() == name_lower
                }

            for ann_id in ann_ids:
                meta = _ANN_META[src].get(ann_id)
                if not meta:
                    continue

                name  = (meta.get("name") or "").lower()
                score = 1
                if q_lower:
                    ann_id_lower = ann_id.lower()
                    if ann_id_lower == q_lower:
                        score = 4
                    elif name == q_lower:
                        score = 3
                    elif ann_id_lower.startswith(q_lower) or q_lower in name:
                        score = 2
                elif annotation_id:
                    score = 4
                elif name_exact:
                    score = 3

                results.append({
                    "source":        src,
                    "sample":        "",
                    "timepoint":     None,
                    "annotation_id": ann_id,
                    "name":          meta["name"],
                    "parent":        meta.get("parent"),
                    "mean_egc":      meta.get("mean_egc"),
                    "max_egc":       meta.get("max_egc"),
                    "mean_norm_egc": meta.get("mean_norm_egc"),
                    "max_norm_egc":  meta.get("max_norm_egc"),
                    "sample_count":  meta.get("sample_count", 0),
                    "value":         meta["value"],
                    "_score":        score,
                })

        results.sort(key=lambda r: (r["_score"], r["mean_egc"] or 0), reverse=True)
        for r in results:
            del r["_score"]

    if DATA_BACKEND == 'sql':
        db = request.app.state.sql_conn
        if q is not None and len(q) < 3:
            raise HTTPException(status_code=400, detail="Search must have at least 3 characters.")
        results = get_search_annotations(db, sources, q, annotation_id, name_exact)
        results.sort(key=lambda r: r.get("mean_egc") or 0, reverse=True)
    return {
        "query":         q,
        "annotation_id": annotation_id,
        "name_exact":    name_exact,
        "sources":       sources,
        "total":         len(results),
        **paginate(results, page, page_size),
    }


@router.get("/samples/{sample_name}/search/annotations")
def search_annotations_for_sample(
    sample_name:   str,
    q:             str | None = Query(None, min_length=1),
    annotation_id: str | None = Query(None),
    name_exact:    str | None = Query(None),
    sources: list[str] = Query(...),
    page: int = 1, page_size: int = 50,
):
    """Search within a single sample across one or more annotation sources."""
    if not q and not annotation_id and not name_exact:
        raise HTTPException(
            status_code=400,
            detail="Provide at least one of: q, annotation_id, or name_exact",
        )

    results: list[dict] = []
    for source_str in sources:
        try:
            source = AnnotationSource(source_str)
        except ValueError:
            continue
        data = load_annotations_by_source(sample_name, source)
        if not data:
            continue
        results.extend(
            _search_dict_annotations(
                data=data, source=source.value, sample_name=sample_name,
                q=q, annotation_id=annotation_id, name_exact=name_exact,
            )
        )

    if not results:
        raise HTTPException(
            status_code=404,
            detail=f"No matching annotations found for sample '{sample_name}'",
        )

    return {
        "sample":        sample_name,
        "timepoint":     get_timepoint(sample_name),
        "query":         q,
        "annotation_id": annotation_id,
        "name_exact":    name_exact,
        "sources":       sources,
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

    if DATA_BACKEND == "mongo":
        docs = await get_annotation_series_split(
            request.app.state.mongo_db, source.value, annotation_id, ACTIVE_DATASET_VERSION
        )
        for doc in docs:
            value_out = {
                "name":     doc.get("name"),
                "category": doc.get("category"),
                "egc":      doc.get("egc"),
                "norm_egc": doc.get("norm_egc"),
            }
            results.append({
                "source":        source.value,
                "sample":        doc["sample_name"],
                "timepoint":     get_timepoint(doc["sample_name"]),
                "annotation_id": annotation_id,
                "name":          doc.get("name"),
                "egc":           doc.get("egc"),
                "norm_egc":      doc.get("norm_egc"),
                "value":         value_out,
            })
    elif DATA_BACKEND == "sql":
        rows = get_annotation_series_sql(request.app.state.sql_conn, source.value, annotation_id)
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
    else:
        samples = get_all_sample_names()
        if not samples:
            raise HTTPException(status_code=404, detail="No samples found")

        for sample_name in samples:
            data  = load_annotations_by_source(sample_name, source)
            value = data.get(annotation_id)
            if value is None:
                continue
            ann_name = annotation_id if source == AnnotationSource.taxonomy else extract_annotation_name(value)
           
            value_out = (
                {k: v for k, v in value.items() if k != "scaffolds"}
                if isinstance(value, dict) else value
            )
            results.append({
                "source":        source.value,
                "sample":        sample_name,
                "timepoint":     get_timepoint(sample_name),
                "annotation_id": annotation_id,
                "name":          ann_name,
                "egc":           extract_egc(value),
                "norm_egc":      extract_norm_egc(value),
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
    if DATA_BACKEND == "mongo":
        db = request.app.state.mongo_db
        if parent and not await taxon_exists_mongo(db, parent):
            raise HTTPException(status_code=404, detail=f"Unknown taxon '{parent}'")
        children = await get_taxonomy_children_mongo(db, parent)
        return {"parent": parent, "count": len(children), "data": children}

    meta = _ANN_META["taxonomy"]

    if DATA_BACKEND == 'sql':
        db = request.app.state.sql_conn
        if parent and not taxon_exists_sql(db, parent):
            raise HTTPException(status_code=404, detail=f"Unknown taxon '{parent}'")
        children = get_taxonomy_children_sql(db, parent)
        return {'parent': parent, 'count': len(children), 'data': children}

    if parent:
        if parent not in meta:
            raise HTTPException(status_code=404, detail=f"Unknown taxon '{parent}'")
        matches = [rec for rec in meta.values() if rec.get("parent") == parent]
    else:
        matches = [rec for rec in meta.values() if rec.get("parent") is None]

    children = sorted(
        (
            {
                "annotation_id": rec["annotation_id"],
                "depth":         (rec.get("value") or {}).get("depth"),
                "category":      (rec.get("value") or {}).get("category"),
            }
            for rec in matches
        ),
        key=lambda c: c["annotation_id"],
    )
    return {"parent": parent, "count": len(children), "data": children}


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

    Cached per (source, date_from, date_to).
    """
    if DATA_BACKEND == "mongo":
        db = request.app.state.mongo_db
        samples = await get_all_sample_names_mongo(db)
        if not samples:
            raise HTTPException(status_code=404, detail="No samples found")

        cache_key = (source.value, date_from or "", date_to or "")

        if cache_key not in _TOP_ANN_CACHE_MONGO:
            active_samples = []
            for s in samples:
                tp = get_timepoint(s)
                if not tp:
                    continue
                dt = tp.get("datetime", "")
                if date_from and dt < date_from:
                    continue
                if date_to and dt > date_to + "z":
                    continue
                active_samples.append(s)

            if not active_samples:
                return {"source": source.value, "data": []}

            _TOP_ANN_CACHE_MONGO[cache_key] = await get_top_annotations_mongo(
                db, source.value, active_samples
            )

        cached = _TOP_ANN_CACHE_MONGO[cache_key]
        return {
            "source":       source.value,
            "sample_count": len(samples),
            "date_from":    date_from,
            "date_to":      date_to,
            "data":         cached[:limit],
        }
    elif DATA_BACKEND == 'sql':
        db = request.app.state.sql_conn
        samples = get_all_sample_names_sql(db)
        if not samples:
            raise HTTPException(status_code=404, detail="No samples found")

        cache_key = (source.value, date_from or "", date_to or "")

        if cache_key not in _TOP_ANN_CACHE_SQL:
            if not date_from and not date_to:
                # Unfiltered requests are the common case -- go straight to the
                # precomputed annotation_catalog table instead of the per-sample
                # timepoint scan below, which exists only to resolve date-range
                # filters and would otherwise run needlessly on every request.
                _TOP_ANN_CACHE_SQL[cache_key] = get_top_annotations_from_catalog_sql(db, source.value)
            else:
                active_samples = []
                for s in samples:
                    tp = get_timepoint(s)
                    if not tp:
                        continue
                    dt = tp.get("datetime", "")
                    if date_from and dt < date_from:
                        continue
                    if date_to and dt > date_to + "z":
                        continue
                    active_samples.append(s)

                if not active_samples:
                    return {"source": source.value, "data": []}

                _TOP_ANN_CACHE_SQL[cache_key] = get_top_annotations_sql(
                    db, source.value, active_samples
                )

        cached = _TOP_ANN_CACHE_SQL[cache_key]
        return {
            "source":       source.value,
            "sample_count": len(samples),
            "date_from":    date_from,
            "date_to":      date_to,
            "data":         cached[:limit],
        }
    else:
        samples = get_all_sample_names()
        if not samples:
            raise HTTPException(status_code=404, detail="No samples found")

        cache_key = (source.value, date_from or "", date_to or "")

        if cache_key not in _TOP_ANN_CACHE:
            active_samples = []
            for s in samples:
                tp = get_timepoint(s)
                if not tp:
                    continue
                dt = tp.get("datetime", "")
                if date_from and dt < date_from:
                    continue
                if date_to and dt > date_to + "z":
                    continue
                active_samples.append(s)

            if not active_samples:
                return {"source": source.value, "data": []}

            egc_map: dict[str, dict] = {}

            for sample_name in active_samples:
                data = load_annotations_by_source(sample_name, source)
                for annotation_id, value in data.items():
                    egc      = extract_egc(value)
                    norm_egc = extract_norm_egc(value)
                    if egc is None:
                        continue
                    if annotation_id not in egc_map:
                        ann_name = annotation_id if source == AnnotationSource.taxonomy else extract_annotation_name(value)
                        egc_map[annotation_id] = {
                            "annotation_id":   annotation_id,
                            "name":            ann_name,
                            "parent":          extract_parent(value, source.value),
                            "egc_values":      [],
                            "norm_egc_values": [],
                        }
                    egc_map[annotation_id]["egc_values"].append(egc)
                    if norm_egc is not None:
                        egc_map[annotation_id]["norm_egc_values"].append(norm_egc)

            computed: list[dict] = []
            for ann_id, info in egc_map.items():
                vals      = info["egc_values"]
                norm_vals = info["norm_egc_values"]
                computed.append({
                    "annotation_id": ann_id,
                    "name":          info["name"],
                    "parent":        info["parent"],
                    "mean_egc":      sum(vals) / len(vals),
                    "max_egc":       max(vals),
                    "mean_norm_egc": sum(norm_vals) / len(norm_vals) if norm_vals else None,
                    "max_norm_egc":  max(norm_vals) if norm_vals else None,
                    "sample_count":  len(vals),
                })

            computed.sort(key=lambda x: x["mean_egc"], reverse=True)
            _TOP_ANN_CACHE[cache_key] = computed

        cached = _TOP_ANN_CACHE[cache_key]
        return {
            "source":       source.value,
            "sample_count": len(samples),
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
    if DATA_BACKEND == "mongo":
        buckets = await get_annotation_scaffold_buckets_split(
            request.app.state.mongo_db, source.value, annotation_id, ACTIVE_DATASET_VERSION, sample=sample,
        )
        rows: list[dict] = []
        for bucket in buckets:
            dt = (get_timepoint(bucket["sample_name"]) or {}).get("datetime", "")
            for item in bucket["scaffolds"]:
                rows.append({
                    "sample":   bucket["sample_name"],
                    "date":     dt,
                    "scaffold": item["scaffold"],
                    "count":    item["count"],
                })
    elif DATA_BACKEND == "sql":
        scaffolds = get_annotation_scaffolds_sql(
            request.app.state.sql_conn, source.value, annotation_id, sample=sample
        )
        rows: list[dict] = []
        for scaff in scaffolds:
            dt = (get_timepoint(scaff['sample_name']) or {}).get('datetime', '')
            rows.append({
                     "sample":   scaff["sample_name"],
                     "date":     dt,
                     "scaffold": scaff['scaffold_id'],
                     "count":    scaff["gene_count"],
            })
    else: # json flatat files
        samples = [sample] if sample else get_all_sample_names()
        if not samples:
            raise HTTPException(status_code=404, detail="No samples found")

        rows = []
        for sample_name in samples:
            data  = load_annotations_by_source(sample_name, source)
            value = data.get(annotation_id)
            if not isinstance(value, dict):
                continue
            scaffolds = value.get("scaffolds")
            if not isinstance(scaffolds, dict):
                continue

            dt = ((get_timepoint(sample_name) or {}).get("datetime", ""))
            for scaffold_name, count in scaffolds.items():
                rows.append({
                    "sample":   sample_name,
                    "date":     dt,
                    "scaffold": scaffold_name,
                    "count":    int(count) if isinstance(count, (int, float)) else 1,
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
    if DATA_BACKEND == "mongo":
        docs = await get_annotation_series_split(
            request.app.state.mongo_db, source.value, annotation_id, ACTIVE_DATASET_VERSION
        )
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
    if DATA_BACKEND == 'sql':
        docs = get_annotation_series_sql(
            request.app.state.sql_conn, source.value, annotation_id
        )
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
    samples = get_all_sample_names()
    if not samples:
        raise HTTPException(status_code=404, detail="No samples found")

    rows: list[dict] = []
    for sample_name in samples:
        data  = load_annotations_by_source(sample_name, source)
        value = data.get(annotation_id)
        if not isinstance(value, dict):
            continue
        scaffolds = value.get("scaffolds")
        if not isinstance(scaffolds, dict) or not scaffolds:
            continue

        dt = ((get_timepoint(sample_name) or {}).get("datetime", ""))
        rows.append({
            "sample":         sample_name,
            "date":           dt,
            "scaffold_count": len(scaffolds),
            "gene_count":     sum(scaffolds.values()),
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
    db = request.app.state.sql_conn
    depth = None
    for d, column in RANK_COLUMNS.items():
        # strip('"') undoes "order"'s SQL-reserved-word quoting;
        # rstrip('_') undoes class_'s Python-keyword-avoidance suffix
        if column.strip('"').rstrip('_') == rank:
            depth = d
            break

    if depth is None:
        raise HTTPException(status_code=400, detail=f"Rank '{rank}' not found")
    rows = get_taxa_at_rank_sql(db, depth)
    return rows