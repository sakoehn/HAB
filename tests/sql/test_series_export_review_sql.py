"""
test_series_export_review_sql.py
================================
Tests for get_path_review_sql() -- the data behind the Bulk Download
review list: every term that is reached through more than one path inside
the starting term (in practice COGs in several categories), with those
paths sorted by the abundance (mean EGC across all samples) of the path's
immediate parent, most abundant first.

Runs against the REAL hab_mappings.db, read-only. Expected values are
recomputed independently from cog_paths / annotation_catalog.

Run:
    pytest tests/sql/test_series_export_review_sql.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.cache_sql import get_path_review_sql
from api.config import SQLITE_DB_PATH

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

COG0028 = "COG0028"  # in both E and H


@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


def test_only_cogs_in_more_than_one_category(conn):
    review = get_path_review_sql(conn, "cog", None, 0, 2)
    expected = {
        r[0] for r in conn.execute(
            "SELECT b_id FROM cog_paths WHERE b_id IS NOT NULL "
            "AND EXISTS (SELECT 1 FROM annotation_catalog a WHERE a.source = 'cog' AND a.annotation_id = b_id) "
            "GROUP BY b_id HAVING COUNT(DISTINCT a_id) > 1"
        )
    }
    assert expected
    assert [t["annotation_id"] for t in review] == sorted(expected)


def test_paths_carry_lineages_and_are_sorted_by_category_abundance(conn):
    review = {t["annotation_id"]: t for t in get_path_review_sql(conn, "cog", None, 0, 2)}
    paths = review[COG0028]["paths"]
    assert {p["parent_id"] for p in paths} == {"E", "H"}
    assert review[COG0028]["total_paths"] == 2
    for p in paths:
        assert p["lineage_ids"] == [p["parent_id"], COG0028]
        assert p["parent_name"] == p["lineage_names"][0]
    means = [p["parent_mean_egc"] for p in paths]
    assert means == sorted(means, reverse=True)
    stored = dict(conn.execute(
        "SELECT annotation_id, mean_egc FROM annotation_catalog WHERE source = 'cog' AND annotation_id IN ('E', 'H')"
    ))
    assert all(p["parent_mean_egc"] == stored[p["parent_id"]] for p in paths)


def test_inside_one_category_nothing_needs_review(conn):
    assert get_path_review_sql(conn, "cog", "E", 1, 2) == []


def test_enzyme_and_kegg_never_need_review(conn):
    assert get_path_review_sql(conn, "enzyme", None, 0, 4) == []
    assert get_path_review_sql(conn, "kegg", None, 0, 1) == []
