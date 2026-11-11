"""
scripts/rebuild_correlation_tables.py moves a database to the
correlation tables with method_version (and adds correlations_unscored).
SQLite can't change a UNIQUE rule in place, and both tables hold only
recomputable results, so they are dropped and created fresh.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from scripts.rebuild_correlation_tables import rebuild_correlation_tables

# The correlations_cache layout before method_version, as in older databases.
OLD_LAYOUT = """
CREATE TABLE annotation_catalog(id INTEGER PRIMARY KEY, source TEXT NOT NULL, annotation_id TEXT NOT NULL);
CREATE TABLE correlations_cache(
    id INTEGER PRIMARY KEY,
    catalog_id_a INTEGER NOT NULL, catalog_id_b INTEGER NOT NULL,
    r REAL NOT NULL, metric TEXT NOT NULL, method TEXT NOT NULL,
    lag_samples INTEGER NOT NULL, p_value REAL NOT NULL, n_pairs INTEGER NOT NULL,
    at_p_floor INTEGER,
    UNIQUE (catalog_id_a, catalog_id_b, metric, method)
);
CREATE INDEX idx_correlations_cache_catalog_id_b ON correlations_cache(catalog_id_b);
"""


@pytest.fixture
def old_db(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.executescript(OLD_LAYOUT)
    conn.execute("INSERT INTO annotation_catalog VALUES (1, 'kegg', 'K00001'), (2, 'kegg', 'K00002')")
    conn.execute("INSERT INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric, method, lag_samples, "
                 "p_value, n_pairs) VALUES (1, 2, 0.5, 'egc', 'spearman', 0, 0.01, 50)")
    conn.commit()
    yield conn
    conn.close()


def _columns(conn, table):
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]


def test_moves_an_old_database_to_the_new_layout(old_db):
    result = rebuild_correlation_tables(old_db)

    assert result == {"rebuilt": True, "cache_rows_dropped": 1, "unscored_rows_dropped": 0}
    assert _columns(old_db, "correlations_cache")[-1] == "method_version"
    assert "reason" in _columns(old_db, "correlations_unscored")
    assert old_db.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0] == 0
    indexes = {row[1] for row in old_db.execute("PRAGMA index_list(correlations_cache)")}
    assert "idx_correlations_cache_catalog_id_b" in indexes


def test_leaves_every_other_table_alone(old_db):
    rebuild_correlation_tables(old_db)

    assert old_db.execute("SELECT COUNT(*) FROM annotation_catalog").fetchone()[0] == 2


def test_new_layout_allows_one_row_per_version(old_db):
    rebuild_correlation_tables(old_db)
    insert = ("INSERT INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric, method, lag_samples, "
              "p_value, n_pairs, method_version) VALUES (1, 2, 0.5, 'egc', 'spearman', 0, 0.01, 50, ?)")
    old_db.execute(insert, (1,))
    old_db.execute(insert, (2,))
    with pytest.raises(sqlite3.IntegrityError):
        old_db.execute(insert, (2,))


def test_second_run_does_nothing(old_db):
    rebuild_correlation_tables(old_db)
    old_db.execute("INSERT INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric, method, lag_samples, "
                   "p_value, n_pairs, method_version) VALUES (1, 2, 0.5, 'egc', 'spearman', 0, 0.01, 50, 1)")
    old_db.commit()

    result = rebuild_correlation_tables(old_db)

    assert result == {"rebuilt": False, "cache_rows_dropped": 0, "unscored_rows_dropped": 0}
    assert old_db.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0] == 1
