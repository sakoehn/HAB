"""
test_top_annotations_route.py
================================
Self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER (`with
TestClient(app) as client:`) rather than requiring a separately running
uvicorn server -- this correctly runs main.py's lifespan() so
app.state.sql_conn is set up, and needs nothing external to actually run.
The previous version of this file (httpx.Client against a live server,
skipped whenever no server happened to be running) silently contributed
zero coverage in every normal `pytest tests/` run.

Run:
    pytest tests/sql/test_top_annotations_route.py -v
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


def test_missing_source_returns_422(client):
    """`source` has no default -- FastAPI's own request validation must
    reject a call without it, before the route body (and its DATA_BACKEND
    branch) ever runs. Ported from test_unit_backend.py's
    TestRoutesViaTestClient (deleted alongside the rest of that class once
    this route's real coverage lived here instead)."""
    resp = client.get("/annotations/top")
    assert resp.status_code == 422


def test_sorted_results(client):
    resp = client.get("/annotations/top", params={"source": "cog", "limit": 10})
    resp.raise_for_status()
    data = resp.json()["data"]
    means = [row["mean_egc"] for row in data]
    assert len(data) == 10
    assert means == sorted(means, reverse=True)


def test_caching_consistency(client):
    resp_5 = client.get("/annotations/top", params={"source": "cog", "limit": 5})
    resp_5.raise_for_status()
    top_5 = resp_5.json()["data"]

    resp_20 = client.get("/annotations/top", params={"source": "cog", "limit": 20})
    resp_20.raise_for_status()
    top_20 = resp_20.json()["data"]

    assert top_20[:5] == top_5


def test_invalid_source(client):
    resp = client.get("/annotations/top", params={"source": "INVALID_SOURCE", "limit": 10})
    assert resp.status_code == 422


# W2: date_from/date_to were compared as plain text against the stored
# unpadded "M/D/YY H:MM" datetime, so a date_to always emptied the results
# and a date_from never filtered anything (the whole-dataset ranking came
# back mislabeled with the requested range, sample_count stuck at 128).
# All dates below are inside the real dataset's range (2021-05-27..2021-06-18,
# confirmed live via /status's date_min/date_max).

def test_date_to_no_longer_empties_the_results(client):
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_to": "2021-06-05"},
    )
    resp.raise_for_status()
    body = resp.json()
    assert body["data"], "date_to must not empty the results (W2 regression)"
    assert 0 < body["sample_count"] < 128


def test_date_from_actually_filters_and_is_not_identical_to_unfiltered(client):
    unfiltered = client.get("/annotations/top", params={"source": "cog", "limit": 10})
    unfiltered.raise_for_status()

    filtered = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_from": "2021-06-15"},
    )
    filtered.raise_for_status()
    filtered_body = filtered.json()

    assert filtered_body["sample_count"] < unfiltered.json()["sample_count"], \
        "date_from must narrow sample_count below the unfiltered total (W2 regression)"
    assert filtered_body["sample_count"] < 128


def test_sample_count_reflects_the_active_filter_not_the_whole_dataset(client):
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 5, "date_from": "2021-05-27", "date_to": "2021-05-28"},
    )
    resp.raise_for_status()
    body = resp.json()
    # Independently verified against raw TIMEPOINTS: exactly 9 of the 128
    # samples fall within 2021-05-27..2021-05-28 inclusive.
    assert body["sample_count"] == 9


# A8 (docs/AUDIT-2026-10-05.md): depth was missing from this route's response
# entirely for kegg/cog/enzyme, so the frontend had no way to rank-filter
# down to real leaf annotations -- the top-25 by mean_egc is otherwise 100%
# branch/rollup nodes, since a parent's EGC is the sum of its descendants.
# Covers both response code paths: the unfiltered fast path (reads
# annotation_catalog) and the date-filtered live-aggregation path (reads
# annotation_series) -- they're different functions and must both carry it.

def test_depth_is_present_on_every_row_unfiltered_fast_path(client):
    resp = client.get("/annotations/top", params={"source": "kegg", "limit": 25})
    resp.raise_for_status()
    rows = resp.json()["data"]
    assert len(rows) == 25
    assert all(row.get("depth") is not None for row in rows)
    # The real bug this unlocks fixing: without a depth filter applied,
    # the top 25 kegg rows by mean_egc are entirely non-leaf nodes.
    assert all(row["depth"] < 4 for row in rows)


def test_depth_is_present_on_every_row_date_filtered_path(client):
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_from": "2021-06-15"},
    )
    resp.raise_for_status()
    rows = resp.json()["data"]
    assert rows
    assert all(row.get("depth") is not None for row in rows)


# A5 (docs/AUDIT-2026-10-05.md): an unparseable date_from/date_to used to be
# silently ignored -- falling through to the FULL unfiltered dataset while
# still being echoed back in the response as if it had been applied. Each
# example below is the audit's own cited case: a plausible hand-typed value
# that isn't the one supported "YYYY-MM-DD" shape.

@pytest.mark.parametrize("bad_date_from", [
    "06/10/2021",   # US format
    "6/10/21",
    "June 10 2021",
    "2021-13-99",   # not even a real date
])
def test_unparseable_date_from_is_rejected_not_silently_ignored(client, bad_date_from):
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_from": bad_date_from},
    )
    assert resp.status_code == 400


def test_unparseable_date_to_is_rejected_not_silently_ignored(client):
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_to": "June 10 2021"},
    )
    assert resp.status_code == 400


def test_a_valid_date_still_works_after_the_validation_added(client):
    # Regression safety: A5's new check must not reject the real,
    # already-supported "YYYY-MM-DD" shape every other test here relies on.
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_from": "2021-06-10"},
    )
    resp.raise_for_status()
    assert resp.json()["data"]
