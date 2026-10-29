"""
test_series_export_review_sql.py
================================
Tests for get_path_review_sql() -- the data behind the Bulk Download
review list: every term that is reached through more than one path inside
the starting term (in practice KEGG KOs in several pathways, and COGs in
several categories), with those paths sorted by the abundance (mean EGC
across all samples) of the path's immediate parent, most abundant first.

Runs against the REAL hab_mappings.db, read-only. Expected values are
recomputed independently from kegg_paths / annotation_catalog.

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

METABOLISM = "09100"
CARBOHYDRATE = "09101"
GLYCOLYSIS = "00010"


@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


def _pathways_of(conn, ko, scope_col=None, scope=None):
    sql = "SELECT DISTINCT c_id FROM kegg_paths WHERE d_id = ?"
    params = [ko]
    if scope_col:
        sql += f" AND {scope_col} = ?"
        params.append(scope)
    return {r[0] for r in conn.execute(sql, params)}


def test_only_terms_with_more_than_one_path_inside_the_start(conn):
    review = get_path_review_sql(conn, "kegg", CARBOHYDRATE, 2, 4)
    expected = {
        r[0] for r in conn.execute(
            "SELECT d_id FROM kegg_paths WHERE b_id = ? AND d_id IS NOT NULL "
            "AND EXISTS (SELECT 1 FROM annotation_catalog a WHERE a.source = 'kegg' AND a.annotation_id = d_id) "
            "GROUP BY d_id HAVING COUNT(DISTINCT c_id) > 1",
            (CARBOHYDRATE,),
        )
    }
    assert {t["annotation_id"] for t in review} == expected
    assert [t["annotation_id"] for t in review] == sorted(expected)


def test_paths_are_those_inside_the_start_with_lineages(conn):
    review = {t["annotation_id"]: t for t in get_path_review_sql(conn, "kegg", METABOLISM, 1, 4)}
    hk = review["K00844"]
    assert "hexokinase" in hk["name"]
    assert {p["parent_id"] for p in hk["paths"]} == _pathways_of(conn, "K00844", "a_id", METABOLISM)
    for p in hk["paths"]:
        assert p["lineage_ids"][0] == METABOLISM
        assert p["lineage_ids"][-2:] == [p["parent_id"], "K00844"]
        assert p["parent_name"] == p["lineage_names"][-2]


def test_total_paths_counts_paths_outside_the_start_too(conn):
    review = {t["annotation_id"]: t for t in get_path_review_sql(conn, "kegg", METABOLISM, 1, 4)}
    hk = review["K00844"]
    assert hk["total_paths"] == len(_pathways_of(conn, "K00844")) == 14
    assert len(hk["paths"]) < hk["total_paths"]  # some of its pathways are outside Metabolism


def test_paths_sorted_by_parent_abundance_most_abundant_first(conn):
    review = {t["annotation_id"]: t for t in get_path_review_sql(conn, "kegg", None, 0, 4)}
    paths = review["K00844"]["paths"]
    means = [p["parent_mean_egc"] for p in paths]
    assert means == sorted(means, reverse=True)
    stored = dict(conn.execute(
        f"SELECT annotation_id, mean_egc FROM annotation_catalog WHERE source = 'kegg' "
        f"AND annotation_id IN ({','.join('?' * len(paths))})",
        [p["parent_id"] for p in paths],
    ))
    assert all(p["parent_mean_egc"] == stored[p["parent_id"]] for p in paths)
    assert paths[0]["parent_id"] == GLYCOLYSIS  # the most abundant of hexokinase's 14


def test_starting_at_one_pathway_needs_no_review(conn):
    """A pathway has one parent, so inside it each KO has exactly one path."""
    assert get_path_review_sql(conn, "kegg", GLYCOLYSIS, 3, 4) == []


def test_levels_above_ko_need_no_review(conn):
    assert get_path_review_sql(conn, "kegg", METABOLISM, 1, 3) == []


def test_enzyme_never_needs_review(conn):
    assert get_path_review_sql(conn, "enzyme", None, 0, 4) == []


def test_the_most_parented_ko_lists_every_path(conn):
    review = {t["annotation_id"]: t for t in get_path_review_sql(conn, "kegg", None, 0, 4)}
    assert len(review["K04371"]["paths"]) == review["K04371"]["total_paths"] == 128
