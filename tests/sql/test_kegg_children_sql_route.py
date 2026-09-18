import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from test_cache_sql import EXPECTED_KEGG_ROOT_IDS, EXPECTED_CARBOHYDRATE_METABOLISM_CHILDREN

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8000")


def _server_is_up() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/status", timeout=5.0)
        return r.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


def _sql_backend_active() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/sql-test", timeout=5.0)
        return r.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


sql_route_required = pytest.mark.skipif(
    not (_server_is_up() and _sql_backend_active()),
    reason=(
        f"Server not reachable at {API_BASE_URL}, or not running with "
        "DATA_BACKEND=sql. Set DATA_BACKEND=sql in FastAPI/.env, "
        "start `uvicorn main:app --reload`, then re-run."
    ),
)

# Every test below takes a `client` parameter to receive this fixture's
# value -- pylint sees that as shadowing the module-level `client` name,
# but it's the standard pytest fixture-injection pattern, not a real bug.
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def client():
    with httpx.Client(base_url=API_BASE_URL, timeout=30.0) as c:
        yield c


@sql_route_required
def test_root_case_returns_the_eight_top_level_branches(client):
    resp = client.get("/kegg/children")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"] is None
    assert sorted(c["annotation_id"] for c in body["data"]) == EXPECTED_KEGG_ROOT_IDS


@sql_route_required
def test_get_children_depth_auto_resolves(client):
    """No `depth` query param exposed on this route at all -- the route
    always lets get_kegg_children_sql derive it, so this doubles as
    confirmation that path works through the full HTTP layer, not just
    the direct function call already covered in test_cache_sql.py."""
    resp = client.get("/kegg/children", params={"parent": "09101"})
    assert resp.status_code == 200
    children = resp.json()["data"]
    assert sorted(c["annotation_id"] for c in children) == EXPECTED_CARBOHYDRATE_METABOLISM_CHILDREN


@sql_route_required
def test_leaf_ko_returns_200_with_empty_data(client):
    """A real leaf (K00844) is a valid node with zero children -- must be
    200 + empty data, not 404 (404 means the id itself doesn't exist)."""
    resp = client.get("/kegg/children", params={"parent": "K00844"})
    assert resp.status_code == 200
    assert resp.json()["data"] == []


@sql_route_required
def test_unknown_id_returns_404(client):
    resp = client.get("/kegg/children", params={"parent": "NOT_A_REAL_KEGG_ID"})
    assert resp.status_code == 404
