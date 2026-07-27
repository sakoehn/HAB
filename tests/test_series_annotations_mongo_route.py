"""
test_series_annotations_mongo_route.py
========================================
Live-API test for the DATA_BACKEND=mongo branch of /series/annotations in
api/routes.py.

tests/test_mongo.py already verifies api/cache_mongo.py's functions
directly, in isolation — this file exists to cover what that one can't:
the route-level logic that only exists in routes.py itself (the
value_out reconstruction, get_timepoint() lookup, chronological sort,
pagination, and the 404-on-empty-results behavior). A bug introduced only
in that route code, with cache_mongo.py itself unchanged, would slip past
test_mongo.py entirely but should be caught here.

Requires: a FastAPI server already running with DATA_BACKEND=mongo (see
FastAPI/.env) — e.g. `uvicorn main:app --reload` after setting that in
.env. Skips automatically if the server isn't reachable, or if it's
reachable but not actually running in mongo mode (detected via the
existing /mongo-test diagnostic route, which only succeeds when
app.state.mongo_db exists).

Run:
    pytest tests/test_series_annotations_mongo_route.py -v
"""

import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.config import COG_DIR
from api.index import timepoint_dt_sort_key

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8000")


def _server_is_up() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/status", timeout=5.0)
        return r.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


def _mongo_backend_active() -> bool:
    """
    /mongo-test only succeeds if DATA_BACKEND=mongo — it reads
    app.state.mongo_db, which lifespan() only sets up in that mode. Used
    to skip gracefully rather than fail confusingly if the running server
    is in its default json mode.
    """
    try:
        r = httpx.get(f"{API_BASE_URL}/mongo-test", timeout=5.0)
        return r.status_code == 200
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


mongo_route_required = pytest.mark.skipif(
    not (_server_is_up() and _mongo_backend_active()),
    reason=(
        f"Server not reachable at {API_BASE_URL}, or not running with "
        "DATA_BACKEND=mongo. Set DATA_BACKEND=mongo in FastAPI/.env, "
        "start `uvicorn main:app --reload`, then re-run."
    ),
)


@pytest.fixture(scope="module")
def client():
    with httpx.Client(base_url=API_BASE_URL, timeout=30.0) as c:
        yield c


@mongo_route_required
def test_series_annotations_cog0055_matches_source_files(client):
    """
    Full cross-check of the real /series/annotations route (not
    cache_mongo.py directly) against ground truth computed live from disk,
    plus the route-specific chronological sort — cache_mongo.py doesn't
    sort at all, that logic only exists in routes.py.
    """
    expected_by_sample = {}
    for filename in os.listdir(COG_DIR):
        if not filename.endswith(".cog.json"):
            continue
        sample_name = filename.removesuffix(".cog.json")
        with open(os.path.join(COG_DIR, filename)) as f:
            data = json.load(f)
        entry = data.get("COG0055")
        if entry is not None:
            expected_by_sample[sample_name] = entry

    resp = client.get(
        "/series/annotations",
        params={"source": "cog", "annotation_id": "COG0055", "page_size": 200},
    )
    resp.raise_for_status()
    body = resp.json()

    assert body["total"] == len(expected_by_sample)
    rows = body["data"]
    assert len(rows) == len(expected_by_sample)

    for row in rows:
        sample = row["sample"]
        assert sample in expected_by_sample, f"unexpected sample '{sample}' in results"
        entry = expected_by_sample[sample]

        assert row["egc"] == entry["egc"]
        assert row["norm_egc"] == entry["norm_egc"]
        assert row["name"] == entry["name"]
        assert row["value"]["category"] == entry["category"]
        assert "scaffolds" not in row["value"]  # route deliberately drops scaffolds here

    # Route-specific behavior: results must be sorted chronologically.
    # cache_mongo.py returns unsorted data — this sort only exists in routes.py.
    # Comparing the raw datetime strings directly would hit the same
    # unpadded-date ordering bug api/index.py's own docstring warns about
    # (e.g. "5/28/21 1:00" sorts after "5/28/21 13:00" as plain text) — so
    # compare the same parsed sort key the route itself uses instead.
    datetimes = [
        (row.get("timepoint") or {}).get("datetime") for row in rows
    ]
    sort_keys = [timepoint_dt_sort_key(dt) for dt in datetimes]
    assert sort_keys == sorted(sort_keys)


@mongo_route_required
def test_series_annotations_nonexistent_annotation_returns_404(client):
    """
    Route-specific behavior: an empty result set must become an HTTP 404
    with a descriptive message — cache_mongo.py just returns [], the
    404-raising is routes.py's own logic and untested anywhere else.
    """
    resp = client.get(
        "/series/annotations",
        params={"source": "cog", "annotation_id": "COG_DOES_NOT_EXIST"},
    )
    assert resp.status_code == 404
    assert "COG_DOES_NOT_EXIST" in resp.json()["detail"]
