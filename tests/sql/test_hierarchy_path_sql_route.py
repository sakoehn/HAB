"""
test_hierarchy_path_sql_route.py
==================================
Live-HTTP tests for /kegg/path, /enzyme/path, /cog/path under
DATA_BACKEND=sql -- these back the hierarchy popup's auto-expand-and-
highlight feature (open a popup for one specific annotation, jump
straight to its position in the tree instead of an empty root).

Self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER (`with
TestClient(app) as client:`) rather than requiring a separately running
uvicorn server -- see test_cog_children_sql_route.py's docstring for why
(only the context-manager form actually runs main.py's lifespan(), which
sets up app.state.sql_conn).

Run:
    pytest tests/sql/test_hierarchy_path_sql_route.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# Every test below takes a `client` parameter to receive this fixture's
# value -- pylint sees that as shadowing the module-level `client` name,
# but it's the standard pytest fixture-injection pattern, not a real bug.
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as c:
        yield c


def test_kegg_path_resolves_multiparent_node_to_all_14_real_paths(client):
    """K00844 (hexokinase) has 14 real KEGG pathway parents -- the route
    must return every real path (not just one), with the file-order-first
    one (Glycolysis / Gluconeogenesis) listed first."""
    resp = client.get("/kegg/path", params={"id": "K00844"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["path_count"] == 14
    assert len(body["paths"]) == 14
    ids = [node["annotation_id"] for node in body["paths"][0]]
    assert ids == ["09100", "09101", "00010", "K00844"]


def test_kegg_path_unknown_id_returns_404(client):
    resp = client.get("/kegg/path", params={"id": "NOT_A_REAL_KEGG_ID"})
    assert resp.status_code == 404


def test_enzyme_path_returns_full_chain_with_path_count_one(client):
    resp = client.get("/enzyme/path", params={"id": "1.1.1.1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["path_count"] == 1
    assert len(body["paths"]) == 1
    ids = [node["annotation_id"] for node in body["paths"][0]]
    assert ids == ["1", "1.1", "1.1.1", "1.1.1.1"]


def test_enzyme_path_unknown_id_returns_404(client):
    resp = client.get("/enzyme/path", params={"id": "NOT_A_REAL_EC_ID"})
    assert resp.status_code == 404


def test_cog_path_returns_full_chain_with_path_count_one(client):
    resp = client.get("/cog/path", params={"id": "COG0001"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["path_count"] == 1
    assert len(body["paths"]) == 1
    ids = [node["annotation_id"] for node in body["paths"][0]]
    assert ids == ["H", "COG0001"]


def test_cog_path_unknown_id_returns_404(client):
    resp = client.get("/cog/path", params={"id": "NOT_A_REAL_COG_ID"})
    assert resp.status_code == 404


def test_cog_path_resolves_multicategory_node_to_all_real_paths(client):
    """COG0028 is confirmed real under both category E (Amino acid
    transport and metabolism) and category H (Coenzyme transport and
    metabolism) on NCBI's own site (E17, docs/AUDIT-2026-09-22.md) --
    before that fix, cog_paths could only ever hold one of the two, so
    this route could never have returned both. Skips if this dataset
    doesn't happen to have COG0028 annotated."""
    resp = client.get("/cog/path", params={"id": "COG0028"})
    if resp.status_code == 404:
        pytest.skip("COG0028 not present in this dataset's annotation_catalog")
    assert resp.status_code == 200
    body = resp.json()
    categories = {path[0]["annotation_id"] for path in body["paths"]}
    assert categories == {"E", "H"}, (
        f"expected COG0028 under both E and H, got {categories} -- "
        "if this is a single category, cog_paths hasn't been regenerated "
        "from the E17-fixed notebook yet (Phase 3)"
    )
