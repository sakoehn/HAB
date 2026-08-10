"""
migrate_enzyme_split.py
-------------------------
PILOT: rebuilds Enzyme data into the new split-collection Mongo schema
("annotation_series" + bucketed "scaffolds") instead of the single
"annotations" collection the current app reads from.

Additive and non-destructive: does NOT touch or delete anything in the
existing "annotations" collection, and no live route reads from these new
collections yet. Safe to run against the live database with the app
running.

Piloted on Enzyme first (smallest source, 347,107 existing documents)
before repeating this pattern for cog/kegg/taxonomy. See
MONGODB_MIGRATION_FOLLOWUP.md Phase 3 and project memory (2026-07-28
session) for why the split happened and why scaffolds are bucketed
instead of fully flattened: 623,941,321 total scaffold entries measured
across the dataset, with one taxonomy document alone holding 485,842 --
fully flattening would have made "scaffolds" ~100x the size of every
other collection. SCAFFOLD_BUCKET_CAP (api/config.py) bounds each bucket
document; measured ~526 KB per bucket at the worst-case document, well
under Mongo's 16 MiB hard limit.

Safe to re-run: existing annotation_series/scaffolds documents for this
exact (dataset_version, source) are cleared first. Never touches other
dataset_versions or the legacy "annotations" collection.

Usage (from FastAPI/):
    python scripts/migrate_enzyme_split.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pymongo import MongoClient

from api.config import ENZYME_DIR, MONGO_URI, MONGO_DB_NAME, SCAFFOLD_BUCKET_CAP
from api.manifest import start_ingestion, validate_and_finish

DATASET_VERSION = "2026-07-28-01"
SOURCE = "enzyme"
BATCH_SIZE = 5000


def iter_series_and_scaffold_docs():
    """Yields (series_doc, scaffold_docs) pairs -- one series_doc and zero
    or more bucketed scaffold_docs per (sample, annotation_id)."""
    sample_files = sorted(f for f in os.listdir(ENZYME_DIR) if f.endswith(".enzyme.json"))

    for i, filename in enumerate(sample_files, start=1):
        sample_name = filename.removesuffix(".enzyme.json")
        path = os.path.join(ENZYME_DIR, filename)

        with open(path, "r") as f:
            annotations = json.load(f)

        for annotation_id, entry in annotations.items():
            scaffolds = entry.get("scaffolds") or {}
            scaffold_items = list(scaffolds.items())

            series_doc = {
                "dataset_version": DATASET_VERSION,
                "sample_name":     sample_name,
                "source":          SOURCE,
                "annotation_id":   annotation_id,
                "name":            entry.get("name"),
                "category":        entry.get("category"),
                "depth":           entry.get("depth"),
                "parent_id":       entry.get("parent_id"),
                "parent_name":     entry.get("parent_name"),
                "egc":             entry.get("egc"),
                "norm_egc":        entry.get("norm_egc"),
                "scaffold_count":  len(scaffold_items),
                "gene_count":      sum(v for _, v in scaffold_items),
            }

            scaffold_docs = []
            for bucket_index, start in enumerate(range(0, len(scaffold_items), SCAFFOLD_BUCKET_CAP)):
                chunk = scaffold_items[start:start + SCAFFOLD_BUCKET_CAP]
                scaffold_docs.append({
                    "dataset_version": DATASET_VERSION,
                    "source":          SOURCE,
                    "annotation_id":   annotation_id,
                    "sample_name":     sample_name,
                    "bucket_index":    bucket_index,
                    "scaffolds":       [{"scaffold": k, "count": v} for k, v in chunk],
                })

            yield series_doc, scaffold_docs

        print(f"[{i}/{len(sample_files)}] read {sample_name} ({len(annotations)} annotations)")


def main():
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB_NAME]

    print(f"Clearing any existing dataset_version='{DATASET_VERSION}' source='{SOURCE}' documents...")
    db.annotation_series.delete_many({"dataset_version": DATASET_VERSION, "source": SOURCE})
    db.scaffolds.delete_many({"dataset_version": DATASET_VERSION, "source": SOURCE})

    start_ingestion(db, DATASET_VERSION, SOURCE)

    series_batch = []
    scaffold_batch = []
    total_series = 0
    total_scaffold_entries = 0

    for series_doc, scaffold_docs in iter_series_and_scaffold_docs():
        series_batch.append(series_doc)
        scaffold_batch.extend(scaffold_docs)
        total_series += 1
        total_scaffold_entries += series_doc["scaffold_count"]

        if len(series_batch) >= BATCH_SIZE:
            db.annotation_series.insert_many(series_batch)
            series_batch = []
        if len(scaffold_batch) >= BATCH_SIZE:
            db.scaffolds.insert_many(scaffold_batch)
            scaffold_batch = []

    if series_batch:
        db.annotation_series.insert_many(series_batch)
    if scaffold_batch:
        db.scaffolds.insert_many(scaffold_batch)

    print(f"Inserted {total_series} annotation_series docs, {total_scaffold_entries} total scaffold entries.")
    print("Validating...")

    result = validate_and_finish(
        db, DATASET_VERSION, SOURCE,
        expected_series_count=total_series,
        expected_scaffold_entries=total_scaffold_entries,
    )
    for k, v in result.items():
        print(f"  {k}: {v}")
    print("PASSED" if result["passed"] else "FAILED")

    client.close()


if __name__ == "__main__":
    main()
