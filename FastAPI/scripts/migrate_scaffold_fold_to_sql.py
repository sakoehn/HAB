"""
migrate_scaffold_fold_to_sql.py
================================
Fills `scaffold_fold` and `sample_totals` (see create_sql_schema.py) from
each sample's Metagenome_Samples/<sample>/<sample>.a.depth.txt.

A gene's EGC is its scaffold's AvgFold, and an annotation's egc in
annotation_series is the sum of that over the annotation's genes. Storing
AvgFold per scaffold lets a query split that sum by taxon (or anything else
on `mappings`) without re-reading the depth files.

Only scaffolds with at least one gene in `mappings` are stored; no query can
reach the others. Needs `mappings` loaded first.

Safe to re-run: each sample's old rows are deleted before its new ones are
written, in one transaction per sample.

Usage (from FastAPI/):
    python scripts/migrate_scaffold_fold_to_sql.py
"""

import os
import sqlite3
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import METAGENOME_SAMPLES_DIR, SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error
from scripts.create_sql_schema import create_schema  # pylint: disable=wrong-import-position,import-error


def read_depth_file(path) -> dict[str, float]:
    """Read a JGI .a.depth.txt into {scaffold_id: AvgFold}.

    Follows Notebooks/All_Coverages.py: the header, blank lines and '#'
    lines are skipped, every other line must be "<id>\\t<number>" with an
    id starting with 'G', the scaffold is the first two '_' parts of the
    id, and the first value seen for a scaffold is kept.

    Raises:
        ValueError: on any other line, since skipping it would silently
            drop that scaffold's depth.
    """
    folds: dict[str, float] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or line == "ID\tAvgFold":
                continue
            parts = line.split("\t")
            if line[0] != "G" or len(parts) < 2:
                raise ValueError(f"{path}: unexpected line {line[:80]!r}")
            scaffold = "_".join(parts[0].split("_", 2)[:2])
            if scaffold not in folds:
                folds[scaffold] = float(parts[1])
    return folds


def load_sample(conn: sqlite3.Connection, sample: str, depth_path) -> tuple[int, float]:
    """Replace one sample's scaffold_fold and sample_totals rows.

    Args:
        conn: Open connection with `mappings` already filled for `sample`.
        sample: Sample ID.
        depth_path: That sample's .a.depth.txt.

    Returns:
        (scaffolds stored, weighted_total).

    Raises:
        KeyError: if a scaffold with a gene in `mappings` has no depth
            value (as weighted_totals.py does). Nothing is written then.
    """
    folds = read_depth_file(depth_path)
    genes_per_scaffold = Counter(
        row[0] for row in conn.execute("SELECT scaffold_id FROM mappings WHERE sample = ?", (sample,))
    )
    missing = [s for s in genes_per_scaffold if s not in folds]
    if missing:
        raise KeyError(f"{sample}: {len(missing)} mapped scaffolds have no depth, e.g. {missing[:3]}")

    rows = sorted((sample, s, folds[s]) for s in genes_per_scaffold)
    total = sum(count * folds[s] for s, count in genes_per_scaffold.items())

    with conn:
        conn.execute("DELETE FROM scaffold_fold WHERE sample = ?", (sample,))
        conn.execute("DELETE FROM sample_totals WHERE sample = ?", (sample,))
        conn.executemany("INSERT INTO scaffold_fold (sample, scaffold_id, avg_fold) VALUES (?, ?, ?)", rows)
        conn.execute("INSERT INTO sample_totals (sample, weighted_total) VALUES (?, ?)", (sample, total))
    return len(rows), total


def main():
    """Create the two tables if needed, then load every sample in `mappings`."""
    create_schema()
    conn = sqlite3.connect(SQLITE_DB_PATH)
    try:
        samples = [r[0] for r in conn.execute("SELECT DISTINCT sample FROM mappings ORDER BY sample")]
        if not samples:
            raise SystemExit("mappings is empty -- run migrate_mappings_to_sql.py first.")
        start = time.time()
        for i, sample in enumerate(samples, 1):
            path = os.path.join(METAGENOME_SAMPLES_DIR, sample, f"{sample}.a.depth.txt")
            count, total = load_sample(conn, sample, path)
            print(f"[{i}/{len(samples)}] {sample}: {count:,} scaffolds, total {total:,.0f} "
                  f"({time.time() - start:.0f}s)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
