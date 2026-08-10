"""
test_mappings_search_route.py
===============================
Live-HTTP tests for /mappings/search under DATA_BACKEND=sql -- same spirit
as test_annotation_scaffolds_route.py: hits a real running server rather
than calling cache_sql functions directly, so it covers route-layer logic
(sample_count filtering, unique_pairs dedup, response envelope, sort order)
that tests/sql/test_mappings_sql.py's direct get_mappings_sql() tests don't
touch at all.

Skips automatically unless a server is reachable and running with
DATA_BACKEND=sql (checked via /sql-test, same convention as the other
*_route.py files in this folder).

Run:
    # in FastAPI/.env or as an env var: DATA_BACKEND=sql
    # uvicorn main:app --reload
    pytest tests/sql/test_mappings_search_route.py -v
"""

import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))
from api.index import timepoint_dt_sort_key

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


# ═══════════════════════════════════════════════════════════════════════════
# Known real example used throughout -- same gene tests/sql/test_mappings_sql.py
# already independently verified: sample 3300060358, gene
# Ga0590986_0000001_100946_102454, cog_id=COG0055, kegg_id=KO:K02112,
# two distinct EC hits (EC:7.1.2.2, EC:7.2.2.1).
# ═══════════════════════════════════════════════════════════════════════════

EXPECTED_ROW_KEYS = {
    "sample", "gene_id", "contig_id", "kegg_id", "cog_id", "enzyme", "taxonomy", "timepoint",
}


@sql_route_required
def test_search_returns_correct_shape(client):
    """Response envelope has the expected top-level keys, and every row in
    `data` has exactly the 8 fields the route is supposed to attach
    (get_mappings_sql's 7 + the route-added `timepoint`) -- no more, no
    fewer, regardless of which sample/gene it came from."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "COG0055", "source": "cog", "sample_count": 3},
    )
    assert resp.status_code == 200
    body = resp.json()

    assert set(body.keys()) == {"annotation_id", "source", "sample_count", "total", "data"}
    assert body["annotation_id"] == "COG0055"
    assert body["source"] == "cog"
    assert body["total"] == len(body["data"])
    assert body["data"], "expected at least one matching row"

    for row in body["data"]:
        assert set(row.keys()) == EXPECTED_ROW_KEYS


@sql_route_required
def test_unique_pairs_dedupes_results(client):
    """unique_pairs=true returns a smaller total than the same request
    without it -- every remaining row has a distinct
    (taxonomy, kegg_id, enzyme, cog_id) combination."""
    resp_false = client.get(
            "/mappings/search",
            params={"annotation_id": "COG0055", "source": "cog", "sample_count": 3},
    )
    resp_true = client.get(
            "/mappings/search",
            params={"annotation_id": "COG0055", "source": "cog", "sample_count": 3, "unique_pairs": True},
    )
    assert resp_true.json()['total'] < resp_false.json()['total']


@sql_route_required
def test_sample_count_limits_to_earliest_samples(client):
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "COG0055", "source": "cog", "sample_count": 3},
    )
    body = resp.json()
    allowed = {'3300060410', '3300067202', '3300060358'}

    samples_in_response = {row["sample"] for row in body["data"]}
    assert samples_in_response <= allowed


@sql_route_required
def test_results_sorted_chronologically(client):
    """body["data"]'s timepoints are non-decreasing, checked via
    api.index.timepoint_dt_sort_key the same way the route itself does --
    raw datetime strings aren't comparable directly (unpadded timestamps)."""
    resp = client.get(
            "/mappings/search",
            params={"annotation_id": "COG0055", "source": "cog", "sample_count": 3},
    )
    body = resp.json()

    keys = [timepoint_dt_sort_key(row["timepoint"]["datetime"]) for row in body["data"]]
    is_ascending = all(keys[i] <= keys[i + 1] for i in range(len(keys) - 1))

    assert resp.status_code == 200
    assert is_ascending


@sql_route_required
def test_exact_match_rejects_substring_query(client):
    """A partial/substring annotation_id ("COG005" instead of "COG0055")
    returns total=0 on the sql backend -- locks in the deliberate
    exact-match-only design decision, at the route level this time rather
    than the get_mappings_sql level."""
    resp = client.get(
            "/mappings/search",
            params={"annotation_id": "COG005", "source": "cog", "sample_count": 3},
    )
    body = resp.json()
    assert resp.status_code == 200
    assert body['total'] == 0
