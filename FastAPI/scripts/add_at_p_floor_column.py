"""
add_at_p_floor_column.py
===========================
One-time migration for a database created BEFORE correlations_cache
gained its `at_p_floor` column (see create_sql_schema.py). A fresh schema creates the column directly --
this script is only for a database that already has correlations_cache
without it.

Deliberately does NOT backfill existing rows: whether a cached
circular_shift p-value was forced to its pair-specific resolution limit
is only known at the moment the permutation test actually runs, and
recomputing that for every already-cached pair means re-running the
expensive permutation test itself (the whole reason this cache exists).
Existing rows stay NULL ("unknown," genuinely not computed with this
disclosure) rather than being guessed at -- new computations populate
it going forward; see correlation_sql.py's _circular_shift_pvalue.

Idempotent: no-ops if the column already exists.

Run:
    python scripts/add_at_p_floor_column.py
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error


def _has_at_p_floor_column(conn: sqlite3.Connection) -> bool:
    cols = [row[1] for row in conn.execute("PRAGMA table_info(correlations_cache)").fetchall()]
    return "at_p_floor" in cols


def main(db_path: str = SQLITE_DB_PATH) -> None:
    conn = sqlite3.connect(db_path)
    try:
        if _has_at_p_floor_column(conn):
            print("correlations_cache.at_p_floor already exists -- skipping")
            return
        conn.execute("ALTER TABLE correlations_cache ADD COLUMN at_p_floor INTEGER")
        conn.commit()
        print("correlations_cache.at_p_floor added")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
    print(f"Done at {SQLITE_DB_PATH}")
