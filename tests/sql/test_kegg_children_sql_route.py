"""
test_kegg_children_sql_route.py
==================================
Self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER (`with
TestClient(app) as client:`) rather than requiring a separately running
uvicorn server -- see tests/sql/test_samples_and_timepoints_route.py's
module docstring for why the old httpx.Client-against-a-live-server
pattern silently contributed zero coverage in every normal `pytest
tests/` run.

Run:
    pytest tests/sql/test_kegg_children_sql_route.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH
from test_cache_sql import EXPECTED_KEGG_ROOT_IDS, EXPECTED_CARBOHYDRATE_METABOLISM_CHILDREN

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


def test_root_case_returns_the_eight_top_level_branches(client):
    resp = client.get("/kegg/children")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"] is None
    assert sorted(c["annotation_id"] for c in body["data"]) == EXPECTED_KEGG_ROOT_IDS


def test_get_children_depth_auto_resolves(client):
    """No `depth` query param exposed on this route at all -- the route
    always lets get_kegg_children_sql derive it, so this doubles as
    confirmation that path works through the full HTTP layer, not just
    the direct function call already covered in test_cache_sql.py."""
    resp = client.get("/kegg/children", params={"parent": "09101"})
    assert resp.status_code == 200
    children = resp.json()["data"]
    assert sorted(c["annotation_id"] for c in children) == EXPECTED_CARBOHYDRATE_METABOLISM_CHILDREN


def test_leaf_ko_returns_200_with_empty_data(client):
    """A real leaf (K00844) is a valid node with zero children -- must be
    200 + empty data, not 404 (404 means the id itself doesn't exist)."""
    resp = client.get("/kegg/children", params={"parent": "K00844"})
    assert resp.status_code == 200
    assert resp.json()["data"] == []


def test_unknown_id_returns_404(client):
    resp = client.get("/kegg/children", params={"parent": "NOT_A_REAL_KEGG_ID"})
    assert resp.status_code == 404


def test_explicitly_empty_parent_returns_the_same_roots_as_omitting_it(client):
    """parent="" (a real, explicitly empty string -- FastAPI only supplies
    the None default when the query param is omitted entirely) must be
    treated the same as omission (the 8 top-level branches), not 404 as an
    unknown node -- an empty string IS `not None`."""
    omitted = client.get("/kegg/children")
    empty   = client.get("/kegg/children", params={"parent": ""})
    assert omitted.status_code == 200
    assert empty.status_code == 200
    assert empty.json()["count"] == omitted.json()["count"]
    assert empty.json()["count"] > 0
