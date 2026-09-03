"""
migrate_annotation_catalog_sql.py
==================================
Populates `annotation_catalog` (see create_sql_schema.py) -- one
pre-aggregated row per (source, annotation_id) -- from `annotation_series`.
cache_sql.get_search_annotations() queries this table instead of
aggregating annotation_series directly, since it backs the interactive
/search/annotations route.

Usage (from FastAPI/):
    python scripts/migrate_annotation_catalog_sql.py
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error

def populate_annotation_catalog(conn: sqlite3.Connection) -> int:
    """Rebuild annotation_catalog from a GROUP BY aggregation over
    annotation_series.

    Args:
        conn: Open SQLite connection.

    Returns:
        Number of rows inserted.
    """
    conn.execute("DELETE FROM annotation_catalog")

    rows = conn.execute("""
        SELECT source, annotation_id,
               MIN(name) AS name,
               MIN(parent) AS parent,
               MIN(depth) AS depth,
               AVG(egc) AS mean_egc,
               MAX(egc) AS max_egc,
               AVG(norm_egc) AS mean_norm_egc,
               MAX(norm_egc) AS max_norm_egc,
               COUNT(DISTINCT sample) AS sample_count
        FROM annotation_series
        GROUP BY source, annotation_id
    """).fetchall()

    conn.executemany(
        """
        INSERT INTO annotation_catalog
            (source, annotation_id, name, parent, depth, mean_egc, max_egc, mean_norm_egc, max_norm_egc, sample_count)
        VALUES (:source, :annotation_id, :name, :parent, :depth, :mean_egc, :max_egc, :mean_norm_egc, :max_norm_egc, :sample_count)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def main():
    """Rebuild annotation_catalog and print the resulting row count."""
    conn = sqlite3.connect(SQLITE_DB_PATH)
    try:
        count = populate_annotation_catalog(conn)
        print(f"Done. {count} rows in annotation_catalog.")
    finally:
        conn.close()

if __name__ == "__main__": main()
