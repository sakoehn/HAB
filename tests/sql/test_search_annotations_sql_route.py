"""
test_search_annotations_sql_route.py
======================================
Live-HTTP tests for /search/annotations under DATA_BACKEND=sql -- same
spirit as test_mappings_search_route.py: hits a real running server, so it
covers route-layer logic (min-length rejection, pagination, sort order,
response envelope) that tests/sql/test_search_annotations_sql.py's direct
get_search_annotations() tests don't touch at all.

Skips automatically unless a server is reachable and running with
DATA_BACKEND=sql.

Known real example used throughout: q="synthase" is a real cross-source
substring, independently confirmed against the live database (cog=178,
kegg=441, enzyme=296 distinct matches, taxonomy=0).

Note: get_search_annotations()'s rows only have 10 keys (source,
annotation_id, name, parent, depth, mean_egc, max_egc, mean_norm_egc,
max_norm_egc, sample_count) -- unlike the JSON branch's per-row dict,
which always adds "sample": "" and "timepoint": None (always-placeholder
values, never real per-search-result data) plus a "value" field. Confirmed
the frontend's LeftResultList.tsx never reads any of those three for
search results, so this is a real but low-risk shape difference between
backends, not something this test pretends doesn't exist. `depth` was
added alongside the taxonomy_egc_homonym_bug fix so search results can
show taxonomic rank.

Run:
    # in FastAPI/.env or as an env var: DATA_BACKEND=sql
    # uvicorn main:app --reload
    pytest tests/sql/test_search_annotations_sql_route.py -v
"""

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


# Every test below takes a `client` parameter to receive this fixture's value
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def client():
    with httpx.Client(base_url=API_BASE_URL, timeout=30.0) as c:
        yield c


EXPECTED_ROW_KEYS = {
    "source", "annotation_id", "name", "parent", "depth",
    "mean_egc", "max_egc", "mean_norm_egc", "max_norm_egc", "sample_count",
}


@sql_route_required
def test_search_returns_correct_shape(client):
    """Response envelope has the expected top-level keys, and every row in
    `data` has exactly get_search_annotations()'s 9 fields -- see the
    module docstring for why this deliberately does NOT include
    sample/timepoint/value the way the JSON branch's rows do."""
    resp = client.get(
        "/search/annotations",
        params={"q": "synthase", "sources": ["cog", "kegg"]},
    )
    assert resp.status_code == 200
    body = resp.json()

    assert set(body.keys()) == {"query", "annotation_id", "name_exact", "sources", "total", "page", "page_size", "total_pages", "data"}
    assert body["query"] == "synthase"
    assert body["sources"] == ["cog", "kegg"]
    assert body["total"] == len(body["data"]) or body["total"] > len(body["data"])  # total is pre-pagination
    assert body["data"], "expected at least one matching row"

    for row in body["data"]:
        assert set(row.keys()) == EXPECTED_ROW_KEYS


@sql_route_required
def test_query_too_short_rejected(client):
    """q with fewer than 3 characters should be rejected with a 400, not
    silently truncated or treated as a valid (dangerously broad) search --
    this is the actual HTTP-level enforcement of the min-length rule,
    complementing (not duplicating) any function-level check."""
    resp = client.get(
        "/search/annotations",
        params={"q": "ab", "sources": ["cog", "kegg"]},
    )
    assert resp.status_code == 400


@sql_route_required
def test_pagination_slices_correctly(client):
    """page=1 and page=2 (page_size=5) return different, non-overlapping
    rows, and `total` reflects the full unpaginated match count, not just
    the page size."""
    resp1 = client.get("/search/annotations",
            params={"q": "synthase", "sources": ["cog", "kegg", "enzyme", "taxonomy"], "page_size": 5, "page": 1})
    resp2 = client.get("/search/annotations",
            params={"q": "synthase", "sources": ["cog", "kegg", "enzyme", "taxonomy"], "page_size": 5, "page": 2})
    body1, body2 = resp1.json(), resp2.json()

    ids1 = {row["annotation_id"] for row in body1["data"]}
    ids2 = {row["annotation_id"] for row in body2["data"]}
    assert ids1.isdisjoint(ids2)
    assert body1["total"] == body2["total"]
    assert body1["total"] > 5


@sql_route_required
def test_results_sorted_by_mean_egc_descending(client):
    """body["data"]'s mean_egc values are non-increasing -- same idea as
    test_mappings_search_route.py's chronological-sort test, just a
    numeric comparison instead of a timepoint one."""
    resp = client.get(
            "/search/annotations",
            params={"q": "iron", "sources": ["cog", "kegg"]},
    )
    body = resp.json()['data']
    is_descending = all(body[i]["mean_egc"] >= body[i + 1]["mean_egc"] for i in range(len(body) - 1))
    assert is_descending
