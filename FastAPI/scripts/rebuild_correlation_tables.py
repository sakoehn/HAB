"""
rebuild_correlation_tables.py
=============================
One-time move of an existing database to the correlation tables with
method_version, plus the new correlations_unscored table (see
create_sql_schema.py).

SQLite can't change a table's UNIQUE rule in place, and method_version has
to be part of it. Both tables hold only results that are recomputed on the
next request, so they are dropped and created fresh from SCHEMA instead of
copied. No other table is touched.

Running it again on a database that already has the new layout does
nothing.

Usage (stop the web service first on the server):
    python FastAPI/scripts/rebuild_correlation_tables.py
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error
from scripts.create_sql_schema import SCHEMA  # pylint: disable=wrong-import-position,import-error


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone() is not None


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] if _table_exists(conn, table) else 0


def rebuild_correlation_tables(conn: sqlite3.Connection) -> dict:
    """Drop and recreate correlations_cache and correlations_unscored unless
    the database already has the new layout. Returns what was done."""
    has_version = "method_version" in [row[1] for row in conn.execute("PRAGMA table_info(correlations_cache)")]
    if has_version and _table_exists(conn, "correlations_unscored"):
        return {"rebuilt": False, "cache_rows_dropped": 0, "unscored_rows_dropped": 0}

    cache_rows = _row_count(conn, "correlations_cache")
    unscored_rows = _row_count(conn, "correlations_unscored")
    conn.execute("DROP TABLE IF EXISTS correlations_cache")
    conn.execute("DROP TABLE IF EXISTS correlations_unscored")
    conn.commit()
    # Every statement in SCHEMA is IF NOT EXISTS, so this only creates the
    # two tables (and their indexes) just dropped.
    conn.executescript(SCHEMA)
    conn.commit()
    return {"rebuilt": True, "cache_rows_dropped": cache_rows, "unscored_rows_dropped": unscored_rows}


if __name__ == "__main__":
    connection = sqlite3.connect(SQLITE_DB_PATH)
    try:
        print(rebuild_correlation_tables(connection))
    finally:
        connection.close()
