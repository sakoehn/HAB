"""
test_kegg_immediate_parents_bulk.py
======================================
Tests for get_kegg_immediate_parents_bulk_sql() in FastAPI/api/cache_sql.py
-- resolves every real IMMEDIATE parent (one level up) for a batch of
KEGG node ids in a handful of queries, for "Annotations by Parent"
bucketing a multi-parent KO into every real
parent group it belongs to, not just the single last-occurrence-wins
`annotation_catalog.parent`.

Isolated in-memory db with a small hand-written kegg_paths fixture (same
shape as the real table: a_id/a_name .. d_id/d_name, one row per real
full occurrence) -- not the real local hab_mappings.db, so these pin
exact edge-case behavior (mixed depths in one call, a depth-1 root with
no parent, an unknown id) without depending on real data's specifics.
Real-data coverage (K00844's real 14 parents) lives in
test_hierarchy_path_sql_route.py-style route tests instead.

Run:
    pytest tests/sql/test_kegg_immediate_parents_bulk.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.cache_sql import get_kegg_immediate_parents_bulk_sql

SCHEMA = """
CREATE TABLE kegg_paths (
    id      INTEGER PRIMARY KEY,
    a_id    TEXT, a_name TEXT,
    b_id    TEXT, b_name TEXT,
    c_id    TEXT, c_name TEXT,
    d_id    TEXT, d_name TEXT,
    full_path TEXT NOT NULL UNIQUE
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)

    rows = [
        # K01 is multi-parent: two real full paths, different B/C ancestors,
        # same D-level leaf -- the multi-parent case (K00844 in real data).
        ("09100", "Metabolism",             "09101", "Carbohydrate metabolism", "00010", "Glycolysis",      "K01", "enzyme one"),
        ("09180", "Brite Hierarchies",       "09181", "Protein families",       "00099", "Other",           "K01", "enzyme one"),
        # K02 is single-parent.
        ("09100", "Metabolism",             "09101", "Carbohydrate metabolism", "00010", "Glycolysis",      "K02", "enzyme two"),
        # 00010 itself (a C-level node) is single-parent at its own depth.
        ("09100", "Metabolism",             "09101", "Carbohydrate metabolism", "00010", "Glycolysis",      None,  None),
    ]
    connection.executemany(
        "INSERT INTO kegg_paths (a_id, a_name, b_id, b_name, c_id, c_name, d_id, d_name, full_path) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(*r, f"{r[0]}|{r[2]}|{r[4]}|{r[6]}") for r in rows],
    )
    connection.commit()
    yield connection
    connection.close()


def test_multi_parent_leaf_resolves_every_real_immediate_parent(conn):
    result = get_kegg_immediate_parents_bulk_sql(conn, ["K01"])
    parents = {p["annotation_id"]: p["name"] for p in result["K01"]}
    assert parents == {"00010": "Glycolysis", "00099": "Other"}


def test_single_parent_leaf_resolves_to_exactly_one(conn):
    result = get_kegg_immediate_parents_bulk_sql(conn, ["K02"])
    assert len(result["K02"]) == 1
    assert result["K02"][0] == {"annotation_id": "00010", "name": "Glycolysis"}


def test_c_level_node_resolves_to_its_own_b_level_parent(conn):
    result = get_kegg_immediate_parents_bulk_sql(conn, ["00010"])
    assert result["00010"] == [{"annotation_id": "09101", "name": "Carbohydrate metabolism"}]


def test_a_level_root_has_no_parent(conn):
    # Confirm "09100" is genuinely a real A-level id in this fixture (not
    # just absent from the table entirely, which would trivially also
    # return [] via test_unknown_id_returns_empty_list_not_a_missing_key's
    # same code path) -- the function has no depth=1 iteration because an
    # A-level root has nothing above it, so this is the one id value this
    # fixture asserts is real without ever appearing in a d_id/c_id/b_id
    # column.
    assert conn.execute("SELECT 1 FROM kegg_paths WHERE a_id = '09100'").fetchone() is not None
    for col in ("d_id", "c_id", "b_id"):
        assert conn.execute(f"SELECT 1 FROM kegg_paths WHERE {col} = '09100'").fetchone() is None

    result = get_kegg_immediate_parents_bulk_sql(conn, ["09100"])
    assert result["09100"] == []


def test_unknown_id_returns_empty_list_not_a_missing_key(conn):
    result = get_kegg_immediate_parents_bulk_sql(conn, ["NOTREAL"])
    assert "NOTREAL" in result
    assert result["NOTREAL"] == []


def test_mixed_depths_in_one_call_all_resolve_correctly(conn):
    """The real use case: a 200-row top-EGC list mixes leaf KOs, pathways,
    and categories in one request -- confirms resolving a D-level leaf, a
    C-level node, and an A-level root together in a SINGLE call gives each
    its own correct answer, not cross-contaminated by sharing one query."""
    result = get_kegg_immediate_parents_bulk_sql(conn, ["K01", "00010", "09100"])
    assert {p["annotation_id"] for p in result["K01"]} == {"00010", "00099"}
    assert result["00010"] == [{"annotation_id": "09101", "name": "Carbohydrate metabolism"}]
    assert result["09100"] == []


def test_every_requested_id_has_an_entry_even_with_an_empty_list_input():
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    assert get_kegg_immediate_parents_bulk_sql(conn, []) == {}
