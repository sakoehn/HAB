"""
test_hierarchy_path_sql_route.py
==================================
Live-HTTP tests for /enzyme/path, /cog/path -- these back the hierarchy popup's auto-expand-and-
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


@pytest.mark.parametrize("path, params", [
    ("/kegg/path", {"id": "K00844"}),
    ("/kegg/children", {}),
    ("/kegg/parents", {"ids": "K00844"}),
])
def test_kegg_hierarchy_routes_are_gone(client, path, params):
    """The site doesn't serve KEGG's pathway hierarchy: KEGG orthologs are
    a flat list, so there is no KEGG tree to browse."""
    assert client.get(path, params=params).status_code == 404


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
    metabolism) on NCBI's own site, so this route must return both paths.
    Skips if this dataset
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
        "from the multi-category COG notebook yet"
    )


# /cog/parents: a COG id's stored
# `parent` holds only one of its categories, so Explore needs every real
# category for every row to file a multi-category COG under each of them.

def test_cog_parents_bulk_returns_every_real_category(client):
    path_resp = client.get("/cog/path", params={"id": "COG0028"})
    assert path_resp.status_code == 200
    expected = {path[0]["annotation_id"] for path in path_resp.json()["paths"]}
    assert expected == {"E", "H"}

    resp = client.get("/cog/parents", params={"ids": "COG0028"})
    assert resp.status_code == 200
    parents = resp.json()["parents"]["COG0028"]
    assert {p["annotation_id"] for p in parents} == expected
    assert all(p["name"] and p["name"] != p["annotation_id"] for p in parents)  # real category names


def test_cog_parents_bulk_category_letters_and_unknown_ids_have_no_parents(client):
    resp = client.get("/cog/parents", params={"ids": "E,COG0028,NOT_A_COG"})
    assert resp.status_code == 200
    body = resp.json()["parents"]
    assert body["E"] == []          # a category is top-level -- nothing above it
    assert len(body["COG0028"]) == 2
    assert body["NOT_A_COG"] == []  # every requested id is present, never missing
