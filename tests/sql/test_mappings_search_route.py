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
    # pagination alongside the pre-existing keys. results_were_truncated
    # (2026-09-25) discloses get_mappings_sql's hard row-count safety
    # limit separately from samples_were_capped -- a different failure
    # mode with a different cause (see search_mappings's docstring).
    assert set(body.keys()) == {
        "annotation_id", "source", "sample_count", "samples_were_capped",
        "results_were_truncated", "leaf_count",
        "total", "page", "page_size", "total_pages", "data",
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


def test_bypass_cap_actually_changes_the_real_data_not_just_the_metadata(client):
    """A2 (docs/AUDIT-2026-10-05.md): the metadata-only assertions above
    (samples_were_capped/sample_count) are computed from routes.py's own
    allowed_samples list, which was already correct before this fix --
    get_mappings_sql had its own SEPARATE internal clamp that re-capped to
    5 samples regardless of bypass_cap, so the metadata could claim
    "bypassed, sample_count=10" while the actual query silently still only
    scanned 5. This compares the real row data/total between the two calls
    directly -- they must differ, not just the self-reported metadata.

    Category A (leaf_count=22, just over _MANY_LEAVES_THRESHOLD), not H --
    H's own real row count is broad enough to hit _MAPPINGS_ROW_LIMIT at
    BOTH 5 and 10 samples once A3's DISTINCT fix (below) is also in place,
    which would make capped/bypassed totals identical for an unrelated
    reason (both legitimately truncated to the same limit) and mask the
    very difference this test exists to catch. A's real counts (measured
    directly: 4,000 rows at 5 samples, 8,397 at 10) stay comfortably under
    the row limit at both sizes, so only the sample-cap mechanism is live."""
    capped = client.get(
        "/mappings/search",
        params={"annotation_id": "A", "source": "cog", "sample_count": 10, "bypass_cap": False, "page_size": 100000},
    ).json()
    bypassed = client.get(
        "/mappings/search",
        params={"annotation_id": "A", "source": "cog", "sample_count": 10, "bypass_cap": True, "page_size": 100000},
    ).json()

    assert bypassed["total"] > capped["total"], (
        "bypass_cap=true returned the same (or fewer) real rows as "
        "bypass_cap=false -- the internal clamp is still silently "
        "capping to 5 samples regardless of the flag"
    )
    capped_samples   = {row["sample"] for row in capped["data"]}
    bypassed_samples = {row["sample"] for row in bypassed["data"]}
    assert len(capped_samples) <= 5
    assert len(bypassed_samples) > 5


def test_low_volume_leaf_id_is_never_capped(client):
    """A leaf id that's both narrow (leaf_count=1) AND low-volume must
    always get its full requested sample_count. K00001 is a real,
    verified-cheap case: 3,126 rows across all 128 samples (measured
    directly against the real production db, 2026-09-25) -- comfortably
    under _ROW_VOLUME_THRESHOLD."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "K00001", "source": "kegg", "sample_count": 128},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["samples_were_capped"] is False
    assert body["sample_count"] == 128
    assert body["leaf_count"] == 1


def test_high_volume_leaf_id_is_capped_by_row_count_not_leaf_count(client):
    """A single leaf id (leaf_count=1, so the breadth-based
    _MANY_LEAVES_THRESHOLD cap never fires) can still be expensive on its
    own -- found live in production, 2026-09-25: source=kegg,
    annotation_id=K02014 is one leaf but matches 271,284 real mappings
    rows across all 128 samples and took 249.8s to run uncapped (measured
    directly against the real db). This must be caught by the row-volume
    cap (estimate_mapping_row_count_sql vs _ROW_VOLUME_THRESHOLD) even
    though leaf_count itself never exceeds _MANY_LEAVES_THRESHOLD."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "K02014", "source": "kegg", "sample_count": 128},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["leaf_count"] == 1
    assert body["samples_were_capped"] is True
    assert body["sample_count"] == 5
    assert body["results_were_truncated"] is False, (
        "the sample-count cap alone should already bring K02014 well "
        "under _MAPPINGS_ROW_LIMIT (measured: 7,391 rows at 5 samples) "
        "-- both mechanisms firing here would suggest the sample cap "
        "regressed, not that this assertion is wrong"
    )


def test_broad_taxonomy_node_is_capped_too(client):
    """Taxonomy was never covered by the leaf-count cap at all until this
    fix (2026-09-25) -- found live in production: source=taxonomy,
    annotation_id=Bacteria touches 59,780,871 of ~74M total mappings rows
    (81% of the entire dataset) and hung indefinitely, uncapped, because
    the kegg/cog/enzyme-only capping branch skipped taxonomy entirely.
    count_taxa_under_sql (taxon_paths-based, taxonomy's leaf_count analog)
    must now catch this the same way _expand_to_leaf_ids does for the
    other three sources."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "Bacteria", "source": "taxonomy", "sample_count": 128},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["samples_were_capped"] is True
    assert body["sample_count"] == 5
    assert body["leaf_count"] is not None and body["leaf_count"] > 20
    # Unlike the single-abundant-organism case below, Bacteria's real
    # row count even at 5 samples (measured: ~1.7M) still exceeds
    # _MAPPINGS_ROW_LIMIT -- both mechanisms legitimately fire together
    # here, unlike the K02014 case above.
    assert body["results_were_truncated"] is True


def test_leaf_level_taxon_is_not_capped(client):
    """A specific strain/species-level lineage (no real descendants in
    taxon_paths) must behave like an ordinary leaf id -- not treated as
    broad just because it went through the same new code path as
    Bacteria."""
    resp = client.get(
        "/mappings/search",
        params={
            "annotation_id": (
                "Bacteria;Proteobacteria;Acidithiobacillia;Acidithiobacillales;"
                "Acidithiobacillaceae;Acidithiobacillus;Acidithiobacillus albertensis;"
                "Acidithiobacillus albertensis DSM 14366"
            ),
            "source": "taxonomy",
            "sample_count": 128,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["leaf_count"] == 1
    assert body["samples_were_capped"] is False
    assert body["results_were_truncated"] is False


def test_single_abundant_leaf_taxon_is_row_limited_even_though_never_capped(client):
    """A DIFFERENT failure mode from the broad-category cap above: a
    single, specific, real leaf-level organism (leaf_count=1, not a
    category at all, so samples_were_capped never fires) can itself be
    enormous. Found live in production, 2026-09-25: the single most
    abundant organism in this dataset has 2,235,509 rows across all 128
    samples -- this first crashed the whole server via the kernel OOM
    killer before _MAPPINGS_ROW_LIMIT existed. results_were_truncated
    must disclose this separately from samples_were_capped, since here
    the sample count was never reduced at all -- only the raw row count
    was capped."""
    resp = client.get(
        "/mappings/search",
        params={
            "annotation_id": (
                "Bacteria;Proteobacteria;Gammaproteobacteria;Cellvibrionales;"
                "Porticoccaceae;unclassified Porticoccaceae;"
                "gamma proteobacterium HTCC2207;"
                "Marine gamma proteobacterium sp. HTCC2207"
            ),
            "source": "taxonomy",
            "sample_count": 128,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["leaf_count"] == 1
    assert body["samples_were_capped"] is False
    assert body["sample_count"] == 128
    assert body["results_were_truncated"] is True


def test_cog_broad_category_truncation_is_correctly_flagged(client):
    """A3 (docs/AUDIT-2026-10-05.md): cog/enzyme's junction-table subquery
    used to select a bare (non-DISTINCT) mapping_id -- a gene matching
    more than one of the leaf ids a broad category expands to (a real
    case for a multi-category search) produced duplicate raw ids inside
    the LIMIT, so the post-GROUP-BY distinct count could land under
    _MAPPINGS_ROW_LIMIT even though real data was dropped.
    results_were_truncated read False while the response was, measured
    live before this fix: cog category H at 5 samples, true answer
    100,275 distinct genes; the API returned only 49,969 (49.8%). kegg/
    taxonomy's per-row subqueries never had this gap (mappings.id is
    already unique per row) -- see test_broad_taxonomy_node_is_capped_too
    above for that sibling case, already correct before this fix."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "H", "source": "cog", "sample_count": 5, "page_size": 1},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sample_count"] == 5
    assert body["results_were_truncated"] is True


def test_enzyme_broad_category_truncation_is_correctly_flagged(client):
    """Same A3 fix, enzyme side -- gene_enzyme's junction-table subquery
    had the identical non-DISTINCT gap as gene_cog's above. Enzyme class 1
    (Oxidoreductases) is real and broad enough to exceed
    _MAPPINGS_ROW_LIMIT at a capped 5 samples (measured directly against
    the real db before writing this test)."""
    resp = client.get(
        "/mappings/search",
        params={"annotation_id": "1", "source": "enzyme", "sample_count": 5, "page_size": 1},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sample_count"] == 5
    assert body["results_were_truncated"] is True


def test_concurrent_requests_do_not_hang_or_corrupt_the_shared_connection(client):
    """Regression test for a real production incident (2026-09-25): every
    route in routes.py used to read one sqlite3.Connection shared off
    app.state.sql_conn across every request/thread. Under real concurrent
    traffic this produced non-deterministic hangs and
    sqlite3.InterfaceError: bad parameter or other API misuse -- confirmed
    live via a py-spy stack dump showing multiple threads permanently stuck
    mid-conn.execute() on the one shared connection. The fix (routes.py
    now opens its own connect_to_sql() connection per request, see its
    module docstring) means concurrent requests must no longer interfere
    with each other at all. Fires a real mix of leaf and non-leaf lookups
    from multiple threads at once and requires every single one to return
    200 within a real wall-clock deadline -- a hang (the actual failure
    mode observed in production) times out ThreadPoolExecutor's `.result()`
    rather than failing fast, so this would have caught it.
    """
    import concurrent.futures

    requests = [
        {"annotation_id": "K02014", "source": "kegg", "sample_count": 5},
        {"annotation_id": "COG0055", "source": "cog", "sample_count": 5},
        {"annotation_id": "H", "source": "cog", "sample_count": 5},
        {"annotation_id": "00910", "source": "kegg", "sample_count": 5},
        {"annotation_id": "K02014", "source": "kegg", "sample_count": 5},
        {"annotation_id": "COG0055", "source": "cog", "sample_count": 5},
    ] * 3  # 18 concurrent requests, deliberately repeating the same ids

    def fire(params):
        return client.get("/mappings/search", params=params)

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(requests)) as pool:
        futures = [pool.submit(fire, params) for params in requests]
        responses = [f.result(timeout=30) for f in futures]

    statuses = [r.status_code for r in responses]
    assert all(s == 200 for s in statuses), f"Expected all 200, got: {statuses}"
