"""
migrate_taxonomy_split.py
---------------------------
Rebuilds Taxonomy data into the new split-collection Mongo schema
("annotation_series" + bucketed "scaffolds") instead of the single
"annotations" collection the current app reads from.

Taxonomy entries have a DIFFERENT shape than cog/kegg/enzyme: there's no
"name" field (the annotation_id itself -- e.g. "Bacteria" -- is the taxon's
name, matching how api/routes.py and the other three migration scripts
already treat it), and there's a single "parent" field rather than
parent_id/parent_name. "name" is still stored here, set to annotation_id,
so every annotation_series document has a consistent "name" field
regardless of source.

This is also the largest and most important source for this migration:
taxonomy alone measured at 70% of the entire legacy "annotations"
collection (4,476,030 of 6,354,182 docs) despite only 60,235 unique
annotation_ids -- and holds the single largest scaffold map found in the
whole dataset (485,842 entries, one document, taxonomy/Bacteria). See
project memory (2026-07-28 session) for the full measurement.

Same pattern validated against Enzyme first -- see migrate_enzyme_split.py
for the full design rationale (bucketing, manifest validation, etc.).

Additive and non-destructive: does NOT touch or delete anything in the
existing "annotations" collection, and no live route reads from these new
collections yet.

Safe to re-run: existing annotation_series/scaffolds documents for this
exact (dataset_version, source) are cleared first.

Usage (from FastAPI/):
    python scripts/migrate_taxonomy_split.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pymongo import MongoClient

from api.config import TAXONOMY_DIR, MONGO_URI, MONGO_DB_NAME, SCAFFOLD_BUCKET_CAP
from api.manifest import start_ingestion, validate_and_finish

DATASET_VERSION = "2026-07-28-01"
SOURCE = "taxonomy"
BATCH_SIZE = 5000


def iter_series_and_scaffold_docs():
    """Yields (series_doc, scaffold_docs) pairs -- one series_doc and zero
    or more bucketed scaffold_docs per (sample, annotation_id)."""
    sample_files = sorted(f for f in os.listdir(TAXONOMY_DIR) if f.endswith(".tax.json"))

    for i, filename in enumerate(sample_files, start=1):
        sample_name = filename.removesuffix(".tax.json")
        path = os.path.join(TAXONOMY_DIR, filename)

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
                "name":            annotation_id,
                "category":        entry.get("category"),
                "depth":           entry.get("depth"),
                "parent":          entry.get("parent"),
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
