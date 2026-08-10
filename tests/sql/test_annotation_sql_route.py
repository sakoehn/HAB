"""
test_annotation_sql_route.py
==============================
Live-API test for the DATA_BACKEND=sql branch(es) of routes.py.

tests/sql/test_cache_sql.py already verifies api/cache_sql.py's functions
directly, in isolation -- this file exists to cover what that one can't:
route-level logic that only exists in routes.py itself (response shape,
404-on-empty handling, sorting, pagination), same role
tests/mongo/test_series_annotations_mongo_route.py etc. play for the
Mongo branch. Covers /series/annotations specifically -- the other sql
routes (taxonomy children, top annotations, scaffolds, scaffolds summary)
each have their own dedicated *_route.py test file in this folder.

Requires: a FastAPI server already running with DATA_BACKEND=sql (see
FastAPI/.env) -- e.g. `uvicorn main:app --reload` after setting that in
.env. Skips automatically if the server isn't reachable, or isn't
actually running in sql mode.

Run:
    pytest tests/sql/test_annotation_sql_route.py -v
"""

import json
import os
import sys
import gc

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import COG_DIR  # pylint: disable=wrong-import-position,import-error
from api.index import timepoint_dt_sort_key  # pylint: disable=wrong-import-position,import-error

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
def test_cog0055_vs_ground_truth(client):
    """
    Cross-check the real /series/annotations route (sql backend) against
    ground truth read straight from the source COG JSON files -- same
    shape as tests/mongo/test_series_annotations_mongo_route.py's
    equivalent test. expected_by_sample is Side B (independent of the
    database); body["data"] is Side A (what the route claims).
    """
    expected_by_sample = {}
    for filename in os.listdir(COG_DIR):
        if not filename.endswith(".cog.json"):
            continue
        sample_name = filename.removesuffix(".cog.json")
        with open(os.path.join(COG_DIR, filename), encoding="utf-8") as f:
            data = json.load(f)
        entry = data.get("COG0055")
        if entry is not None:
            expected_by_sample[sample_name] = entry
        del data
        gc.collect()

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
        assert "scaffolds" not in row["value"]

    datetimes = [(row.get("timepoint") or {}).get("datetime") for row in rows]
    sort_keys = [timepoint_dt_sort_key(dt) for dt in datetimes]
    assert sort_keys == sorted(sort_keys)


@sql_route_required
def test_series_annotations_nonexistent_annotation_returns_404(client):
    resp = client.get(
        "/series/annotations",
        params={"source": "cog", "annotation_id": "COG_DOES_NOT_EXIST"},
    )
    assert resp.status_code == 404
    assert "COG_DOES_NOT_EXIST" in resp.json()["detail"]
