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

Counts alone can't catch wrong VALUES --
every egc/norm_egc in the db could be wrong and the counts would still
match. So for every sample file it also compares each annotation's
egc/norm_egc against that same (source, sample)'s db rows, with a tight
relative tolerance (VALUE_REL_TOL) to absorb float round-trip noise only,
and its scaffold_count/gene_count exactly (the scaffold panels read them).
Annotations present on one side but not the other are reported too.

What this does NOT prove: that the source JSON files are themselves
current. It checks db == JSON, so a stale JSON file and a
db faithfully copied from it would still match.

Processes one sample file at a time (never holds more than one parsed
JSON file in memory at once) -- taxonomy files run up to ~197MB each,
12.35GB total across the source, so this matters for keeping the
process's own footprint small regardless of overall system health.

Usage (from FastAPI/):
    python scripts/verify_annotations_migration_against_json.py
"""

import json
import math
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

# Relative tolerance for egc/norm_egc: far looser than float round-trip
# noise (~1e-16), far tighter than any real migration bug would produce.
VALUE_REL_TOL = 1e-9

# How many example value mismatches to print per source.
MAX_EXAMPLES = 5


def _values_match(json_val, sql_val) -> bool:
    """None only matches None; numbers match within VALUE_REL_TOL. NaN
    never matches anything (math.isclose returns False for it)."""
    if json_val is None or sql_val is None:
        return json_val is None and sql_val is None
    return math.isclose(json_val, sql_val, rel_tol=VALUE_REL_TOL, abs_tol=0.0)


def compare_values(data: dict, sql_rows: dict) -> list:
    """Compare one sample's parsed JSON against that sample's db values.

    Args:
        data: Parsed per-sample JSON, {annotation_id: entry}.
        sql_rows: {annotation_id: (egc, norm_egc, scaffold_count,
            gene_count)} from values_from_sql().

    Returns:
        Sorted list of (annotation_id, field, json_value, sql_value) for
        every disagreement. field is "egc", "norm_egc", "scaffold_count",
        "gene_count", "missing_in_sql" or "missing_in_json" (the last two
        carry None, None as values). The two counts come from the JSON's
        scaffolds map, the same way the migration derives them.
    """
    mismatches = []
    for annotation_id in sorted(set(data) | set(sql_rows)):
        if annotation_id not in sql_rows:
            mismatches.append((annotation_id, "missing_in_sql", None, None))
            continue
        if annotation_id not in data:
            mismatches.append((annotation_id, "missing_in_json", None, None))
            continue
        entry = data[annotation_id]
        sql_egc, sql_norm, sql_scaffolds, sql_genes = sql_rows[annotation_id]
        for field, json_val, sql_val in (
            ("egc", entry.get("egc"), sql_egc),
            ("norm_egc", entry.get("norm_egc"), sql_norm),
        ):
            if not _values_match(json_val, sql_val):
                mismatches.append((annotation_id, field, json_val, sql_val))
        scaffolds = entry.get("scaffolds") or {}
        for field, json_val, sql_val in (
            ("scaffold_count", len(scaffolds), sql_scaffolds),
            ("gene_count", sum(scaffolds.values()), sql_genes),
        ):
            if json_val != sql_val:
                mismatches.append((annotation_id, field, json_val, sql_val))
    return mismatches


def values_from_sql(conn: sqlite3.Connection, source: str, sample: str) -> dict:
    """{annotation_id: (egc, norm_egc, scaffold_count, gene_count)} for one
    (source, sample) pair."""
    return {
        annotation_id: (egc, norm_egc, scaffold_count, gene_count)
        for annotation_id, egc, norm_egc, scaffold_count, gene_count in conn.execute(
            "SELECT annotation_id, egc, norm_egc, scaffold_count, gene_count FROM annotation_series "
            "WHERE source = ? AND sample = ?",
            (source, sample),
        )
    }


def count_from_json(
    source_dir: str, suffix: str, conn: sqlite3.Connection, source: str
) -> tuple[int, int, int, list]:
    """Recompute row counts directly from the raw per-sample JSON files,
    one file at a time (never holds more than one parsed file in memory),
    and compare each file's egc/norm_egc and scaffold/gene counts against
    the db while it's loaded.

    Args:
        source_dir: Directory containing this source's per-sample JSON
            files.
        suffix: Filename suffix identifying this source's files.
        conn: Open SQLite connection (for the per-sample value check).
        source: Annotation source ("cog", "kegg", "enzyme", "taxonomy").

    Returns:
        (sample_count, annotation_series_count, scaffolds_count,
        value_mismatches) -- value_mismatches is a list of
        (sample, annotation_id, field, json_value, sql_value).
    """
    sample_count = 0
    series_count = 0
    scaffolds_count = 0
    value_mismatches = []

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

        sample = filename[:-len(suffix)]
        for mismatch in compare_values(data, values_from_sql(conn, source, sample)):
            value_mismatches.append((sample, *mismatch))

        del data

    return sample_count, series_count, scaffolds_count, value_mismatches


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
            json_samples, json_series, json_scaffolds, value_mismatches = count_from_json(
                source_dir, suffix, conn, source
            )
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

            values_ok = not value_mismatches
            all_match = all_match and values_ok
            print(f"  {'values':10s} {len(value_mismatches)} value/count mismatches  "
                  f"{'OK' if values_ok else 'MISMATCH'}")
            for sample, annotation_id, field, json_val, sql_val in value_mismatches[:MAX_EXAMPLES]:
                print(f"    {sample} {annotation_id} {field}: json={json_val!r} sql={sql_val!r}")
            print(f"  (json-side recount took {elapsed:.1f}s)")
            print()
    finally:
        conn.close()

    print("=" * 60)
    print("ALL SOURCES MATCH" if all_match else "MISMATCHES FOUND -- see above")


if __name__ == "__main__":
    main()
