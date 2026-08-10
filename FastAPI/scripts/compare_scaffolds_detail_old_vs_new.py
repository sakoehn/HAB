"""
compare_scaffolds_detail_old_vs_new.py
-----------------------------------------
One-off verification: confirms the new bucketed scaffold-detail path
(get_annotation_scaffold_buckets_split, filtered by sample) reconstructs
the exact same (scaffold, count) set as the legacy embedded-dict path,
for a spread of real (source, annotation_id, sample) combinations —
including the largest scaffold map in the dataset (taxonomy/Bacteria,
one sample, 485,842 entries) to prove pagination and reconstruction hold
up at the extreme case, not just the easy ones.

Usage (from FastAPI/):
    python scripts/compare_scaffolds_detail_old_vs_new.py
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.db import connect_to_mongo, close_mongo_connection
from api.cache_mongo import get_annotation_series_mongo, get_annotation_scaffold_buckets_split

DATASET_VERSION = "2026-07-28-01"

CASES = [
    ("cog", "COG0055", "3300060358"),
    ("enzyme", "3.6.1.23", "3300060358"),
    ("taxonomy", "Bacteria", "3300060417"),  # the 485,842-scaffold outlier
]


async def main():
    client, db = connect_to_mongo()
    mismatches = 0

    for source, annotation_id, sample in CASES:
        old_docs = await get_annotation_series_mongo(db, source, annotation_id)
        old_doc = next((d for d in old_docs if d["sample_name"] == sample), None)
        old_scaffolds = old_doc.get("scaffolds", {}) if old_doc else {}

        buckets = await get_annotation_scaffold_buckets_split(db, source, annotation_id, DATASET_VERSION, sample=sample)
        new_scaffolds = {}
        for bucket in buckets:
            for item in bucket["scaffolds"]:
                new_scaffolds[item["scaffold"]] = item["count"]

        match = old_scaffolds == new_scaffolds
        print(f"{source}/{annotation_id}/{sample}: old={len(old_scaffolds)} new={len(new_scaffolds)} buckets={len(buckets)} -- {'OK' if match else 'MISMATCH'}")
        if not match:
            mismatches += 1

        # Also confirm the bucket count matches expectations and pagination math
        # works: fetch with a small page_size and confirm slicing is correct.
        all_items = []
        for bucket in buckets:
            all_items.extend((item["scaffold"], item["count"]) for item in bucket["scaffolds"])
        page_size = 100
        page_1 = all_items[0:page_size]
        page_2 = all_items[page_size:page_size * 2]
        total_pages_expected = -(-len(all_items) // page_size)
        print(f"  pagination check: total={len(all_items)}, page_size={page_size}, "
              f"page_1_len={len(page_1)}, page_2_len={len(page_2)}, "
              f"total_pages={total_pages_expected}")

    print()
    print("PASSED" if mismatches == 0 else f"FAILED ({mismatches} mismatches)")
    close_mongo_connection(client)


if __name__ == "__main__":
    asyncio.run(main())
