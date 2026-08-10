"""
manifest.py
------------
Lightweight ingestion-run tracking for the new split-collection Mongo
schema (annotation_series + scaffolds -- see MONGODB_MIGRATION_FOLLOWUP.md
Phase 3, and the 2026-07-28 session notes in project memory for why the
split happened).

Deliberately scoped down from the full staging-collection/blue-green
design in the mentor review -- this is a single-developer project doing
occasional re-ingestion, not a team running frequent automated pipelines.
What this DOES provide: every ingestion run is recorded with its real
counts and a duplicate-key check, and isn't distinguishable as trustworthy
until explicitly marked "ready" -- so a partial or bad run can't be
silently mistaken for a good one.

Uses plain pymongo (sync) to match the existing migration scripts.
"""

from datetime import datetime, timezone


def start_ingestion(db, dataset_version: str, source: str) -> None:
    """Record the start of a new ingestion run for one source."""
    db.dataset_manifest.insert_one({
        "dataset_version":      dataset_version,
        "source":               source,
        "status":               "building",
        "created_at":           datetime.now(timezone.utc),
        "activated_at":         None,
        "counts":               {},
        "duplicate_keys_found": None,
    })


def count_duplicate_keys(db, dataset_version: str, source: str) -> int:
    """
    (source, annotation_id, sample_name) must be unique within
    annotation_series for one dataset_version -- the same check run
    manually against the legacy collection during Phase 0 (found 0
    duplicates there), now automated for every future ingestion.
    """
    pipeline = [
        {"$match": {"dataset_version": dataset_version, "source": source}},
        {"$group": {
            "_id":   {"annotation_id": "$annotation_id", "sample_name": "$sample_name"},
            "count": {"$sum": 1},
        }},
        {"$match": {"count": {"$gt": 1}}},
        {"$count": "duplicates"},
    ]
    result = list(db.annotation_series.aggregate(pipeline, allowDiskUse=True))
    return result[0]["duplicates"] if result else 0


def validate_and_finish(
    db,
    dataset_version: str,
    source: str,
    expected_series_count: int,
    expected_scaffold_entries: int,
) -> dict:
    """
    Checks a just-completed ingestion against expected counts and the
    duplicate-key invariant, marks the manifest entry "ready" or "failed"
    accordingly, and returns the validation summary.
    """
    actual_series_count = db.annotation_series.count_documents(
        {"dataset_version": dataset_version, "source": source}
    )

    scaffold_bucket_count = db.scaffolds.count_documents(
        {"dataset_version": dataset_version, "source": source}
    )
    entries_pipeline = [
        {"$match": {"dataset_version": dataset_version, "source": source}},
        {"$project": {"n": {"$size": "$scaffolds"}}},
        {"$group": {"_id": None, "total": {"$sum": "$n"}}},
    ]
    entries_result = list(db.scaffolds.aggregate(entries_pipeline, allowDiskUse=True))
    actual_scaffold_entries = entries_result[0]["total"] if entries_result else 0

    duplicates = count_duplicate_keys(db, dataset_version, source)

    passed = (
        actual_series_count == expected_series_count
        and actual_scaffold_entries == expected_scaffold_entries
        and duplicates == 0
    )

    db.dataset_manifest.update_one(
        {"dataset_version": dataset_version, "source": source},
        {"$set": {
            "status":               "ready" if passed else "failed",
            "activated_at":         datetime.now(timezone.utc) if passed else None,
            "counts": {
                "annotation_series": actual_series_count,
                "scaffold_buckets":  scaffold_bucket_count,
                "scaffold_entries":  actual_scaffold_entries,
            },
            "duplicate_keys_found": duplicates,
        }},
    )

    return {
        "passed":                     passed,
        "expected_series_count":      expected_series_count,
        "actual_series_count":        actual_series_count,
        "expected_scaffold_entries":  expected_scaffold_entries,
        "actual_scaffold_entries":    actual_scaffold_entries,
        "scaffold_bucket_count":      scaffold_bucket_count,
        "duplicate_keys_found":       duplicates,
    }
