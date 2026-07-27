"""
migrate_taxonomy_to_mongo.py
------------------------------
One-off, read-only migration: loads every sample's Taxonomy annotation JSON
(DataStructures/Taxonomy/<sample>.tax.json) into the flattened Mongo shape
used by api/cache_mongo.py — one document per (sample, annotation_id).

Taxonomy entries have a DIFFERENT shape than cog/kegg/enzyme: there's no
"name" field (the annotation_id itself — e.g. "Bacteria" — is the taxon's
name, matching how api/routes.py already treats it: ann_name = annotation_id
for source == taxonomy), and there's a single "parent" field rather than
parent_id/parent_name. "name" is still stored here, set to annotation_id,
so every document in the annotations collection has a consistent "name"
field regardless of source.

Never modifies the source JSON files — only reads them. Safe to re-run:
existing source="taxonomy" documents are cleared first, so re-running
doesn't create duplicates.

Uses plain pymongo (sync), not motor — see migrate_cog_to_mongo.py for why.

Usage (from FastAPI/):
    python scripts/migrate_taxonomy_to_mongo.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pymongo import MongoClient

from api.config import TAXONOMY_DIR, MONGO_URI, MONGO_DB_NAME

BATCH_SIZE = 5000


def iter_taxonomy_documents():
    """Yield one flattened document per (sample, annotation_id) across every Taxonomy file."""
    sample_files = sorted(f for f in os.listdir(TAXONOMY_DIR) if f.endswith(".tax.json"))

    for i, filename in enumerate(sample_files, start=1):
        sample_name = filename.removesuffix(".tax.json")
        path = os.path.join(TAXONOMY_DIR, filename)

        with open(path, "r") as f:
            annotations = json.load(f)

        for annotation_id, entry in annotations.items():
            yield {
                "sample_name":   sample_name,
                "source":        "taxonomy",
                "annotation_id": annotation_id,
                "name":          annotation_id,
                "category":      entry.get("category"),
                "depth":         entry.get("depth"),
                "parent":        entry.get("parent"),
                "egc":           entry.get("egc"),
                "norm_egc":      entry.get("norm_egc"),
                "scaffolds":     entry.get("scaffolds", {}),
            }

        print(f"[{i}/{len(sample_files)}] read {sample_name} ({len(annotations)} annotations)")


def main():
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB_NAME]

    existing = db.annotations.count_documents({"source": "taxonomy"})
    print(f"Clearing {existing} existing source='taxonomy' documents before reloading...")
    db.annotations.delete_many({"source": "taxonomy"})

    batch = []
    total_inserted = 0

    for doc in iter_taxonomy_documents():
        batch.append(doc)
        if len(batch) >= BATCH_SIZE:
            db.annotations.insert_many(batch)
            total_inserted += len(batch)
            print(f"  inserted {total_inserted} documents so far...")
            batch = []

    if batch:
        db.annotations.insert_many(batch)
        total_inserted += len(batch)

    print(f"Done. Inserted {total_inserted} Taxonomy documents into '{MONGO_DB_NAME}.annotations'.")
    client.close()


if __name__ == "__main__":
    main()
