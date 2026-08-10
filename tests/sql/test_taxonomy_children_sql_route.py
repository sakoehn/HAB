import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from test_cache_sql import EXPECTED_BACTEROIDETES_CHILDREN

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
def test_get_children(client):
    resp = client.get(
        "/taxonomy/children",
        params={"parent": "Bacteroidetes"},
    )
    children = resp.json()['data']
    assert sorted(c["annotation_id"] for c in children) == EXPECTED_BACTEROIDETES_CHILDREN


@sql_route_required
def test_taxon_naming_error(client):
    resp = client.get(
        "/taxonomy/children",
        params={"parent": "TAX_DOES_NOT_EXIST"},
    )
    assert resp.status_code == 404
