"""
create_split_indexes.py
-------------------------
One-off setup: creates the indexes the new split-collection schema
(annotation_series + scaffolds) was designed around -- see
migrate_enzyme_split.py and MONGODB_MIGRATION_FOLLOWUP.md Phase 3.

Without these, every query against the new collections is a full
collection scan across millions of documents -- the same problem
scripts/create_indexes.py exists to prevent for the legacy "annotations"
collection.

Safe to re-run: Mongo just confirms an identical index already exists
rather than erroring or duplicating it.

Usage (from FastAPI/):
    python scripts/create_split_indexes.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pymongo import ASCENDING, MongoClient

from api.config import MONGO_URI, MONGO_DB_NAME


def main():
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB_NAME]

    print("annotation_series indexes:")
    name = db.annotation_series.create_index(
        [("dataset_version", ASCENDING), ("source", ASCENDING),
         ("annotation_id", ASCENDING), ("sample_name", ASCENDING)],
        unique=True,
    )
    print(f"  created/confirmed (unique): {name}")

    name = db.annotation_series.create_index(
        [("dataset_version", ASCENDING), ("sample_name", ASCENDING), ("source", ASCENDING)]
    )
    print(f"  created/confirmed: {name}")

    print("scaffolds indexes:")
    name = db.scaffolds.create_index(
        [("dataset_version", ASCENDING), ("source", ASCENDING),
         ("annotation_id", ASCENDING), ("sample_name", ASCENDING), ("bucket_index", ASCENDING)],
        unique=True,
    )
    print(f"  created/confirmed (unique): {name}")

    print("\nannotation_series indexes now:")
    for n, spec in db.annotation_series.index_information().items():
        print(f"  {n}: {spec['key']}")
    print("scaffolds indexes now:")
    for n, spec in db.scaffolds.index_information().items():
        print(f"  {n}: {spec['key']}")

    client.close()


if __name__ == "__main__":
    main()
