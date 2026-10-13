"""
test_annotation_sql_route.py
==============================
Live-API test for the DATA_BACKEND=sql branch(es) of routes.py.

tests/sql/test_cache_sql.py already verifies api/cache_sql.py's functions
directly, in isolation -- this file exists to cover what that one can't:
route-level logic that only exists in routes.py itself (response shape,
404-on-empty handling, sorting, pagination). Covers /series/annotations
specifically -- the other sql routes (taxonomy children, top annotations,
scaffolds, scaffolds summary) each have their own dedicated *_route.py
test file in this folder.

Self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER (`with
TestClient(app) as client:`) rather than requiring a separately running
uvicorn server -- see tests/sql/test_samples_and_timepoints_route.py's
module docstring for why the old httpx.Client-against-a-live-server
pattern silently contributed zero coverage in every normal `pytest
tests/` run.

Run:
    pytest tests/sql/test_annotation_sql_route.py -v
"""

import json
import os
import sys
import gc

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import COG_DIR, SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error
from api.index import timepoint_dt_sort_key  # pylint: disable=wrong-import-position,import-error

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


def test_cog0055_vs_ground_truth(client):
    """
    Cross-check the real /series/annotations route (sql backend) against
    ground truth read straight from the source COG JSON files.
    expected_by_sample is Side B (independent of the database);
    body["data"] is Side A (what the route claims).
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


def test_series_annotations_nonexistent_annotation_returns_404(client):
    resp = client.get(
        "/series/annotations",
        params={"source": "cog", "annotation_id": "COG_DOES_NOT_EXIST"},
    )
    assert resp.status_code == 404
    assert "COG_DOES_NOT_EXIST" in resp.json()["detail"]


# A6 (docs/AUDIT-2026-10-05.md): page/page_size had no input bounds --
# page_size=0 divides by zero in paginate() (a real HTTP 500), and a
# negative page/page_size produces a negative slice start, which Python
# silently reinterprets as an index from the end of the list rather than
# raising.

def test_series_annotations_page_size_zero_is_rejected_not_a_500(client):
    resp = client.get(
        "/series/annotations",
        params={"source": "cog", "annotation_id": "COG0055", "page_size": 0},
    )
    assert resp.status_code == 422


def test_series_annotations_negative_page_is_rejected(client):
    resp = client.get(
        "/series/annotations",
        params={"source": "cog", "annotation_id": "COG0055", "page": -1, "page_size": 5},
    )
    assert resp.status_code == 422
