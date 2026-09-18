"""
migrate_cog_paths_to_sql.py
=============================
Populates `cog_paths` (see create_sql_schema.py) -- one row per real COG
id, joining its category letter+name (depth=1) to its own id+name
(depth=2), read entirely from `annotation_catalog` (source='cog').

Unlike KEGG/Enzyme, COG has no downloadable BRITE-style reference file to
parse -- the category assignment for each COG id is scraped from NCBI
per-category pages inside EGC_COG_TREE.ipynb itself (see project memory,
E15) and already baked into the regenerated annotation JSONs.
annotation_catalog is therefore both the source of truth AND the
real-ids filter here, not just a validity filter the way it is for
migrate_kegg_paths_to_sql.py / migrate_enzyme_paths_to_sql.py.

COG's hierarchy is exactly 2 levels (category -> specific COG id), not 4
-- a category letter has no further real subdivision the way KEGG
pathways or EC numbers do.

A depth=2 COG row's own `parent` column (see
migrate_annotations_to_sql.build_annotation_series_row) holds the
category's own letter/id (e.g. "C"), not its display name -- CR3
(docs/AUDIT.md) switched this from parent_name to parent_id for
kegg/enzyme/cog alike, specifically so parent always matches another
row's own annotation_id (needed by both the correlation family-exclusion
tree-walk and this join). So the join below is a plain id-to-id match:
category.annotation_id = cog.parent.

IMPORTANT: annotation_catalog must be current before running this -- if
it still reflects a stale/pre-fix regeneration, this script will find
zero depth=1 category rows to join against (they didn't exist before the
E15 fix was resynced) and produce an empty table. Run
migrate_annotations_to_sql.py + migrate_annotation_catalog_sql.py first
if there's any doubt.

Safe to re-run: DELETE-then-reinsert on every run, same reasoning as
migrate_kegg_paths_to_sql.py -- this table isn't scoped per-sample, so
there's no partial-update case worth optimizing for.

Usage (from FastAPI/):
    python scripts/migrate_cog_paths_to_sql.py
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error


def iter_cog_path_rows(conn: sqlite3.Connection):
    """Join every real depth=2 COG id to its depth=1 category, both read
    from annotation_catalog(source='cog').

    Args:
        conn: Open SQLite connection.

    Yields:
        Dicts with keys a_id, a_name (category letter, category name),
        b_id, b_name (COG id, COG name), and full_path ("a_id|b_id").
    """
    query = """
        SELECT category.annotation_id, category.name, cog.annotation_id, cog.name
        FROM annotation_catalog AS cog
        JOIN annotation_catalog AS category
            ON category.source = 'cog' AND category.depth = 1 AND category.annotation_id = cog.parent
        WHERE cog.source = 'cog' AND cog.depth = 2
    """
    for a_id, a_name, b_id, b_name in conn.execute(query):
        yield {
            "a_id": a_id, "a_name": a_name,
            "b_id": b_id, "b_name": b_name,
            "full_path": f"{a_id}|{b_id}",
        }


def populate_cog_paths(conn: sqlite3.Connection) -> int:
    """Rebuild cog_paths from annotation_catalog.

    Args:
        conn: Open SQLite connection.

    Returns:
        Number of rows inserted.
    """
    rows = list(iter_cog_path_rows(conn))

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
