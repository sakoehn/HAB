"""
migrate_cog_paths_to_sql.py
=============================
Populates `cog_paths` (see create_sql_schema.py) -- one row per real
(category letter, COG id) membership, parsed directly from
DataStructures/COG/cog_categories.json.

E17 (docs/AUDIT-2026-09-22.md): a COG id can belong to more than one of
NCBI's 26 categories (confirmed: 400 of ~5,000 COGs). cog_categories.json
is written by EGC_COG_TREE.ipynb's scraping cell and already contains one
row per real membership -- unlike the original version of this script,
this does NOT read annotation_catalog.parent, which is a single TEXT
column and can only ever express one category per COG. That mirrors how
migrate_kegg_paths_to_sql.py reads ko00001.keg directly instead of
annotation_catalog's single-valued parent column, for the same reason
(KEGG nodes can have multiple real parents too, see E14/CR3).

annotation_catalog is still used as the "is this COG id actually real in
our dataset" filter -- a membership row is only kept if its COG id is a
real depth=2 leaf in annotation_catalog(source='cog').

IMPORTANT: both annotation_catalog and cog_categories.json must be current
before running this -- if annotation_catalog still reflects a stale/pre-fix
regeneration, this script will find zero real COG ids to keep and produce
an empty table. Run migrate_annotations_to_sql.py +
migrate_annotation_catalog_sql.py first if there's any doubt.

Safe to re-run: DELETE-then-reinsert on every run, same reasoning as
migrate_kegg_paths_to_sql.py -- this table isn't scoped per-sample, so
there's no partial-update case worth optimizing for.

Usage (from FastAPI/):
    python scripts/migrate_cog_paths_to_sql.py
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import COG_DIR, SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error

COG_CATEGORIES_FILE = os.path.join(COG_DIR, "cog_categories.json")


def load_real_cog_leaf_ids(conn: sqlite3.Connection) -> set[str]:
    """Return every COG id that's actually a real depth=2 leaf in this
    dataset -- i.e. present in annotation_catalog, meaning at least one
    real gene's rollup reached it in at least one sample.

    Args:
        conn: Open SQLite connection.

    Returns:
        Set of COG id strings (e.g. "COG0055").
    """
    cursor = conn.execute(
        "SELECT annotation_id FROM annotation_catalog WHERE source='cog' AND depth=2"
    )
    return {row[0] for row in cursor.fetchall()}


def iter_cog_path_rows(categories_file_path: str, valid_leaf_ids: set[str]):
    """Read cog_categories.json and yield one row dict per (category, COG)
    membership whose COG id is in `valid_leaf_ids`.

    Args:
        categories_file_path: Path to cog_categories.json (written by
            EGC_COG_TREE.ipynb).
        valid_leaf_ids: Real COG leaf ids from load_real_cog_leaf_ids() --
            a membership row is only yielded if its b_id is in this set.

    Yields:
        Dicts with keys a_id, a_name (category letter, category name),
        b_id, b_name (COG id, COG name), and full_path ("a_id|b_id").
    """
    with open(categories_file_path, encoding="utf-8") as f:
        rows = json.load(f)

    for row in rows:
        if row["b_id"] not in valid_leaf_ids:
            continue
        yield {
            "a_id": row["a_id"], "a_name": row["a_name"],
            "b_id": row["b_id"], "b_name": row["b_name"],
            "full_path": f"{row['a_id']}|{row['b_id']}",
        }


def populate_cog_paths(conn: sqlite3.Connection) -> int:
    """Rebuild cog_paths from cog_categories.json, filtered to real
    annotations.

    Args:
        conn: Open SQLite connection.

    Returns:
        Number of rows inserted.
    """
    valid_leaf_ids = load_real_cog_leaf_ids(conn)
    rows = list(iter_cog_path_rows(COG_CATEGORIES_FILE, valid_leaf_ids))

    cursor = conn.cursor()
    cursor.execute("DELETE FROM cog_paths")
    cursor.executemany(
        """
        INSERT INTO cog_paths (a_id, a_name, b_id, b_name, full_path)
        VALUES (:a_id, :a_name, :b_id, :b_name, :full_path)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def main():
    """Rebuild cog_paths and print the resulting row count."""
    conn = sqlite3.connect(SQLITE_DB_PATH)
    try:
        count = populate_cog_paths(conn)
        print(f"Done. {count} rows in cog_paths.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
