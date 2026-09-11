"""
Tests for invalidate_correlations_cache() -- Phase F of the correlation
cache design. Full-table wipe, not selective, triggered at the end of a
migrate_annotations_to_sql.py run.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from scripts.migrate_annotations_to_sql import invalidate_correlations_cache  # noqa: E402

SCHEMA = """
CREATE TABLE correlations_cache(
    id INTEGER PRIMARY KEY,
    catalog_id_a INTEGER NOT NULL,
    catalog_id_b INTEGER NOT NULL,
    r REAL NOT NULL,
    metric TEXT NOT NULL,
    method TEXT NOT NULL,
    lag_samples INTEGER NOT NULL,
    p_value REAL NOT NULL,
    n_pairs INTEGER NOT NULL
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.execute(SCHEMA)
    connection.commit()
    yield connection
    connection.close()


def insert_row(conn, catalog_id_a, catalog_id_b):
    conn.execute(
        "INSERT INTO correlations_cache "
        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs) "
        "VALUES (?, ?, 0.5, 'egc', 'spearman', 0, 0.01, 50)",
        (catalog_id_a, catalog_id_b),
    )
    conn.commit()


def test_wipes_all_rows(conn):
    insert_row(conn, 1, 2)
    insert_row(conn, 1, 3)
    insert_row(conn, 2, 3)

    invalidate_correlations_cache(conn)

    remaining = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
    assert remaining == 0


def test_returns_count_deleted(conn):
    insert_row(conn, 1, 2)
    insert_row(conn, 1, 3)

    deleted = invalidate_correlations_cache(conn)

    assert deleted == 2


def test_no_op_on_empty_cache(conn):
    deleted = invalidate_correlations_cache(conn)

    assert deleted == 0
    remaining = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
    assert remaining == 0


def test_safe_to_call_twice_in_a_row(conn):
    insert_row(conn, 1, 2)

    first = invalidate_correlations_cache(conn)
    second = invalidate_correlations_cache(conn)

    assert first == 1
    assert second == 0
