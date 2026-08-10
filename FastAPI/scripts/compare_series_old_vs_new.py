"""
compare_series_old_vs_new.py
------------------------------
One-off verification: confirms the new split-collection query
(get_annotation_series_split, reading from annotation_series) produces
identical /series/annotations route output to the current live query
(get_annotation_series_mongo, reading from the legacy "annotations"
collection) -- before the live route is switched over to use it.

Reproduces the exact response shape the /series/annotations Mongo branch
builds today (see api/routes.py, DATA_BACKEND == "mongo" branch: name,
egc, norm_egc, and a 4-field "value" sub-object -- note this is narrower
than the JSON backend's "value", which keeps every field except
scaffolds; that's a pre-existing inconsistency between the two backends,
not something introduced here, and this script deliberately matches
today's live Mongo behavior rather than "fixing" it).

Checks a spread of real annotation_ids per source: a few known anchors
already spot-checked in Phase 0 / the enzyme pilot (COG0055, 3.6.1.23,
Bacteria -- the 485,842-scaffold outlier), plus several more sampled
directly from real data so nothing is guessed.

Usage (from FastAPI/):
    python scripts/compare_series_old_vs_new.py
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


def build_result(doc, source, annotation_id):
    """Mirrors the exact per-sample result dict built in the
    /series/annotations Mongo branch in api/routes.py."""
    value_out = {
        "name":     doc.get("name"),
        "category": doc.get("category"),
        "egc":      doc.get("egc"),
        "norm_egc": doc.get("norm_egc"),
    }
    return {
        "source":        source,
        "sample":        doc["sample_name"],
        "annotation_id": annotation_id,
        "name":          doc.get("name"),
        "egc":           doc.get("egc"),
        "norm_egc":      doc.get("norm_egc"),
        "value":         value_out,
    }


async def pick_sample_ids(db, source, n):
    """Grabs n real annotation_ids for a source via the new index (fast,
    no full collection scan) rather than guessing IDs that might not exist."""
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

            old_by_sample = {d["sample_name"]: build_result(d, source, annotation_id) for d in old_docs}
            new_by_sample = {d["sample_name"]: build_result(d, source, annotation_id) for d in new_docs}

            if set(old_by_sample) != set(new_by_sample):
                only_old = set(old_by_sample) - set(new_by_sample)
                only_new = set(new_by_sample) - set(old_by_sample)
                print(f"MISMATCH sample sets for {source}/{annotation_id}: "
                      f"old={len(old_by_sample)} new={len(new_by_sample)} "
                      f"only_in_old={only_old} only_in_new={only_new}")
                mismatches += 1
                continue

            local_mismatch = False
            for sample, old_result in old_by_sample.items():
                new_result = new_by_sample[sample]
                total_checked += 1
                if old_result != new_result:
                    print(f"MISMATCH {source}/{annotation_id}/{sample}:")
                    print(f"  old: {old_result}")
                    print(f"  new: {new_result}")
                    mismatches += 1
                    local_mismatch = True

            status = "MISMATCH" if local_mismatch else "OK"
            print(f"{source}/{annotation_id}: {len(old_by_sample)} samples compared -- {status}")

    print()
    print(f"Total per-sample results compared: {total_checked}")
    print(f"Mismatches: {mismatches}")
    print("PASSED" if mismatches == 0 else "FAILED")

    close_mongo_connection(client)


if __name__ == "__main__":
    asyncio.run(main())
