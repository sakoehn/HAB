"""
test_search_annotations_sql_route.py
======================================
Live-HTTP tests for /search/annotations under DATA_BACKEND=sql -- same
spirit as test_mappings_search_route.py: hits a real running server, so it
covers route-layer logic (min-length rejection, pagination, sort order,
response envelope) that tests/sql/test_search_annotations_sql.py's direct
get_search_annotations() tests don't touch at all.

Self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER (`with
TestClient(app) as client:`) rather than requiring a separately running
uvicorn server -- see tests/sql/test_samples_and_timepoints_route.py's
module docstring for why the old httpx.Client-against-a-live-server
pattern silently contributed zero coverage in every normal `pytest
tests/` run.

Known real example used throughout: q="synthase" is a real cross-source
substring, independently confirmed against the live database (cog=178,
kegg=441, enzyme=296 distinct matches, taxonomy=0).

Note: get_search_annotations()'s rows have 12 keys (source, annotation_id,
name, parent, depth, mean_egc, max_egc, mean_norm_egc, max_norm_egc,
sample_count, category, scaffold_count) -- unlike the JSON branch's per-row
dict, which always adds "sample": "" and "timepoint": None (always-placeholder
values, never real per-search-result data) plus a "value" field (which nests
its own category/scaffolds/depth instead of exposing them top-level).
Confirmed the frontend's LeftResultList.tsx never reads sample/timepoint/value
for search results, so this is a real but low-risk shape difference between
backends, not something this test pretends doesn't exist. `depth` lets
search results show taxonomic rank. `category`/`scaffold_count` are top-level fields for
the Annotation Lookup detail card.

Run:
    # in FastAPI/.env or as an env var: DATA_BACKEND=sql
    # uvicorn main:app --reload
    pytest tests/sql/test_search_annotations_sql_route.py -v
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

# Every test below takes a `client` parameter to receive this fixture's value
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as c:
        yield c


EXPECTED_ROW_KEYS = {
    "source", "annotation_id", "name", "parent", "depth",
    "mean_egc", "max_egc", "mean_norm_egc", "max_norm_egc", "sample_count",
    "category", "scaffold_count",
}


def test_search_returns_correct_shape(client):
    """Response envelope has the expected top-level keys, and every row in
    `data` has exactly get_search_annotations()'s 12 fields -- see the
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


def test_missing_all_of_q_annotation_id_name_exact_returns_400(client):
    """The route requires at least one of q/annotation_id/name_exact --
    checked before the DATA_BACKEND branch, so it's backend-agnostic.
    Distinct from test_query_too_short_rejected below (q present but too
    short); this is q absent entirely. Ported from test_unit_backend.py's
    TestRoutesViaTestClient (deleted alongside the rest of that class once
    this route's real coverage lived here instead)."""
    resp = client.get("/search/annotations", params={"sources": ["cog"]})
    assert resp.status_code == 400


# A 1-2 character q is an exact (case-insensitive) ID lookup, not a
# substring search: a short substring would match nearly everything, but
# the 25 COG category letters and 7 EC classes are real 1-character IDs
# that used to be unsearchable (400) from Lookup/Analyze/Compare.

def test_short_query_is_an_exact_id_lookup_not_rejected(client):
    """A short q with no matching ID returns an empty 200, not a 400 -- and
    is never treated as a broad substring search."""
    resp = client.get(
        "/search/annotations",
        params={"q": "ab", "sources": ["cog", "kegg"]},
    )
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


@pytest.mark.parametrize("q", ["E", "e"])
def test_single_letter_finds_the_cog_category(client, q):
    resp = client.get("/search/annotations", params={"q": q, "sources": ["cog"]})
    assert resp.status_code == 200
    body = resp.json()
    assert [(r["source"], r["annotation_id"]) for r in body["data"]] == [("cog", "E")]
    assert body["data"][0]["name"] == "Amino acid transport and metabolism"


def test_single_digit_finds_the_ec_class(client):
    resp = client.get("/search/annotations", params={"q": "3", "sources": ["enzyme", "cog"]})
    assert resp.status_code == 200
    assert [(r["source"], r["annotation_id"], r["name"]) for r in resp.json()["data"]] == [
        ("enzyme", "3", "Hydrolases")
    ]


def test_blank_query_is_rejected_not_treated_as_match_everything(client):
    resp = client.get("/search/annotations", params={"q": "   ", "sources": ["cog"]})
    assert resp.status_code == 400


def test_short_query_does_not_substring_match(client):
    """'E' is a substring of thousands of names/IDs -- only the exact ID
    may come back, and only from the requested sources."""
    resp = client.get("/search/annotations", params={"q": "E", "sources": ["kegg", "enzyme"]})
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


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


# page/page_size must be bounded -- page_size=0 divides by zero in
# paginate() (a real HTTP 500), and a
# negative page/page_size produces a negative slice start, which Python
# silently reinterprets as an index from the end of the list rather than
# raising (page_size=-5 would return 200 with the tail silently dropped).

def test_page_size_zero_is_rejected_not_a_500(client):
    resp = client.get(
        "/search/annotations",
        params={"q": "iron", "sources": ["cog"], "page_size": 0},
    )
    assert resp.status_code == 422


def test_negative_page_size_is_rejected_not_a_silent_tail_drop(client):
    resp = client.get(
        "/search/annotations",
        params={"q": "iron", "sources": ["cog"], "page_size": -5},
    )
    assert resp.status_code == 422


def test_negative_page_is_rejected(client):
    resp = client.get(
        "/search/annotations",
        params={"q": "iron", "sources": ["cog"], "page": -1, "page_size": 5},
    )
    assert resp.status_code == 422


# `sources` is typed list[AnnotationSource] so an unknown source name is
# rejected with a 422 before the query runs -- as plain strings it would
# silently match zero rows and come back 200/total:0, indistinguishable
# from "these are real sources, there just happened to be no matches".

def test_unknown_source_name_is_rejected_not_a_silent_empty_result(client):
    resp = client.get(
        "/search/annotations",
        params={"q": "iron", "sources": ["bogus"]},
    )
    assert resp.status_code == 422


def test_real_source_names_still_work(client):
    resp = client.get(
        "/search/annotations",
        params={"q": "iron", "sources": ["cog", "kegg", "enzyme", "taxonomy"]},
    )
    assert resp.status_code == 200
    assert resp.json()["total"] > 0


def test_one_unknown_source_mixed_with_real_ones_is_still_rejected(client):
    resp = client.get(
        "/search/annotations",
        params={"q": "iron", "sources": ["cog", "bogus"]},
    )
    assert resp.status_code == 422
