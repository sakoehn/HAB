import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

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
    except (httpx.ConnectError, httpx.TimeoutException) :
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
def test_sorted_results(client):
    resp = client.get("/annotations/top", params={"source": "cog", "limit": 10})
    resp.raise_for_status()
    data = resp.json()["data"]
    means = [row["mean_egc"] for row in data]
    assert len(data) == 10
    assert means == sorted(means, reverse=True)


@sql_route_required
def test_caching_consistency(client):
    resp_5 = client.get("/annotations/top", params={"source": "cog", "limit": 5})
    resp_5.raise_for_status()
    top_5 = resp_5.json()["data"]

    resp_20 = client.get("/annotations/top", params={"source": "cog", "limit": 20})
    resp_20.raise_for_status()
    top_20 = resp_20.json()["data"]

    assert top_20[:5] == top_5


@sql_route_required
def test_invalid_source(client):
    resp = client.get("/annotations/top", params={"source": "INVALID_SOURCE", "limit": 10})
    assert resp.status_code == 422
