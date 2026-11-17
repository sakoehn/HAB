"""
test_search_annotations_sql_route.py
======================================
Live-HTTP tests for /search/annotations -- same
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
    "match",  # added by the route: exact / starts / contains
}


def test_search_returns_correct_shape(client):
    """Response envelope has the expected top-level keys, and every row in
    `data` has exactly get_search_annotations()'s 12 fields plus the
    route's `match` -- see the
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
    checked before the route body runs.
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


_MATCH_TIER = {"exact": 0, "starts": 1, "contains": 2}


def test_results_closest_matches_first_then_by_mean_egc(client):
    """Every row says how closely it matched; rows come exact, then starts
    with, then contains, and by mean_egc (descending) within each group."""
    resp = client.get(
            "/search/annotations",
            params={"q": "iron", "sources": ["cog", "kegg"], "page_size": 5000},
    )
    body = resp.json()['data']
    keys = [(_MATCH_TIER[r["match"]], -r["mean_egc"]) for r in body]
    assert keys == sorted(keys)
    assert {r["match"] for r in body} >= {"starts", "contains"}


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


# ── % and _ are searched for literally, not as SQL wildcards ────────────────

def test_percent_signs_are_literal_not_match_everything(client):
    """'%%%' contains no wildcard meaning for the user -- no real annotation
    name contains it, so nothing matches (before, it matched every row)."""
    resp = client.get("/search/annotations", params={"q": "%%%", "sources": "cog"})
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


def test_underscore_is_literal(client):
    """'_' would otherwise match any single character, so '___' would match
    every name of 3+ characters."""
    resp = client.get("/search/annotations", params={"q": "___", "sources": "cog"})
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


def test_surrounding_spaces_are_ignored(client):
    padded = client.get("/search/annotations", params={"q": "  synthase  ", "sources": "cog", "page_size": 5000}).json()
    plain  = client.get("/search/annotations", params={"q": "synthase", "sources": "cog", "page_size": 5000}).json()
    assert plain["total"] > 0
    assert padded["total"] == plain["total"]


# Ids are stored bare ("K00001", "1.1.1.1"), but KEGG, papers and the
# Methods page write them with a KO:/EC: prefix. A prefix typed into any
# search box is dropped before matching, so both forms find the same thing.

def _ids(client, **params):
    body = client.get("/search/annotations", params={"page_size": 5000, **params}).json()
    return {(r["source"], r["annotation_id"]) for r in body["data"]}


@pytest.mark.parametrize("typed", ["EC:1.1.1.1", "ec:1.1.1.1", "EC: 1.1.1.1"])
def test_ec_prefix_finds_the_enzyme(client, typed):
    prefixed = _ids(client, q=typed, sources=["enzyme"])
    assert ("enzyme", "1.1.1.1") in prefixed
    assert prefixed == _ids(client, q="1.1.1.1", sources=["enzyme"])


def test_ec_prefix_across_all_sources_matches_the_bare_search(client):
    sources = ["kegg", "cog", "enzyme", "taxonomy"]
    prefixed = _ids(client, q="EC:1.1.1.1", sources=sources)
    assert ("enzyme", "1.1.1.1") in prefixed
    assert prefixed == _ids(client, q="1.1.1.1", sources=sources)


@pytest.mark.parametrize("typed", ["KO:K00001", "ko:K00001"])
def test_ko_prefix_finds_the_kegg_ortholog(client, typed):
    assert _ids(client, q=typed, sources=["kegg"]) == _ids(client, q="K00001", sources=["kegg"]) == {("kegg", "K00001")}


def test_prefixed_short_id_is_still_the_exact_class_lookup(client):
    resp = client.get("/search/annotations", params={"q": "EC:3", "sources": ["enzyme", "cog"]})
    assert [(r["source"], r["annotation_id"]) for r in resp.json()["data"]] == [("enzyme", "3")]


def test_prefixed_exact_annotation_id(client):
    assert _ids(client, annotation_id="KO:K00001", sources=["kegg"]) == {("kegg", "K00001")}
    assert _ids(client, annotation_id="EC:1.1.1.1", sources=["enzyme"]) == {("enzyme", "1.1.1.1")}


def test_a_bare_prefix_is_searched_as_text_not_rejected(client):
    resp = client.get("/search/annotations", params={"q": "EC:", "sources": ["kegg"]})
    assert resp.status_code == 200


# Closest matches first: an exact id or name, then ids/names starting with
# the text, then the rest, by mean EGC within each group. Abundance alone
# buried exact ids under longer ones that contain them (2.7.1.1 was 43rd of
# 62, behind 2.7.1.10 ... 2.7.1.199) and off the 25-row Lookup page.

@pytest.mark.parametrize("typed", ["2.7.1.1", "EC:2.7.1.1"])
def test_exact_ec_number_comes_first_and_on_the_first_page(client, typed):
    body = client.get("/search/annotations", params={"q": typed, "sources": ["enzyme"], "page_size": 25}).json()
    assert body["total"] > 25
    assert (body["data"][0]["annotation_id"], body["data"][0]["match"]) == ("2.7.1.1", "exact")
    assert all(r["match"] != "exact" for r in body["data"][1:])


def test_full_ko_name_is_an_exact_match(client):
    """KO names are JGI's descriptions, with no gene symbol in front."""
    body = client.get("/search/annotations", params={
        "q": "photosystem II P680 reaction center D1 protein", "sources": ["kegg"],
    }).json()
    assert (body["data"][0]["annotation_id"], body["data"][0]["match"]) == ("K02703", "exact")


def test_name_starting_with_the_text_beats_a_more_abundant_mention(client):
    params = {"q": "nitrogen", "sources": ["kegg", "cog", "enzyme"], "page_size": 500}
    body = client.get("/search/annotations", params=params).json()
    first = body["data"][0]
    assert first["annotation_id"] == "COG0347"  # Nitrogen regulatory protein PII
    assert first["match"] == "starts"
    mentions = [r["mean_egc"] for r in body["data"] if r["match"] == "contains"]
    assert max(mentions) > first["mean_egc"]


def test_exact_taxon_name_comes_before_longer_names(client):
    body = client.get("/search/annotations", params={"q": "Synechococcus", "sources": ["taxonomy"]}).json()
    first = body["data"][0]
    assert first["name"] == "Synechococcus" and first["match"] == "exact"
    assert body["data"][1]["match"] != "exact" or body["data"][1]["name"] == "Synechococcus"


def test_every_row_on_a_later_page_has_its_category_and_scaffold_count(client):
    """category/scaffold_count are looked up after the page is cut out, so
    check a page other than the first: each row's values must be the
    annotation's own, as stored in annotation_series."""
    import sqlite3
    response = client.get("/search/annotations", params={
        "q": "synthase", "sources": ["cog", "kegg", "enzyme"], "page": 3, "page_size": 40})
    rows = response.json()["data"]
    assert len(rows) == 40
    conn = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    try:
        for row in rows:
            stored = conn.execute(
                "SELECT DISTINCT category, scaffold_count FROM annotation_series WHERE source = ? AND annotation_id = ?",
                (row["source"], row["annotation_id"])).fetchall()
            assert row["category"] in {c for c, _ in stored}, row["annotation_id"]
            assert row["scaffold_count"] in {s for _, s in stored}, row["annotation_id"]
    finally:
        conn.close()


def test_category_and_scaffold_count_are_looked_up_only_for_the_page(client, monkeypatch):
    """Looking them up for every match read thousands of annotation_series
    rows nobody was shown: 1.07 s live for "Vibrio" (2,199 matches), against
    0.04 s without."""
    import api.routes as routes
    looked_up = []
    real = routes.add_series_details

    def spy(conn, rows):
        looked_up.append(len(rows))
        return real(conn, rows)

    monkeypatch.setattr(routes, "add_series_details", spy)
    body = client.get("/search/annotations", params={
        "q": "synthase", "sources": ["cog", "kegg", "enzyme"], "page": 2, "page_size": 25}).json()
    assert body["total"] > 25
    assert looked_up == [25]
