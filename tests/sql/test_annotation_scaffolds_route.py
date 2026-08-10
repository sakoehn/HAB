import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import COG_DIR  # pylint: disable=wrong-import-position,import-error

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
def test_get_annotation_scaffolds(client):
    resp = client.get(
        "/annotations/scaffolds",
        params={"source": "cog", "annotation_id": "COG0055", "sample": 3300060358},
    )
    body = resp.json()

    with open(os.path.join(COG_DIR, "3300060358.cog.json"), encoding="utf-8") as f:
        data = json.load(f)
    entry = data["COG0055"]

    assert {row["scaffold"]: row["count"] for row in body["data"]} == entry["scaffolds"]


@sql_route_required
def test_get_annotation_scaffold_summary(client):
    resp = client.get(
        "/annotations/scaffolds/summary",
        params={"source": "cog", "annotation_id": "COG0055", "sample": 3300060358}
    )
    expected = {}
    for filename in os.listdir(COG_DIR):
        if not filename.endswith(".cog.json"):
            continue
        sample_name = filename.removesuffix(".cog.json")
        with open(os.path.join(COG_DIR, filename), encoding="utf-8") as f:
            data = json.load(f)
        entry = data.get("COG0055")
        if entry is not None:
            expected[sample_name] = entry

    resp.raise_for_status()
    row = resp.json()

    assert len(row["data"]) == len(expected)
    for r in row["data"]:
        entry = expected[r["sample"]]
        assert r["scaffold_count"] == len(entry["scaffolds"])
        assert r["gene_count"] == sum(entry["scaffolds"].values())


@sql_route_required
def test_invalid_source(client):
    resp = client.get(
        "/annotations/scaffolds",
        params={"source": "cog", "annotation_id": "INVALID_ID", "sample": 3300060358}
    )
    assert resp.status_code == 404
