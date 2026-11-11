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

# The real table definitions, so this test can't drift from the db.
from scripts.create_sql_schema import SCHEMA  # noqa: E402


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    connection.commit()
    yield connection
    connection.close()


def insert_row(conn, catalog_id_a, catalog_id_b):
    conn.execute(
        "INSERT INTO correlations_cache "
        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs, method_version) "
        "VALUES (?, ?, 0.5, 'egc', 'spearman', 0, 0.01, 50, 1)",
        (catalog_id_a, catalog_id_b),
    )
    conn.commit()


def insert_unscored_row(conn, catalog_id_a, catalog_id_b):
    conn.execute(
        "INSERT INTO correlations_unscored "
        "(catalog_id_a, catalog_id_b, metric, method, method_version, reason, max_shared) "
        "VALUES (?, ?, 'egc', 'spearman', 1, 'too_few_points', 4)",
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


def test_also_wipes_the_unscored_pairs(conn):
    # A pair that couldn't be scored before a data change might be
    # scorable after it, so the "unscored" record is cleared too.
    insert_row(conn, 1, 2)
    insert_unscored_row(conn, 1, 3)
    insert_unscored_row(conn, 2, 3)

    deleted = invalidate_correlations_cache(conn)

    assert deleted == 3
    assert conn.execute("SELECT COUNT(*) FROM correlations_unscored").fetchone()[0] == 0
