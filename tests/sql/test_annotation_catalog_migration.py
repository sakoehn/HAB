"""
test_annotation_catalog_migration.py
=======================================
Tests for populate_annotation_catalog() (FastAPI/scripts/migrate_annotation_catalog_sql.py).

annotation_catalog.id has no AUTOINCREMENT, so a DELETE+reinsert rebuild
can renumber every row -- ids restart at 1, in whatever order the GROUP BY
happens to emit them. correlations_cache is keyed on bare
catalog_id_a/catalog_id_b integers, so a cached pair computed against the
OLD ids would silently be served as a DIFFERENT pair's r/p/q after a
rebuild. populate_annotation_catalog must therefore clear correlations_cache
itself -- running migrate_annotation_catalog_sql.py on its own is the
documented recovery procedure after a COG-only path rebuild (see
migrate_cog_paths_to_sql.py's docstring).

Data-layer test: an in-memory sqlite connection with the real schema for
the three tables involved, no server.

Run:
    pytest tests/sql/test_annotation_catalog_migration.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from scripts.migrate_annotation_catalog_sql import populate_annotation_catalog  # noqa: E402

# The real table definitions, so this test can't drift from the db.
from scripts.create_sql_schema import SCHEMA  # noqa: E402


# pylint: disable=redefined-outer-name

@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    connection.commit()
    yield connection
    connection.close()


def insert_series(conn, source, annotation_id, sample, egc=10.0):
    conn.execute(
        "INSERT INTO annotation_series (source, sample, annotation_id, name, egc, norm_egc) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (source, sample, annotation_id, annotation_id, egc, egc / 1000),
    )
    conn.commit()


def insert_cached_pair(conn, catalog_id_a, catalog_id_b):
    conn.execute(
        "INSERT INTO correlations_cache "
        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs, method_version) "
        "VALUES (?, ?, 0.5, 'egc', 'spearman', 0, 0.01, 50, 1)",
        (catalog_id_a, catalog_id_b),
    )
    conn.commit()


def test_rebuild_clears_correlations_cache(conn):
    insert_series(conn, "kegg", "K00001", "s1")
    insert_series(conn, "kegg", "K00002", "s1")
    insert_cached_pair(conn, 1, 2)

    populate_annotation_catalog(conn)

    remaining = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
    assert remaining == 0, \
        "a catalog rebuild must wipe correlations_cache -- its keys can be renumbered by the rebuild"


def test_rebuild_still_clears_cache_when_cache_was_already_empty(conn):
    insert_series(conn, "kegg", "K00001", "s1")

    count = populate_annotation_catalog(conn)

    assert count == 1
    remaining = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
    assert remaining == 0


def test_rebuild_still_produces_correct_catalog_rows(conn):
    # The cache-clear must not interfere with the catalog rebuild itself --
    # same aggregation this migration always did.
    insert_series(conn, "kegg", "K00001", "s1", egc=10.0)
    insert_series(conn, "kegg", "K00001", "s2", egc=30.0)
    insert_series(conn, "cog", "COG0001", "s1", egc=5.0)

    count = populate_annotation_catalog(conn)

    assert count == 2
    row = conn.execute(
        "SELECT mean_egc, max_egc, sample_count FROM annotation_catalog "
        "WHERE source = 'kegg' AND annotation_id = 'K00001'"
    ).fetchone()
    assert row == (20.0, 30.0, 2)


def test_ids_can_be_renumbered_across_a_rebuild(conn):
    # The real trigger: with no AUTOINCREMENT, a DELETE+reinsert can
    # hand out a previously-used id to a DIFFERENT annotation. We don't pin
    # down *which* annotation gets which id (SQLite's GROUP BY emission
    # order isn't a contract this test should assert on), but the id *set*
    # a full DELETE+reinsert produces IS deterministic: with no
    # AUTOINCREMENT, SQLite always restarts rowid assignment at 1 once a
    # table is completely empty, regardless of row order. So two rebuilds
    # that each populate exactly 2 rows must both land on ids {1, 2} --
    # even though the second rebuild's row set (K00000, K00002) has
    # nothing but K00002 in common with the first's (K00001, K00002).
    insert_series(conn, "kegg", "K00001", "s1")
    insert_series(conn, "kegg", "K00002", "s1")
    populate_annotation_catalog(conn)
    first_ids = {
        row[0] for row in conn.execute("SELECT id FROM annotation_catalog")
    }
    first_id_k1 = conn.execute(
        "SELECT id FROM annotation_catalog WHERE annotation_id = 'K00001'"
    ).fetchone()[0]
    assert first_ids == {1, 2}

    # Simulate a dataset change that drops K00001 and adds a new annotation.
    conn.execute("DELETE FROM annotation_series WHERE annotation_id = 'K00001'")
    insert_series(conn, "kegg", "K00000", "s1")
    populate_annotation_catalog(conn)

    second_ids = {
        row[0] for row in conn.execute("SELECT id FROM annotation_catalog")
    }
    new_id_k0 = conn.execute(
        "SELECT id FROM annotation_catalog WHERE annotation_id = 'K00000'"
    ).fetchone()[0]
    # Same id set reused for an entirely different pair of annotations --
    # this IS the stale-cache precondition: whichever annotation now holds
    # first_id_k1 is guaranteed not to be K00001 (it no longer exists), so
    # a stale correlations_cache row keyed on first_id_k1 would silently
    # be served against the wrong annotation if the cache weren't wiped.
    assert second_ids == {1, 2}
    assert conn.execute(
        "SELECT annotation_id FROM annotation_catalog WHERE id = ?", (first_id_k1,)
    ).fetchone()[0] != "K00001"
    assert isinstance(new_id_k0, int)
