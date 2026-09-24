"""
test_mappings_search_route.py
===============================
Live-HTTP tests for /mappings/search under DATA_BACKEND=sql -- same spirit
as test_annotation_scaffolds_route.py: hits a real running server rather
than calling cache_sql functions directly, so it covers route-layer logic
(sample_count filtering, unique_pairs dedup, response envelope, sort order)
that tests/sql/test_mappings_sql.py's direct get_mappings_sql() tests don't
touch at all.

Self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER (`with
TestClient(app) as client:`) rather than requiring a separately running
uvicorn server -- see tests/sql/test_samples_and_timepoints_route.py's
module docstring for why the old httpx.Client-against-a-live-server
pattern silently contributed zero coverage in every normal `pytest
tests/` run.

Run:
    pytest tests/sql/test_mappings_search_route.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))
from api.config import SQLITE_DB_PATH
from api.index import timepoint_dt_sort_key

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
# Known real example used throughout -- same gene tests/sql/test_mappings_sql.py
# already independently verified: sample 3300060358, gene
# Ga0590986_0000001_100946_102454, cog_id=COG0055, kegg_id=KO:K02112,
# two distinct EC hits (EC:7.1.2.2, EC:7.2.2.1).
# ═══════════════════════════════════════════════════════════════════════════

EXPECTED_ROW_KEYS = {
    "sample", "gene_id", "contig_id", "kegg_id", "cog_id", "enzyme", "taxonomy", "timepoint",
}


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

    # W24 (docs/AUDIT-2026-09-22.md) added samples_were_capped/leaf_count
    # (non-leaf-id disclosure) and real page/page_size/total_pages
    # pagination alongside the pre-existing keys.
    assert set(body.keys()) == {
        "annotation_id", "source", "sample_count", "samples_were_capped",
        "leaf_count", "total", "page", "page_size", "total_pages", "data",
    }
    assert body["annotation_id"] == "COG0055"
    assert body["source"] == "cog"
    # total is the full match count across all pages; data is just page 1
    # (default page_size=100) -- these legitimately differ once real
    # pagination exists (W24), unlike the pre-pagination response where
    # `data` always held everything.
    assert len(body["data"]) == min(body["total"], body["page_size"])
    assert body["data"], "expected at least one matching row"
    assert body["samples_were_capped"] is False, "a single real leaf id must never trigger the broad-category cap"
    assert body["leaf_count"] == 1

    for row in body["data"]:
        assert set(row.keys()) == EXPECTED_ROW_KEYS


def test_search_returns_correct_shape_for_kegg_and_enzyme(client):
    """Same shape check as test_search_returns_correct_shape, but for the
    two sources whose SQL storage keeps JGI's raw prefix (kegg_id="KO:...",
    ec_id="EC:...") while the route is called with the bare id -- the same
    format the frontend actually sends via annotation_catalog. This is the
    layer that would have caught both the kegg and enzyme prefix bugs:
    calling the route the way a real client does, not calling
    get_mappings_sql with an already-prefixed id."""
    for source, bare_id in [("kegg", "K02112"), ("enzyme", "7.1.2.2")]:
        resp = client.get(
            "/mappings/search",
            params={"annotation_id": bare_id, "source": source, "sample_count": 3},
        )
        assert resp.status_code == 200
        body = resp.json()

        assert body["annotation_id"] == bare_id
        assert body["source"] == source
        assert len(body["data"]) == min(body["total"], body["page_size"])
        assert body["data"], f"expected at least one matching row for source={source}, id={bare_id}"

        for row in body["data"]:
            assert set(row.keys()) == EXPECTED_ROW_KEYS


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


def test_sample_count_limits_to_earliest_samples(client):
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "COG0055", "source": "cog", "sample_count": 3},
    )
    body = resp.json()
    allowed = {'3300060410', '3300067202', '3300060358'}

    samples_in_response = {row["sample"] for row in body["data"]}
    assert samples_in_response <= allowed


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


def test_small_sample_count_is_meaningfully_faster_than_the_full_dataset(client):
    """Locks in the actual fix, not just a vague speed bound.

    get_mappings_sql used to have no way to filter by sample at the SQL
    level: it always fetched and GROUP_CONCAT-ed every matching row for the
    annotation across all 128 samples regardless of sample_count, and the
    route applied sample_count/allowed_samples afterward in Python,
    discarding almost everything it had just fetched. Root-caused via
    EXPLAIN QUERY PLAN (confirmed the query was already properly indexed --
    idx_gene_cog_cog_id etc. -- so the cost was purely "fetch everything,
    then throw most of it away", not a missing index) before fixing it by
    pushing an `AND mappings.sample IN (...)` filter into get_mappings_sql's
    subquery itself. Measured directly: COG0055 (29,663 raw matching gene
    rows total) went from ~830-860ms unfiltered to ~200ms filtered to 3
    samples. This test asserts that relationship holds -- sample_count=3
    must be meaningfully faster than sample_count=128 for the same
    annotation -- rather than just bounding either one in isolation."""
    import time

    t0 = time.perf_counter()
    small = client.get(
        "/mappings/search",
        params={"annotation_id": "COG0055", "source": "cog", "sample_count": 3},
    )
    small_elapsed = time.perf_counter() - t0
    assert small.status_code == 200

    t0 = time.perf_counter()
    full = client.get(
        "/mappings/search",
        params={"annotation_id": "COG0055", "source": "cog", "sample_count": 128},
    )
    full_elapsed = time.perf_counter() - t0
    assert full.status_code == 200

    assert small_elapsed < full_elapsed, (
        f"sample_count=3 ({small_elapsed:.2f}s) should be faster than "
        f"sample_count=128 ({full_elapsed:.2f}s) -- if not, the sample "
        f"filter in get_mappings_sql isn't actually narrowing the query"
    )
    # Generous regression guard, not a target -- current baseline is ~0.2s
    # for a small sample_count on this real, large (74M-row mappings /
    # 50M-row gene_cog) database.
    assert small_elapsed < 2.0, f"/mappings/search took {small_elapsed:.2f}s for sample_count=3"


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


# ═══════════════════════════════════════════════════════════════════════════
# W24 (docs/AUDIT-2026-09-22.md): non-leaf (pathway/class/category) ids
# now resolve to their member leaves' mappings at the route level, and a
# broad category clamps sample_count with a disclosed leaf_count/
# samples_were_capped rather than silently fetching millions of rows.
# ═══════════════════════════════════════════════════════════════════════════

def test_kegg_pathway_search_returns_real_rows_at_the_route_level(client):
    """00910 (Nitrogen metabolism) is a real KEGG pathway -- pre-fix, this
    exact route call always returned total=0 (kegg_id was built as
    "KO:00910", which mappings.kegg_id never contains)."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "00910", "source": "kegg", "sample_count": 1},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] > 0, "a real KEGG pathway id must return real mappings, not 0"
    assert body["leaf_count"] is not None and body["leaf_count"] > 1
    for row in body["data"]:
        assert row["kegg_id"].startswith("KO:K")


def test_broad_category_caps_sample_count_and_discloses_it(client):
    """H (Coenzyme transport and metabolism) resolves to well over
    _MANY_LEAVES_THRESHOLD (20) real COGs -- requesting all 128 samples
    must come back capped to _MAX_SAMPLES_FOR_MANY_LEAVES (5), with
    samples_were_capped=True so the frontend can disclose it (rather than
    the caller silently getting a partial answer with no indication)."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "H", "source": "cog", "sample_count": 128},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["samples_were_capped"] is True
    assert body["sample_count"] == 5
    assert body["leaf_count"] is not None and body["leaf_count"] > 20


def test_bypass_cap_honors_the_full_requested_sample_count(client):
    """bypass_cap=true is for an explicit, deliberate full export (e.g. CSV
    download) -- it must skip the broad-category clamp entirely, unlike
    the default interactive path. Uses a modest sample_count (10, not 128)
    so this test itself stays fast -- the mechanism being tested is "does
    the clamp get skipped", not "can it handle the full 128-sample case
    quickly", which is a separate, already-accepted cost of bypassing."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "H", "source": "cog", "sample_count": 10, "bypass_cap": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["samples_were_capped"] is False
    assert body["sample_count"] == 10
    assert body["leaf_count"] is not None and body["leaf_count"] > 20


def test_leaf_id_never_triggers_the_broad_category_cap(client):
    """A single real leaf COG id must always get its full requested
    sample_count -- the cap is specifically for non-leaf ids with many
    real member leaves, not for ordinary leaf searches."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "COG0055", "source": "cog", "sample_count": 128},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["samples_were_capped"] is False
    assert body["sample_count"] == 128
    assert body["leaf_count"] == 1
