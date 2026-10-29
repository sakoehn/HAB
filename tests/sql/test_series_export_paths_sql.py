"""
test_series_export_paths_sql.py
===============================
Tests for the cache_sql.py functions behind the bulk time-series download
for the hierarchy sources (Enzyme now; KEGG and COG use the same code):

  get_paths_under_at_depth_sql()  -- every term at one level under a
                                     starting term, one row per lineage.
  iter_series_for_ids_sql()       -- the per-sample rows for a list of ids,
                                     for any source.

Runs against the REAL hab_mappings.db, read-only. Expected values are
recomputed independently from enzyme_paths in each test.

Run:
    pytest tests/sql/test_series_export_paths_sql.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.cache_sql import get_paths_under_at_depth_sql, iter_series_for_ids_sql
from api.config import SQLITE_DB_PATH

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

_ENZYME_ID_COLUMNS = {1: "a_id", 2: "b_id", 3: "c_id", 4: "d_id"}


@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


def _independent_enzyme_ids(conn, parent, parent_depth, depth):
    target = _ENZYME_ID_COLUMNS[depth]
    if parent is None:
        rows = conn.execute(f"SELECT DISTINCT {target} FROM enzyme_paths WHERE {target} IS NOT NULL")
    else:
        rows = conn.execute(
            f"SELECT DISTINCT {target} FROM enzyme_paths WHERE {target} IS NOT NULL AND {_ENZYME_ID_COLUMNS[parent_depth]} = ?",
            (parent,),
        )
    return sorted(r[0] for r in rows)


# ── get_paths_under_at_depth_sql ─────────────────────────────────────────────

def test_ec_numbers_under_a_sub_subclass(conn):
    rows = get_paths_under_at_depth_sql(conn, "enzyme", "5.6.2", 3, 4)
    assert [r["annotation_id"] for r in rows] == ["5.6.2.1", "5.6.2.2"]


def test_can_skip_levels_class_to_ec_number(conn):
    rows = get_paths_under_at_depth_sql(conn, "enzyme", "1", 1, 4)
    assert [r["annotation_id"] for r in rows] == _independent_enzyme_ids(conn, "1", 1, 4)
    assert len(rows) > 500


def test_whole_dataset_lists_every_class(conn):
    rows = get_paths_under_at_depth_sql(conn, "enzyme", None, 0, 1)
    assert [r["annotation_id"] for r in rows] == _independent_enzyme_ids(conn, None, 0, 1)
    assert len(rows) == 7


def test_rows_carry_the_full_lineage_ids_and_names(conn):
    row = next(r for r in get_paths_under_at_depth_sql(conn, "enzyme", "1.1.1", 3, 4) if r["annotation_id"] == "1.1.1.1")
    assert row["name"] == "alcohol dehydrogenase"
    assert row["lineage_ids"] == ["1", "1.1", "1.1.1", "1.1.1.1"]
    assert row["lineage_names"][0] == "Oxidoreductases"
    assert row["lineage_names"][-1] == "alcohol dehydrogenase"
    assert len(row["lineage_names"]) == 4


def test_every_returned_term_has_data(conn):
    ids = [r["annotation_id"] for r in get_paths_under_at_depth_sql(conn, "enzyme", "3", 1, 3)]
    with_data = {r[0] for r in conn.execute("SELECT annotation_id FROM annotation_catalog WHERE source = 'enzyme'")}
    assert ids and set(ids) <= with_data


def test_one_row_per_term_for_enzyme(conn):
    """Enzyme has one parent per term, so no term repeats."""
    ids = [r["annotation_id"] for r in get_paths_under_at_depth_sql(conn, "enzyme", None, 0, 4)]
    assert len(ids) == len(set(ids))


def test_parent_with_nothing_under_it_returns_empty(conn):
    assert get_paths_under_at_depth_sql(conn, "enzyme", "9.9.9", 3, 4) == []


@pytest.mark.parametrize("parent_depth, depth", [(3, 3), (3, 2), (0, 5), (0, 0)])
def test_bad_levels_raise(conn, parent_depth, depth):
    with pytest.raises(ValueError):
        get_paths_under_at_depth_sql(conn, "enzyme", "1.1.1", parent_depth, depth)


def test_taxonomy_is_not_a_paths_source(conn):
    with pytest.raises(ValueError):
        get_paths_under_at_depth_sql(conn, "taxonomy", None, 0, 1)


# ── iter_series_for_ids_sql ──────────────────────────────────────────────────

def test_series_rows_match_an_independent_count(conn):
    ids = [r["annotation_id"] for r in get_paths_under_at_depth_sql(conn, "enzyme", "1", 1, 4)]
    rows = list(iter_series_for_ids_sql(conn, "enzyme", ids))
    expected = sum(
        conn.execute(
            f"SELECT COUNT(*) FROM annotation_series WHERE source = 'enzyme' AND annotation_id IN ({','.join('?' * len(chunk))})",
            chunk,
        ).fetchone()[0]
        for chunk in (ids[i:i + 500] for i in range(0, len(ids), 500))
    )
    assert len(rows) == expected
    keys = [(r["annotation_id"], r["sample"]) for r in rows]
    assert len(keys) == len(set(keys))
    assert [r["annotation_id"] for r in rows] == sorted(r["annotation_id"] for r in rows)


def test_series_reads_only_the_requested_source(conn):
    """No id is shared between sources in the real data, so ask for a
    taxonomy id under the wrong source: nothing may come back."""
    assert list(iter_series_for_ids_sql(conn, "taxonomy", ["Bacteria"]))
    assert list(iter_series_for_ids_sql(conn, "enzyme", ["Bacteria"])) == []
