"""
migrate_cog_to_mongo.py
------------------------
One-off, read-only migration: loads every sample's COG annotation JSON
(DataStructures/COG/<sample>.cog.json) into the flattened Mongo shape used
by api/cache_mongo.py — one document per (sample, annotation_id).

Never modifies the source JSON files — only reads them. Safe to re-run:
existing source="cog" documents are cleared first, so re-running doesn't
create duplicates.

Uses plain pymongo (sync), not motor — this is a standalone batch job, not
part of the running FastAPI app, so there's no concurrent request handling
for async to help with here.

Usage (from FastAPI/):
    python scripts/migrate_cog_to_mongo.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pymongo import MongoClient

from api.config import COG_DIR, MONGO_URI, MONGO_DB_NAME

BATCH_SIZE = 5000


def iter_cog_documents():
    """Yield one flattened document per (sample, annotation_id) across every COG file."""
    sample_files = sorted(f for f in os.listdir(COG_DIR) if f.endswith(".cog.json"))

    for i, filename in enumerate(sample_files, start=1):
        sample_name = filename.removesuffix(".cog.json")
        path = os.path.join(COG_DIR, filename)

        with open(path, "r") as f:
            annotations = json.load(f)

        for annotation_id, entry in annotations.items():
            yield {
                "sample_name":   sample_name,
                "source":        "cog",
                "annotation_id": annotation_id,
                "name":          entry.get("name"),
                "category":      entry.get("category"),
                "egc":           entry.get("egc"),
                "norm_egc":      entry.get("norm_egc"),
                "scaffolds":     entry.get("scaffolds", {}),
            }

        print(f"[{i}/{len(sample_files)}] read {sample_name} ({len(annotations)} annotations)")


def main():
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB_NAME]

    existing = db.annotations.count_documents({"source": "cog"})
    print(f"Clearing {existing} existing source='cog' documents before reloading...")
    db.annotations.delete_many({"source": "cog"})

    batch = []
    total_inserted = 0

    for doc in iter_cog_documents():
        batch.append(doc)
        if len(batch) >= BATCH_SIZE:
            db.annotations.insert_many(batch)
            total_inserted += len(batch)
            print(f"  inserted {total_inserted} documents so far...")
            batch = []

    if batch:
        db.annotations.insert_many(batch)
        total_inserted += len(batch)

    print(f"Done. Inserted {total_inserted} COG documents into '{MONGO_DB_NAME}.annotations'.")
    client.close()


if __name__ == "__main__":
    main()
