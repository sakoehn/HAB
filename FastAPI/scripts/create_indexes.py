"""
create_indexes.py
------------------
One-off setup: creates the two compound indexes the annotations collection's
schema was designed around (see Step 5 notes) but never actually had.

Without these, every query is a full collection scan across several million
documents — the exact performance problem Mongo was supposed to fix in the
first place. Safe to re-run: Mongo just confirms an identical index already
exists rather than erroring or duplicating it.

Indexes:
    (source, annotation_id) — serves /series/annotations, /annotations/top,
                               /annotations/scaffolds
    (sample_name, source)   — serves /samples/{id}/cog, /samples/{id}/full
    (source, parent)        — serves /taxonomy/children. Added after
                               discovering that query took ~14.5s without
                               it — a real example of the exact problem
                               this whole script exists to prevent.

Usage (from FastAPI/):
    python scripts/create_indexes.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pymongo import MongoClient

from api.config import MONGO_URI, MONGO_DB_NAME


def main():
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB_NAME]

    print("Existing indexes before:")
    for name, spec in db.annotations.index_information().items():
        print(f"  {name}: {spec['key']}")

    name_1 = db.annotations.create_index([("source", 1), ("annotation_id", 1)])
    print(f"Created/confirmed index: {name_1}")

    name_2 = db.annotations.create_index([("sample_name", 1), ("source", 1)])
    print(f"Created/confirmed index: {name_2}")

    name_3 = db.annotations.create_index([("source", 1), ("parent", 1)])
    print(f"Created/confirmed index: {name_3}")

    print("\nAll indexes now:")
    for name, spec in db.annotations.index_information().items():
        print(f"  {name}: {spec['key']}")

    client.close()


if __name__ == "__main__":
    main()
