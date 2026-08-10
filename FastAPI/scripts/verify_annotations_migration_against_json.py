"""
verify_annotations_migration_against_json.py
================================================
Full-dataset, independent verification of the annotation_series/scaffolds
SQL migration (migrate_annotations_to_sql.py) against the real source
JSON files --
DataStructures/{COG,Kegg,Enzyme,Taxonomy}/<sample>.<suffix>.json.

Deliberately does NOT import anything from migrate_annotations_to_sql.py
or cache_sql.py -- this script's own counting logic is written completely
independently, so a bug shared between the migration and this check
wouldn't just confirm itself. For each of the 4 sources, recomputes from
scratch (straight from disk, one file at a time):

  - sample_count      -- how many sample files exist for this source
  - annotation_series row count -- sum of len(data) across all samples
    (one row per (sample, annotation_id) pair)
  - scaffolds row count -- sum of len(entry["scaffolds"]) across every
    annotation entry in every sample

...and compares each against the real counts in hab_mappings.db.

Processes one sample file at a time (never holds more than one parsed
JSON file in memory at once) -- taxonomy files run up to ~197MB each,
12.35GB total across the source, so this matters for keeping the
process's own footprint small regardless of overall system health.

Usage (from FastAPI/):
    python scripts/verify_annotations_migration_against_json.py
"""

import json
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import COG_DIR, ENZYME_DIR, KEGG_DIR, SQLITE_DB_PATH, TAXONOMY_DIR

SOURCES = {
    "cog":      (COG_DIR, ".cog.json"),
    "kegg":     (KEGG_DIR, ".ko.json"),
    "enzyme":   (ENZYME_DIR, ".enzyme.json"),
    "taxonomy": (TAXONOMY_DIR, ".tax.json"),
}


def count_from_json(source_dir: str, suffix: str) -> tuple[int, int, int]:
    """Recompute row counts directly from the raw per-sample JSON files,
    one file at a time (never holds more than one parsed file in memory).

    Args:
        source_dir: Directory containing this source's per-sample JSON
            files.
        suffix: Filename suffix identifying this source's files.

    Returns:
        (sample_count, annotation_series_count, scaffolds_count).
    """
    sample_count = 0
    series_count = 0
    scaffolds_count = 0

    for filename in sorted(os.listdir(source_dir)):
        if not filename.endswith(suffix):
            continue
        with open(os.path.join(source_dir, filename), encoding="utf-8") as f:
            data = json.load(f)

        sample_count += 1
        series_count += len(data)
        for entry in data.values():
            scaffolds = entry.get("scaffolds") or {}
            scaffolds_count += len(scaffolds)

        del data

    return sample_count, series_count, scaffolds_count


def count_from_sql(conn: sqlite3.Connection, source: str) -> tuple[int, int, int]:
    """Read the same three counts for one source from the database.

    Args:
        conn: Open SQLite connection.
        source: Annotation source ("cog", "kegg", "enzyme", "taxonomy").

    Returns:
        (sample_count, annotation_series_count, scaffolds_count).
    """
    sample_count = conn.execute(
        "SELECT COUNT(DISTINCT sample) FROM annotation_series WHERE source = ?", (source,)
    ).fetchone()[0]
    series_count = conn.execute(
        "SELECT COUNT(*) FROM annotation_series WHERE source = ?", (source,)
    ).fetchone()[0]
    scaffolds_count = conn.execute(
        """
        SELECT COUNT(*) FROM scaffolds
        JOIN annotation_series ON scaffolds.annotation_series_id = annotation_series.id
        WHERE annotation_series.source = ?
        """,
        (source,),
    ).fetchone()[0]
    return sample_count, series_count, scaffolds_count


def main() -> None:
    """Compare JSON-recomputed and SQL counts for every source and print
    a per-source, per-metric OK/MISMATCH report."""
    conn = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    all_match = True

    try:
        for source, (source_dir, suffix) in SOURCES.items():
            print(f"=== {source} ===")
            start = time.time()
            json_samples, json_series, json_scaffolds = count_from_json(source_dir, suffix)
            elapsed = time.time() - start

            sql_samples, sql_series, sql_scaffolds = count_from_sql(conn, source)

            rows = [
                ("samples",   json_samples,   sql_samples),
                ("series",    json_series,    sql_series),
                ("scaffolds", json_scaffolds, sql_scaffolds),
            ]
            for label, json_val, sql_val in rows:
                ok = json_val == sql_val
                all_match = all_match and ok
                status = "OK" if ok else "MISMATCH"
                print(f"  {label:10s} json={json_val:>10} sql={sql_val:>10}  {status}")
            print(f"  (json-side recount took {elapsed:.1f}s)")
            print()
    finally:
        conn.close()

    print("=" * 60)
    print("ALL SOURCES MATCH" if all_match else "MISMATCHES FOUND -- see above")


if __name__ == "__main__":
    main()
