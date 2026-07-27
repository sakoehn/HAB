"""
cache_mongo.py
--------------
Mongo-backed equivalents of api/cache.py's data-access functions, so
routes.py can call either backend interchangeably based on DATA_BACKEND.
"""


async def get_all_sample_names_mongo(db) -> list[str]:
    """
    Mongo equivalent of cache.get_all_sample_names() -> list[str].

    Derived from the real annotations collection (db.annotations.distinct),
    not the separate 'samples' collection — that one was only ever a
    hand-populated 4-document proof-of-concept stub from before the real
    migration scripts existed, and was never kept in sync with the full
    128-sample dataset. Using it here silently undercounted samples.
    """
    return await db.annotations.distinct("sample_name")

async def get_annotation_series_mongo(db, source: str, annotation_id: str) -> list[dict]:
    """Mongo equivalent of the /series/annotations route logic — one
    annotation's documents across every sample that has it."""
    docs = await db.annotations.find({"source": source, "annotation_id": annotation_id}).to_list(length=None)
    for doc in docs:
        doc.pop("_id", None)
    return docs


async def get_taxonomy_children_mongo(db, parent: str | None) -> list[dict]:
    """
    Mongo equivalent of the /taxonomy/children route logic — direct
    children of a taxon, deduplicated to one entry per unique annotation_id.

    Unlike _ANN_META (one record per unique taxon, built once at startup),
    Mongo has one document per (sample, taxon) pair — the same taxon repeats
    once per sample that has it. depth/category are structural properties of
    the taxon itself, identical across every sample, so it's safe to keep
    just the first copy of each and discard the rest.
    """
    docs = await db.annotations.find(
        {"source": "taxonomy", "parent": parent},
        {"annotation_id": 1, "depth": 1, "category": 1},
    ).to_list(length=None)

    children_by_id: dict[str, dict] = {}
    for doc in docs:
        annotation_id = doc["annotation_id"]
        if annotation_id not in children_by_id:
            children_by_id[annotation_id] = {
                "annotation_id": annotation_id,
                "depth":         doc.get("depth"),
                "category":      doc.get("category"),
            }

    return sorted(children_by_id.values(), key=lambda c: c["annotation_id"])


async def taxon_exists_mongo(db, annotation_id: str) -> bool:
    """Whether a taxon exists at all — used to distinguish 'valid taxon
    with no children' (empty list, not an error) from 'unknown taxon'."""
    count = await db.annotations.count_documents(
        {"source": "taxonomy", "annotation_id": annotation_id}, limit=1
    )
    return count > 0


def _resolve_parent(source: str, category, parent_id, parent_name, parent) -> str | None:
    """Mongo equivalent of cache.extract_parent() — same per-source fallback
    rules, applied to the fields already stored on each grouped result."""
    if source == "kegg":
        return parent_name or parent_id or category
    if source == "cog":
        return category
    if source == "enzyme":
        return parent_name or parent_id
    if source == "taxonomy":
        return parent
    return None


async def get_top_annotations_mongo(db, source: str, sample_names: list[str]) -> list[dict]:
    """
    Mongo equivalent of the /annotations/top route logic — mean/max EGC per
    annotation_id, computed across the given samples via an aggregation
    pipeline (grouping happens inside Mongo, not by pulling every document
    back to Python). Returns ALL annotations sorted by mean_egc descending
    — the route itself slices to `limit`, mirroring how _TOP_ANN_CACHE
    caches the full sorted list so a later request with a higher limit
    doesn't need to recompute.
    """
    pipeline = [
        {"$match": {"source": source, "sample_name": {"$in": sample_names}}},
        {"$group": {
            "_id":            "$annotation_id",
            "name":           {"$first": "$name"},
            "category":       {"$first": "$category"},
            "parent_id":      {"$first": "$parent_id"},
            "parent_name":    {"$first": "$parent_name"},
            "parent":         {"$first": "$parent"},
            "mean_egc":       {"$avg": "$egc"},
            "max_egc":        {"$max": "$egc"},
            "mean_norm_egc":  {"$avg": "$norm_egc"},
            "max_norm_egc":   {"$max": "$norm_egc"},
            "sample_count":   {"$sum": 1},
        }},
        {"$sort": {"mean_egc": -1}},
    ]
    results = await db.annotations.aggregate(pipeline).to_list(length=None)

    return [
        {
            "annotation_id":  r["_id"],
            "name":           r.get("name"),
            "parent":         _resolve_parent(
                source, r.get("category"), r.get("parent_id"), r.get("parent_name"), r.get("parent")
            ),
            "mean_egc":       r["mean_egc"],
            "max_egc":        r["max_egc"],
            "mean_norm_egc":  r.get("mean_norm_egc"),
            "max_norm_egc":   r.get("max_norm_egc"),
            "sample_count":   r["sample_count"],
        }
        for r in results
    ]