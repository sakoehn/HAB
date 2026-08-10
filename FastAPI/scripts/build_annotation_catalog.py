"""
build_annotation_catalog.py
------------------------------
Phase 1 (search decision spike) step 3: builds "annotation_catalog" -- one
document per unique (source, annotation_id), aggregated from the split
"annotation_series" collection (already scaffold-free, one row per
sample -- see migrate_*_split.py). This is the collection any search
prototype (MongoDB n-gram, manual trigram, etc.) should be built over, per
MONGODB_MIGRATION_FOLLOWUP.md: search should read unique annotations, not
per-sample occurrence rows.

Aggregating from annotation_series rather than the legacy bundled
"annotations" collection is a deliberate, measured choice -- see project
memory (2026-07-28): annotation_series is ~1.57 GB vs the legacy
collection's 14.79 GB (89.4% of which is scaffold data this aggregation
doesn't need), so building the catalog here is roughly 9x less data
touched for the same result.

Each document also carries mean/max EGC and normalized EGC (same
aggregate stats already computed by get_top_annotations_mongo) and a
lowercased name field for future search matching.

Usage (from FastAPI/):
    python scripts/build_annotation_catalog.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pymongo import ASCENDING, MongoClient

from api.config import MONGO_URI, MONGO_DB_NAME
from api.manifest import start_ingestion

DATASET_VERSION = "2026-07-28-01"

# Real unique-annotation counts measured directly from Mongo during Phase 0
# (2026-07-28) -- the expected per-source totals for this collection.
EXPECTED_UNIQUE_COUNTS = {
    "cog":      4_612,
    "kegg":     12_699,
    "enzyme":   3_561,
    "taxonomy": 60_235,
}

# Same per-source parent-resolution rules as api/cache_mongo.py's
# _resolve_parent(), applied here at catalog-build time instead of at
# request time.
def resolve_parent(source: str, category, parent_id, parent_name, parent) -> str | None:
    if source == "kegg":
        return parent_name or parent_id or category
    if source == "cog":
        return category
    if source == "enzyme":
        return parent_name or parent_id
    if source == "taxonomy":
        return parent
    return None


def main():
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB_NAME]

    start_ingestion(db, DATASET_VERSION, "annotation_catalog")

    print(f"Clearing any existing dataset_version='{DATASET_VERSION}' annotation_catalog documents...")
    db.annotation_catalog.delete_many({"dataset_version": DATASET_VERSION})

    pipeline = [
        {"$match": {"dataset_version": DATASET_VERSION}},
        {"$group": {
            "_id":            {"source": "$source", "annotation_id": "$annotation_id"},
            "name":           {"$first": "$name"},
            "category":       {"$first": "$category"},
            "depth":          {"$first": "$depth"},
            "parent_id":      {"$first": "$parent_id"},
            "parent_name":    {"$first": "$parent_name"},
            "parent_raw":     {"$first": "$parent"},
            "mean_egc":       {"$avg": "$egc"},
            "max_egc":        {"$max": "$egc"},
            "mean_norm_egc":  {"$avg": "$norm_egc"},
            "max_norm_egc":   {"$max": "$norm_egc"},
            "sample_count":   {"$sum": 1},
        }},
    ]

    print("Aggregating annotation_series -> annotation_catalog (one pass, all four sources)...")
    batch = []
    total_inserted = 0
    per_source_counts: dict[str, int] = {}

    for row in db.annotation_series.aggregate(pipeline, allowDiskUse=True):
        source = row["_id"]["source"]
        annotation_id = row["_id"]["annotation_id"]
        name = row.get("name") or (annotation_id if source == "taxonomy" else "")
        parent = resolve_parent(source, row.get("category"), row.get("parent_id"), row.get("parent_name"), row.get("parent_raw"))

        doc = {
            "dataset_version": DATASET_VERSION,
            "source":          source,
            "annotation_id":   annotation_id,
            "name":            name,
            "name_lower":      name.lower() if name else "",
            "category":        row.get("category"),
            "depth":           row.get("depth"),
            "parent":          parent,
            "mean_egc":        row.get("mean_egc"),
            "max_egc":         row.get("max_egc"),
            "mean_norm_egc":   row.get("mean_norm_egc"),
            "max_norm_egc":    row.get("max_norm_egc"),
            "sample_count":    row.get("sample_count"),
        }
        batch.append(doc)
        per_source_counts[source] = per_source_counts.get(source, 0) + 1

        if len(batch) >= 5000:
            db.annotation_catalog.insert_many(batch)
            total_inserted += len(batch)
            batch = []

    if batch:
        db.annotation_catalog.insert_many(batch)
        total_inserted += len(batch)

    print(f"Inserted {total_inserted} annotation_catalog documents.")
    passed = True
    for src in sorted(EXPECTED_UNIQUE_COUNTS):
        actual = per_source_counts.get(src, 0)
        expected = EXPECTED_UNIQUE_COUNTS[src]
        status = "OK" if actual == expected else "MISMATCH"
        if actual != expected:
            passed = False
        print(f"  {src:10s}: {actual:,} (expected {expected:,}) -- {status}")

    db.dataset_manifest.update_one(
        {"dataset_version": DATASET_VERSION, "source": "annotation_catalog"},
        {"$set": {
            "status": "ready" if passed else "failed",
            "counts": {"annotation_catalog": total_inserted, **per_source_counts},
        }},
    )
    print("PASSED" if passed else "FAILED")

    print("Creating indexes...")
    name = db.annotation_catalog.create_index(
        [("dataset_version", ASCENDING), ("source", ASCENDING), ("annotation_id", ASCENDING)],
        unique=True,
    )
    print(f"  created/confirmed (unique): {name}")
    name = db.annotation_catalog.create_index(
        [("dataset_version", ASCENDING), ("source", ASCENDING), ("name_lower", ASCENDING)]
    )
    print(f"  created/confirmed: {name}")

    client.close()


if __name__ == "__main__":
    main()
