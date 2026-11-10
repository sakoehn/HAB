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
    reject a call without it, before the route body ever runs. Ported from test_unit_backend.py's
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


# date_from/date_to must be compared as real dates, not as plain text
# against the stored unpadded "M/D/YY H:MM" datetime -- a text comparison
# makes a date_to empty the results and a date_from filter nothing.
# All dates below are inside the real dataset's range (2021-05-27..2021-06-18,
# confirmed live via /status's date_min/date_max).

def test_date_to_no_longer_empties_the_results(client):
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_to": "2021-06-05"},
    )
    resp.raise_for_status()
    body = resp.json()
    assert body["data"], "date_to must not empty the results"
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
        "date_from must narrow sample_count below the unfiltered total"
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


# depth must be in this route's response for kegg/cog/enzyme so the
# frontend can rank-filter down to real leaf annotations -- the top-25 by
# mean_egc is otherwise 100% branch/rollup nodes, since a parent's EGC is
# the sum of its descendants.
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


# An unparseable date_from/date_to must be rejected, not silently ignored --
# ignoring it falls through to the FULL unfiltered dataset while still
# echoing the bound back as if it had been applied. Each example below is a
# plausible hand-typed value that isn't the one supported "YYYY-MM-DD" shape.

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
    # The validation must not reject the real, supported "YYYY-MM-DD" shape every other test here relies on.
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_from": "2021-06-10"},
    )
    resp.raise_for_status()
    assert resp.json()["data"]


# ── What the in-process cache keeps ─────────────────────────────────────────

def test_cache_keeps_only_the_rows_a_request_can_return(client, monkeypatch):
    """limit is at most 200, so the cache never needs more than the top 200
    -- not the full ranking (68,820 taxonomy rows, tens of MB per entry)."""
    from collections import OrderedDict
    import api.routes as routes_mod
    monkeypatch.setattr(routes_mod, "_TOP_ANN_CACHE_SQL", OrderedDict())

    small = client.get("/annotations/top", params={"source": "taxonomy", "limit": 5}).json()
    (_key, (_inserted_at, (rows, _count))), = routes_mod._TOP_ANN_CACHE_SQL.items()
    assert len(rows) == 200
    full = client.get("/annotations/top", params={"source": "taxonomy", "limit": 200}).json()
    assert full["data"][:5] == small["data"]
    assert len(full["data"]) == 200


def test_same_date_written_two_ways_shares_one_cache_entry(client, monkeypatch):
    from collections import OrderedDict
    import api.routes as routes_mod
    monkeypatch.setattr(routes_mod, "_TOP_ANN_CACHE_SQL", OrderedDict())

    a = client.get("/annotations/top", params={"source": "cog", "limit": 10, "date_from": "2021-05-20"}).json()
    b = client.get("/annotations/top", params={"source": "cog", "limit": 10, "date_from": "2021-05-20T00:00:00"}).json()
    assert a["data"] == b["data"]
    assert len(routes_mod._TOP_ANN_CACHE_SQL) == 1


@pytest.mark.parametrize("first", ["2021-06-05", "2021-06-05T00:00:00"])
def test_whole_day_and_midnight_date_to_do_not_share_an_entry(client, monkeypatch, first):
    """A bare date_to means the whole day; with a time it means up to that
    moment. They select different samples, so whichever is asked first
    must not be served for the other."""
    from collections import OrderedDict
    import api.routes as routes_mod
    monkeypatch.setattr(routes_mod, "_TOP_ANN_CACHE_SQL", OrderedDict())

    second = "2021-06-05T00:00:00" if first == "2021-06-05" else "2021-06-05"
    counts = {}
    for date_to in (first, second):
        counts[date_to] = client.get(
            "/annotations/top", params={"source": "cog", "limit": 5, "date_to": date_to},
        ).json()["sample_count"]
    assert counts["2021-06-05"] > counts["2021-06-05T00:00:00"]


# ids=: a page that grouped the top list by parent asks for the parents'
# own totals, which may not be in the top 200, worked out the same way and
# over the same dates as the list itself.

def _by_id(body):
    return {r["annotation_id"]: r for r in body["data"]}


@pytest.mark.parametrize("dates", [{}, {"date_from": "2021-06-02", "date_to": "2021-06-04"}])
def test_ids_return_the_same_values_as_the_top_list(client, dates):
    top = client.get("/annotations/top", params={"source": "kegg", "limit": 200, **dates}).json()
    wanted = [r["annotation_id"] for r in top["data"][:3]] + [top["data"][-1]["annotation_id"]]
    picked = client.get("/annotations/top", params={"source": "kegg", "ids": wanted, **dates}).json()
    assert set(_by_id(picked)) == set(wanted)
    for aid in wanted:
        assert _by_id(picked)[aid] == _by_id(top)[aid]
    assert picked["sample_count"] == top["sample_count"]


def test_ids_reach_annotations_outside_the_top_200(client):
    top = _by_id(client.get("/annotations/top", params={"source": "cog", "limit": 200}).json())
    outside = next(
        r["annotation_id"] for r in client.get(
            "/search/annotations", params={"q": "COG01", "sources": "cog", "page_size": 500},
        ).json()["data"] if r["annotation_id"] not in top
    )
    picked = client.get("/annotations/top", params={"source": "cog", "ids": [outside]}).json()
    assert [r["annotation_id"] for r in picked["data"]] == [outside]


def test_ids_with_a_date_range_cover_only_those_dates(client):
    whole = _by_id(client.get("/annotations/top", params={"source": "cog", "ids": ["E"]}).json())["E"]
    part = _by_id(client.get(
        "/annotations/top", params={"source": "cog", "ids": ["E"], "date_from": "2021-06-02", "date_to": "2021-06-04"},
    ).json())["E"]
    assert part["sample_count"] < whole["sample_count"]


def test_too_many_ids_is_rejected(client):
    resp = client.get("/annotations/top", params={"source": "kegg", "ids": [f"K{i:05d}" for i in range(201)]})
    assert resp.status_code == 422


# depth=: every category's EGC contains its members', so an unfiltered top
# list is all categories (KEGG's top 25 has no KO). depth ranks only the
# given level(s), so "top 25 KOs" is possible.

@pytest.mark.parametrize("dates", [{}, {"date_from": "2021-06-02", "date_to": "2021-06-04"}])
def test_depth_ranks_only_that_level(client, dates):
    body = client.get("/annotations/top", params={"source": "kegg", "limit": 25, "depth": 4, **dates}).json()
    assert len(body["data"]) == 25
    assert {r["depth"] for r in body["data"]} == {4}
    assert all(r["annotation_id"].startswith("K") for r in body["data"])
    egc = [r["mean_egc"] for r in body["data"]]
    assert egc == sorted(egc, reverse=True)


def test_depth_rows_match_the_unfiltered_values(client):
    top_ko = client.get("/annotations/top", params={"source": "cog", "limit": 5, "depth": 2}).json()["data"]
    picked = _by_id(client.get("/annotations/top", params={"source": "cog", "ids": [r["annotation_id"] for r in top_ko]}).json())
    for r in top_ko:
        assert picked[r["annotation_id"]] == r


def test_several_depths_rank_together(client):
    body = client.get("/annotations/top", params={"source": "taxonomy", "limit": 50, "depth": [6, 7]}).json()
    assert {r["depth"] for r in body["data"]} == {6, 7}


def test_depth_is_part_of_the_cache_key(client, monkeypatch):
    from collections import OrderedDict
    import api.routes as routes_mod
    monkeypatch.setattr(routes_mod, "_TOP_ANN_CACHE_SQL", OrderedDict())

    every = client.get("/annotations/top", params={"source": "enzyme", "limit": 10}).json()["data"]
    leaves = client.get("/annotations/top", params={"source": "enzyme", "limit": 10, "depth": 4}).json()["data"]
    again = client.get("/annotations/top", params={"source": "enzyme", "limit": 10, "depth": [4]}).json()["data"]
    assert {r["depth"] for r in every} != {4}
    assert {r["depth"] for r in leaves} == {4}
    assert again == leaves
    assert len(routes_mod._TOP_ANN_CACHE_SQL) == 2


@pytest.mark.parametrize("bad", [0, 9])
def test_depth_out_of_range_is_rejected(client, bad):
    assert client.get("/annotations/top", params={"source": "kegg", "depth": bad}).status_code == 422
