"""
test_scaffolds_mongo_route.py
===============================
Live-API tests for the DATA_BACKEND=mongo branch of /annotations/scaffolds
and /annotations/scaffolds/summary in api/routes.py.

These routes don't have their own cache_mongo.py function — they reuse
get_annotation_series_mongo() and reshape its output differently, so the
route-level reshaping logic (flatten-to-rows, per-sample summarize, sort,
404-on-empty) is the only place this behavior actually lives. Nothing in
tests/mongo/test_mongo.py covers it.

Requires: a FastAPI server running with DATA_BACKEND=mongo. Skips
automatically if the server isn't reachable, or isn't in mongo mode
(detected via /mongo-test, same as test_series_annotations_mongo_route.py).

Run:
    pytest tests/mongo/test_scaffolds_mongo_route.py -v
"""

import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import COG_DIR

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


def _cog0055_by_sample() -> dict:
    expected = {}
    for filename in os.listdir(COG_DIR):
        if not filename.endswith(".cog.json"):
            continue
        sample_name = filename.removesuffix(".cog.json")
        with open(os.path.join(COG_DIR, filename)) as f:
            data = json.load(f)
        entry = data.get("COG0055")
        if entry is not None:
            expected[sample_name] = entry
    return expected


@mongo_route_required
def test_annotation_scaffolds_matches_source_files(client):
    """Every (sample, scaffold) row must match the real source files exactly.

    Requests one sample at a time, passing `sample=`, instead of a single
    all-samples call: the route paginates (default page_size=500) and an
    all-samples COG0055 result is 29,307 rows, so a single unpaginated
    request would silently only see the first page. Every real sample's
    COG0055 scaffold count is well under 500, so one request per sample is
    guaranteed complete.
    """
    expected_by_sample = _cog0055_by_sample()

    for sample, entry in expected_by_sample.items():
        resp = client.get(
            "/annotations/scaffolds",
            params={"source": "cog", "annotation_id": "COG0055", "sample": sample},
        )
        resp.raise_for_status()
        body = resp.json()

        assert body["total"] == len(entry["scaffolds"])
        actual = {row["scaffold"]: row["count"] for row in body["data"]}
        assert actual == entry["scaffolds"]


@mongo_route_required
def test_annotation_scaffolds_summary_matches_source_files(client):
    """Per-sample scaffold_count/gene_count must match the real source files."""
    expected_by_sample = _cog0055_by_sample()

    resp = client.get(
        "/annotations/scaffolds/summary",
        params={"source": "cog", "annotation_id": "COG0055"},
    )
    resp.raise_for_status()
    body = resp.json()

    assert len(body["data"]) == len(expected_by_sample)
    for row in body["data"]:
        entry = expected_by_sample[row["sample"]]
        assert row["scaffold_count"] == len(entry["scaffolds"])
        assert row["gene_count"] == sum(entry["scaffolds"].values())


@mongo_route_required
def test_annotation_scaffolds_nonexistent_returns_404(client):
    resp = client.get(
        "/annotations/scaffolds",
        params={"source": "cog", "annotation_id": "COG_DOES_NOT_EXIST"},
    )
    assert resp.status_code == 404
