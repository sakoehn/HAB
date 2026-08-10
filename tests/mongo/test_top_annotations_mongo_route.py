"""
test_top_annotations_mongo_route.py
=====================================
Live-API test for the DATA_BACKEND=mongo branch of /annotations/top in
api/routes.py — the aggregation-pipeline endpoint.

tests/mongo/test_mongo.py already cross-checks get_top_annotations_mongo()'s
aggregation math directly. This file covers what only exists in the route:
the _TOP_ANN_CACHE_MONGO caching (compute once, slice per request) and the
`limit` query param slicing behavior.

Requires: a FastAPI server running with DATA_BACKEND=mongo. Skips
automatically if unreachable or not in mongo mode.

Run:
    pytest tests/mongo/test_top_annotations_mongo_route.py -v
"""

import os

import httpx
import pytest

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8000")


def _server_is_up() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/status", timeout=5.0)
        return r.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


def _mongo_backend_active() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/mongo-test", timeout=5.0)
        return r.status_code == 200
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


mongo_route_required = pytest.mark.skipif(
    not (_server_is_up() and _mongo_backend_active()),
    reason=(
        f"Server not reachable at {API_BASE_URL}, or not running with "
        "DATA_BACKEND=mongo."
    ),
)


@pytest.fixture(scope="module")
def client():
    with httpx.Client(base_url=API_BASE_URL, timeout=30.0) as c:
        yield c


@mongo_route_required
def test_annotations_top_is_sorted_and_respects_limit(client):
    resp = client.get("/annotations/top", params={"source": "cog", "limit": 10})
    resp.raise_for_status()
    body = resp.json()

    assert len(body["data"]) == 10
    means = [row["mean_egc"] for row in body["data"]]
    assert means == sorted(means, reverse=True)


@mongo_route_required
def test_annotations_top_caching_returns_consistent_results(client):
    """
    Route-specific behavior: results are cached per (source, date_from,
    date_to), then sliced by limit — a second call with a larger limit
    should return the same top 5 as the first call, not recompute
    differently. Only the caching/slicing logic is route-only; the
    aggregation itself is already tested directly in test_mongo.py.
    """
    resp_5 = client.get("/annotations/top", params={"source": "cog", "limit": 5})
    resp_5.raise_for_status()
    top_5 = resp_5.json()["data"]

    resp_20 = client.get("/annotations/top", params={"source": "cog", "limit": 20})
    resp_20.raise_for_status()
    top_20 = resp_20.json()["data"]

    assert top_20[:5] == top_5


@mongo_route_required
def test_annotations_top_unknown_source_is_rejected(client):
    resp = client.get("/annotations/top", params={"source": "not_a_real_source", "limit": 5})
    assert resp.status_code == 422  # FastAPI enum validation, not our code
