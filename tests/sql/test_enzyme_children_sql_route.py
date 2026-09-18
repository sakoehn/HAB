import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from test_cache_sql import EXPECTED_ENZYME_ROOT_IDS

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
def test_root_case_returns_the_seven_top_level_classes(client):
    resp = client.get("/enzyme/children")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"] is None
    assert sorted(c["annotation_id"] for c in body["data"]) == EXPECTED_ENZYME_ROOT_IDS


@sql_route_required
def test_get_children_depth_auto_resolves(client):
    """No `depth` query param exposed on this route -- always derived from
    the EC id's own dot count. 1.1 (Acting on CH-OH group of donors) is
    the known-real parent of 1.1.1.1 (alcohol dehydrogenase)."""
    resp = client.get("/enzyme/children", params={"parent": "1.1"})
    assert resp.status_code == 200
    ids = {c["annotation_id"] for c in resp.json()["data"]}
    assert "1.1.1" in ids


@sql_route_required
def test_leaf_ec_number_returns_200_with_empty_data(client):
    """A real leaf (1.1.1.1) is a valid node with zero children -- must be
    200 + empty data, not 404 (404 means the id itself doesn't exist)."""
    resp = client.get("/enzyme/children", params={"parent": "1.1.1.1"})
    assert resp.status_code == 200
    assert resp.json()["data"] == []


@sql_route_required
def test_unknown_id_returns_404(client):
    resp = client.get("/enzyme/children", params={"parent": "NOT_A_REAL_EC_ID"})
    assert resp.status_code == 404
