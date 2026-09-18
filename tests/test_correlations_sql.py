import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()

def test_valid_shape(conn):
    cursor = conn.execute("SELECT * FROM correlations LIMIT 1")
    rows = cursor.fetchone()
    assert rows is not None
    columns = {desc[0] for desc in cursor.description}
    expected = {
        "id", "catalog_id_a", "catalog_id_b", "mode", "spearman_r",
        "lag_samples", "p_value", "n_tps",
    }
    assert columns == expected

def test_no_duplicate_pairs(conn):
    cursor = conn.execute("SELECT catalog_id_a, catalog_id_b, mode FROM correlations")
    rows = cursor.fetchall()
    assert rows is not None
    seen = []
    has_dups = False
    for row in rows:
        key = (row[0], row[1], row[2])
        if key not in seen:
            seen.append(key)
        else:
            has_dups = True
    assert not has_dups

def test_canonical_ordering_holds(conn):
    cursor = conn.execute("SELECT catalog_id_a, catalog_id_b FROM correlations")
    rows = cursor.fetchall()
    assert rows is not None
    order_holds = True
    for row in rows:
        if row[0] > row[1]:
            order_holds = False
    assert order_holds
   

def test_valid_spearman_r(conn):
    cursor = conn.execute("SELECT DISTINCT spearman_r FROM correlations")
    rows = cursor.fetchall()
    out_of_bounds = False
    for row in rows:
        if row[0] > 1 or row[0] < -1 :
            out_of_bounds = True
    assert not out_of_bounds

def test_correct_modes(conn):
    cursor = conn.execute("SELECT DISTINCT mode FROM correlations")
    rows = cursor.fetchall()
    columns = {row[0] for row in rows}
    expected = {"cross", "within"}
    assert rows is not None
    assert columns == expected


def test_r_threshold_enforced(conn):
    cursor_cross = conn.execute("SELECT spearman_r FROM correlations WHERE mode = 'cross'")
    rows_cross = cursor_cross.fetchall()
    cursor_within = conn.execute("SELECT spearman_r FROM correlations WHERE mode = 'within'")
    rows_within = cursor_within.fetchall()
    assert rows_within
    assert rows_cross

    cross_valid = True
    within_valid = True
    for row in rows_cross:
        if abs(row[0]) < 0.2: cross_valid = False
    for row in rows_within:
        if abs(row[0]) < 0.3: within_valid = False

    assert cross_valid
    assert within_valid
    
def test_n_timepoints_respects_floor(conn):
    cursor = conn.execute("SELECT n_tps FROM correlations WHERE n_tps < 10")
    rows = cursor.fetchall()
    assert rows == []


def test_existence_both_sides_of_pair(conn):
    cursor_a = conn.execute("SELECT COUNT(*) FROM correlations WHERE catalog_id_a NOT IN (SELECT id FROM annotation_catalog)")
    rows_a = cursor_a.fetchall()
    assert rows_a[0][0] == 0
    cursor_b = conn.execute("SELECT COUNT(*) FROM correlations WHERE catalog_id_b NOT IN (SELECT id FROM annotation_catalog)")
    rows_b = cursor_b.fetchall()
    assert rows_b[0][0] == 0


