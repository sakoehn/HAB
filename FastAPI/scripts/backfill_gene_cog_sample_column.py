"""
backfill_gene_cog_sample_column.py
====================================
One-time migration for a database created BEFORE gene_cog/gene_enzyme
gained their own `sample` column (create_sql_schema.py,
migrate_mappings_to_sql.py). A fresh migration populates `sample`
directly during insert -- this script is only for a database that
already has data without it.

Adds the column, backfills it from mappings.sample via mapping_id, then
lets create_sql_indexes.py build the composite (cog_id, sample)/
(ec_id, sample) indexes and drop the now-redundant single-column ones.

Idempotent: skips a table if it already has a `sample` column.

Real numbers this was sized against (found live in production,
2026-09-25 -- see create_sql_indexes.py's module docstring for the full
story): COG2801 took 55.0s without this fix. Local validation (same real
59GB db): gene_cog backfill 41.3s + index build 46.5s; gene_enzyme is
roughly half gene_cog's row count (24.8M vs 50.6M), so proportionally
faster. Production disk has measured 5-10x slower than local throughout
this investigation -- expect minutes, not tens of seconds, per table.

Run:
    python scripts/backfill_gene_cog_sample_column.py
"""

import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error


def _has_sample_column(conn: sqlite3.Connection, table: str) -> bool:
    cols = [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return "sample" in cols


def backfill_table(conn: sqlite3.Connection, table: str, id_col: str) -> None:
    """Add and populate `sample` on one junction table, if not already present."""
    if _has_sample_column(conn, table):
        print(f"{table}.sample already exists -- skipping")
        return

    t0 = time.time()
    conn.execute(f"ALTER TABLE {table} ADD COLUMN sample TEXT")
    conn.execute(f"""
        UPDATE {table} SET sample = (
            SELECT sample FROM mappings WHERE mappings.id = {table}.mapping_id
        )
    """)
    conn.commit()
    print(f"{table}: backfilled in {time.time() - t0:.1f}s")


def main(db_path: str = SQLITE_DB_PATH) -> None:
    conn = sqlite3.connect(db_path)
    try:
        backfill_table(conn, "gene_cog", "cog_id")
        backfill_table(conn, "gene_enzyme", "ec_id")
    finally:
        conn.close()


if __name__ == "__main__":
    start = time.time()
    main()
    print(f"Done in {time.time() - start:.1f}s at {SQLITE_DB_PATH}")
