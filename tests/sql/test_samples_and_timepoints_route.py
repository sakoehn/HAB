"""
test_samples_and_timepoints_route.py
======================================
Live-HTTP tests for /samples and /timepoints.

These two routes need their own coverage here: the other tests (test_unit_backend.py's
TestRoutesViaTestClient, via the `patched_client` fixture) always 500, because `patched_client` builds a plain
`TestClient(app, raise_server_exceptions=False)` without entering it as a
context manager -- so main.py's lifespan() never runs, app.state.sql_conn
is never set, and every route that reads it crashes. raise_server_exceptions
=False just turns that crash into a silent 500 instead of a visible error,
so those tests "pass structurally" (they collect and run) while asserting
nothing meaningful ever actually executes.

This file uses TestClient AS A CONTEXT MANAGER instead (`with TestClient
(app) as client:`), which correctly runs the real lifespan and sets up
app.state.sql_conn -- self-contained, no separately running uvicorn server
needed, and it actually exercises the real sql-backed code path.

`_filter_timepoints_to_real_samples` (the "132 vs 128" real-vs-timepoints
mismatch logic /timepoints uses) already has its own direct unit tests in
test_unit_backend.py -- this file checks the route dispatches to the sql
branch and returns the right shape/counts, not that internal filtering
logic again.

Run:
    pytest tests/sql/test_samples_and_timepoints_route.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH

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


# ═══════════════════════════════════════════════════════════════════════════
# /samples
# ═══════════════════════════════════════════════════════════════════════════

def test_samples_returns_200_with_all_128_real_samples(client):
    resp = client.get("/samples", params={"page_size": 200})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 128


def test_samples_rows_have_sample_and_timepoint_fields(client):
    resp = client.get("/samples", params={"page_size": 5})
    body = resp.json()
    assert body["data"], "expected at least one sample row"
    for row in body["data"]:
        assert "sample" in row
        assert "timepoint" in row
        assert row["timepoint"] is not None
        assert "datetime" in row["timepoint"]


def test_samples_pagination_respects_page_size(client):
    resp = client.get("/samples", params={"page_size": 10, "page": 1})
    body = resp.json()
    assert len(body["data"]) == 10
    assert body["page"] == 1
    assert body["page_size"] == 10
    assert body["total_pages"] == 13  # ceil(128 / 10)


def test_samples_second_page_returns_different_rows(client):
    page1 = client.get("/samples", params={"page_size": 10, "page": 1}).json()
    page2 = client.get("/samples", params={"page_size": 10, "page": 2}).json()
    ids1 = {r["sample"] for r in page1["data"]}
    ids2 = {r["sample"] for r in page2["data"]}
    assert ids1.isdisjoint(ids2)


# ═══════════════════════════════════════════════════════════════════════════
# /timepoints
# ═══════════════════════════════════════════════════════════════════════════

def test_timepoints_returns_200_with_128_real_samples(client):
    """Must match /samples' count exactly -- both derive from the same
    real sample list on the sql branch (get_all_sample_names_sql), and
    /timepoints additionally filters the raw TIMEPOINTS CSV down to real
    samples only (the "132 vs 128" fix)."""
    resp = client.get("/timepoints", params={"page_size": 200})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 128


def test_timepoints_rows_have_datetime_field(client):
    resp = client.get("/timepoints", params={"page_size": 5})
    body = resp.json()
    assert body["data"], "expected at least one timepoint row"
    for row in body["data"]:
        assert "datetime" in row
        assert row["datetime"]


def test_samples_and_timepoints_report_the_same_sample_set(client):
    """Both routes derive their real-sample list from the same
    get_all_sample_names_sql call -- their sample identities must agree
    exactly, not just their counts."""
    samples_resp    = client.get("/samples", params={"page_size": 200}).json()
    timepoints_resp = client.get("/timepoints", params={"page_size": 200}).json()

    sample_ids    = {row["sample"] for row in samples_resp["data"]}
    timepoint_ids = {row["taxon_oid"] for row in timepoints_resp["data"]}
    assert sample_ids == timepoint_ids


# ═══════════════════════════════════════════════════════════════════════════
# page/page_size must be bounded -- page_size=0 divides by zero in
# paginate() (a real HTTP 500), and a negative page/page_size produces a
# negative slice start, which Python silently reinterprets as an index from
# the end of the list rather than raising. Both routes reject an out-of-range value with FastAPI's
# own 422, before paginate() ever runs.
# ═══════════════════════════════════════════════════════════════════════════

def test_samples_page_size_zero_is_rejected_not_a_500(client):
    resp = client.get("/samples", params={"page_size": 0})
    assert resp.status_code == 422


def test_samples_negative_page_is_rejected_not_a_silent_wrong_slice(client):
    resp = client.get("/samples", params={"page": -1, "page_size": 2})
    assert resp.status_code == 422


def test_samples_negative_page_size_is_rejected(client):
    resp = client.get("/samples", params={"page_size": -5})
    assert resp.status_code == 422


def test_timepoints_page_size_zero_is_rejected_not_a_500(client):
    resp = client.get("/timepoints", params={"page_size": 0})
    assert resp.status_code == 422


def test_timepoints_negative_page_is_rejected_not_a_silent_wrong_slice(client):
    resp = client.get("/timepoints", params={"page": -1, "page_size": 2})
    assert resp.status_code == 422
