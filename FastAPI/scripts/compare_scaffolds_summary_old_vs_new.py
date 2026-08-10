"""
compare_scaffolds_summary_old_vs_new.py
------------------------------------------
One-off verification: confirms the new path for /annotations/scaffolds/
summary (reading precomputed scaffold_count/gene_count fields off
annotation_series -- never touching the "scaffolds" collection at all)
produces identical (sample, scaffold_count, gene_count) results to the
current live logic (computing them from the legacy embedded scaffold
dict), before the live route is switched over.

Same real annotation_ids as compare_series_old_vs_new.py, for the same
reason: known anchors already spot-checked, plus a few sampled directly
from real data.

Usage (from FastAPI/):
    python scripts/compare_scaffolds_summary_old_vs_new.py
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.db import connect_to_mongo, close_mongo_connection
from api.cache_mongo import get_annotation_series_mongo, get_annotation_series_split

DATASET_VERSION = "2026-07-28-01"

KNOWN_ANCHOR_IDS = {
    "cog":      ["COG0055"],
    "enzyme":   ["3.6.1.23"],
    "taxonomy": ["Bacteria"],
    "kegg":     [],
}
SAMPLE_COUNT_PER_SOURCE = 5


async def pick_sample_ids(db, source, n):
    cursor = db.annotation_series.find(
        {"dataset_version": DATASET_VERSION, "source": source},
        {"annotation_id": 1},
    ).limit(500)
    seen = []
    async for doc in cursor:
        aid = doc["annotation_id"]
        if aid not in seen:
            seen.append(aid)
        if len(seen) >= n:
            break
    return seen


def old_summary_rows(docs):
    rows = {}
    for doc in docs:
        scaffolds = doc.get("scaffolds") or {}
        if not scaffolds:
            continue
        rows[doc["sample_name"]] = (len(scaffolds), sum(scaffolds.values()))
    return rows


def new_summary_rows(docs):
    rows = {}
    for doc in docs:
        if not doc.get("scaffold_count"):
            continue
        rows[doc["sample_name"]] = (doc["scaffold_count"], doc["gene_count"])
    return rows


async def main():
    client, db = connect_to_mongo()

    total_checked = 0
    mismatches = 0

    for source in ["cog", "kegg", "enzyme", "taxonomy"]:
        ids = list(KNOWN_ANCHOR_IDS[source])
        sampled = await pick_sample_ids(db, source, SAMPLE_COUNT_PER_SOURCE)
        for aid in sampled:
            if aid not in ids:
                ids.append(aid)

        for annotation_id in ids:
            old_docs = await get_annotation_series_mongo(db, source, annotation_id)
            new_docs = await get_annotation_series_split(db, source, annotation_id, DATASET_VERSION)

            old_rows = old_summary_rows(old_docs)
            new_rows = new_summary_rows(new_docs)

            if set(old_rows) != set(new_rows):
                only_old = set(old_rows) - set(new_rows)
                only_new = set(new_rows) - set(old_rows)
                print(f"MISMATCH sample sets {source}/{annotation_id}: only_old={only_old} only_new={only_new}")
                mismatches += 1
                continue

            local_mismatch = False
            for sample, old_val in old_rows.items():
                total_checked += 1
                if old_val != new_rows[sample]:
                    print(f"MISMATCH {source}/{annotation_id}/{sample}: old={old_val} new={new_rows[sample]}")
                    mismatches += 1
                    local_mismatch = True

            print(f"{source}/{annotation_id}: {len(old_rows)} samples -- {'MISMATCH' if local_mismatch else 'OK'}")

    print()
    print(f"Total per-sample summaries compared: {total_checked}")
    print(f"Mismatches: {mismatches}")
    print("PASSED" if mismatches == 0 else "FAILED")

    close_mongo_connection(client)


if __name__ == "__main__":
    asyncio.run(main())
