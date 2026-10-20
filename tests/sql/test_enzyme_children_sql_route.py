"""
test_enzyme_children_sql_route.py
====================================
Self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER (`with
TestClient(app) as client:`) rather than requiring a separately running
uvicorn server -- see tests/sql/test_samples_and_timepoints_route.py's
module docstring for why the old httpx.Client-against-a-live-server
pattern silently contributed zero coverage in every normal `pytest
tests/` run.

Run:
    pytest tests/sql/test_enzyme_children_sql_route.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH
from test_cache_sql import EXPECTED_ENZYME_ROOT_IDS

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


def test_root_case_returns_the_seven_top_level_classes(client):
    resp = client.get("/enzyme/children")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"] is None
    assert sorted(c["annotation_id"] for c in body["data"]) == EXPECTED_ENZYME_ROOT_IDS


def test_get_children_depth_auto_resolves(client):
    """No `depth` query param exposed on this route -- always derived from
    the EC id's own dot count. 1.1 (Acting on CH-OH group of donors) is
    the known-real parent of 1.1.1.1 (alcohol dehydrogenase)."""
    resp = client.get("/enzyme/children", params={"parent": "1.1"})
    assert resp.status_code == 200
    ids = {c["annotation_id"] for c in resp.json()["data"]}
    assert "1.1.1" in ids


def test_leaf_ec_number_returns_200_with_empty_data(client):
    """A real leaf (1.1.1.1) is a valid node with zero children -- must be
    200 + empty data, not 404 (404 means the id itself doesn't exist)."""
    resp = client.get("/enzyme/children", params={"parent": "1.1.1.1"})
    assert resp.status_code == 200
    assert resp.json()["data"] == []


def test_unknown_id_returns_404(client):
    resp = client.get("/enzyme/children", params={"parent": "NOT_A_REAL_EC_ID"})
    assert resp.status_code == 404


def test_explicitly_empty_parent_returns_the_same_roots_as_omitting_it(client):
    """parent="" (a real, explicitly empty string) must be treated the
    same as omission, not 404 as an unknown node."""
    omitted = client.get("/enzyme/children")
    empty   = client.get("/enzyme/children", params={"parent": ""})
    assert omitted.status_code == 200
    assert empty.status_code == 200
    assert empty.json()["count"] == omitted.json()["count"]
    assert empty.json()["count"] > 0
