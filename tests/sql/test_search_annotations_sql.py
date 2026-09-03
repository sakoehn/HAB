"""
test_search_annotations_sql.py
================================
Data-layer tests for cache_sql.get_search_annotations() -- same spirit as
tests/sql/test_mappings_sql.py: calls the function directly against the
real populated database via a raw sqlite3.Connection, not over HTTP (that's
tests/sql/test_search_annotations_sql_route.py's job).

Skips automatically if the database doesn't exist yet.

Run:
    pytest tests/sql/test_search_annotations_sql.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH
from api.cache_sql import get_search_annotations, get_top_annotations_sql, get_all_sample_names_sql

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)


# Every test below takes a `conn` parameter to receive this fixture's
# value -- pylint sees that as shadowing the module-level `conn` name,
# but it's the standard pytest fixture-injection pattern, not a real bug.
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


#======================================================================
# Tests
#======================================================================

def test_exact_match_search(conn):
    """annotation_id="COG0055" (exact) should find only that annotation,
    on the cog source -- every returned row's annotation_id/source must
    match exactly, no near-misses."""
    results = get_search_annotations(conn, sources=["cog"], q=None, annotation_id="COG0055", name_exact=None)
    assert results
    for row in results:
        assert row["annotation_id"] == "COG0055"
        assert row["source"] == "cog"


def test_substring_match_search(conn):
    """q="COG005" (a real substring of COG0055) should find COG0055 among
    its results -- proves substring matching actually works, not just
    exact matching under a different param name."""
    results = get_search_annotations(conn, sources=["cog"], q="COG005", annotation_id=None, name_exact=None)
    assert results
    ann_ids = {row["annotation_id"] for row in results}
    assert "COG0055" in ann_ids


def test_all_sources_search(conn):
    """q="synthase" is a real cross-source term (confirmed during the
    Phase 1 Mongo search spike to hit kegg/enzyme/taxonomy name fields,
    not just one source) -- searching across all 4 sources at once should
    return results from more than one distinct source, not silently
    collapse to whichever source happens to sort first."""
    results = get_search_annotations(
        conn, sources=["cog", "kegg", "enzyme", "taxonomy"], q="synthase", annotation_id=None, name_exact=None,
    )
    assert results
    sources_seen = {row["source"] for row in results}
    assert len(sources_seen) > 1


def test_two_sources_only_search(conn):
    """Passing sources=["cog", "kegg"] never returns a row with
    source="enzyme" or source="taxonomy". "synthase" has real matches in
    enzyme too (confirmed against live data), so enzyme's absence proves
    the filter works rather than being a coincidence of the query term --
    taxonomy has zero real "synthase" matches regardless of filtering, so
    this doesn't prove taxonomy exclusion the same way."""
    results = get_search_annotations(
        conn, sources=["cog", "kegg"], q="synthase", annotation_id=None, name_exact=None,
    )
    assert results
    sources_seen = {row["source"] for row in results}
    assert sources_seen == {"cog", "kegg"}


def test_correct_values(conn):
    """COG0055's aggregated mean_egc/max_egc/mean_norm_egc/max_norm_egc/
    sample_count match real, independently-verified values -- same
    ground-truth philosophy as test_mappings_sql.py's known-gene tests --
    and separately cross-check against get_top_annotations_sql's
    independent aggregation of the same data."""
    results = get_search_annotations(
        conn, sources=["cog"], q=None, annotation_id="COG0055", name_exact=None,
    )
    assert results
    expected_a = {
        "name":          "FoF1-type ATP synthase, beta subunit",
        "parent":        None,
        "mean_egc":      8759.3203125,
        "max_egc":       25563.0,
        "mean_norm_egc": 0.00047519008991907946,
        "max_norm_egc":  0.0006207960634297522,
        "sample_count":  128
    }
    expected_b = get_top_annotations_sql(conn, "cog", get_all_sample_names_sql(conn))
    cog0055 = next((item for item in expected_b if item['annotation_id'] == "COG0055"), None)
    actual = next((item for item in results if item['annotation_id'] == "COG0055"), None)
    assert actual is not None
    assert cog0055 is not None

    # Option B: hardcoded, independently-verified ground truth
    assert actual['name'] == expected_a['name']
    assert actual['parent'] == expected_a['parent']
    assert actual['mean_egc'] == expected_a['mean_egc']
    assert actual['max_egc'] == expected_a['max_egc']
    assert actual['mean_norm_egc'] == expected_a['mean_norm_egc']
    assert actual['max_norm_egc'] == expected_a['max_norm_egc']
    assert actual['sample_count'] == expected_a['sample_count']

    # Option A: cross-check against get_top_annotations_sql's independent aggregation
    assert actual['name'] == cog0055['name']
    assert actual['parent'] == cog0055['parent']
    assert actual['mean_egc'] == cog0055['mean_egc']
    assert actual['max_egc'] == cog0055['max_egc']
    assert actual['mean_norm_egc'] == cog0055['mean_norm_egc']
    assert actual['max_norm_egc'] == cog0055['max_norm_egc']
    assert actual['sample_count'] == cog0055['sample_count']


def test_results_deduplicated_across_samples(conn):
    """annotation_series has ~6M rows, one per (source, sample,
    annotation_id) -- a search hit that exists in many samples collapses
    to ONE row per unique (source, annotation_id) via GROUP BY, not one
    row per sample. No duplicate (source, annotation_id) pairs for a
    query known to match a widely-shared annotation."""
    results = get_search_annotations(
        conn, sources=["cog", "kegg", "enzyme", "taxonomy"], q="synthase", annotation_id=None, name_exact=None,
    )
    seen = set()
    has_duplicates = False
    for row in results:
        check = (row['source'], row['annotation_id'])
        if check in seen:
            has_duplicates = True
        else:
            seen.add(check)
    assert not has_duplicates


def test_taxonomy_homonym_search_returns_both_distinct_lineages(conn):
    """Real, confirmed case matching the taxonomy_egc_homonym_bug fix this
    search sits on top of: searching taxonomy for the genus name "Bosea"
    must surface it as TWO separate annotations -- same name, but
    different rank/lineage (parent). A pre-fix, bare-name-keyed search
    would have shown only one, silently hiding the second lineage."""
    results = get_search_annotations(
        conn, sources=["taxonomy"], q=None, annotation_id=None, name_exact="Bosea",
    )
    assert len(results) == 2, f"expected exactly 2 'Bosea' results, found {len(results)}"

    old_lineage = "Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Bradyrhizobiaceae;Bosea"
    new_lineage = "Bacteria;Proteobacteria;Alphaproteobacteria;Hyphomicrobiales;Boseaceae;Bosea"
    by_id = {row["annotation_id"]: row for row in results}
    assert set(by_id) == {old_lineage, new_lineage}
    assert by_id[old_lineage]["name"] == by_id[new_lineage]["name"] == "Bosea"
    assert by_id[old_lineage]["parent"] != by_id[new_lineage]["parent"]
    assert by_id[old_lineage]["depth"] == by_id[new_lineage]["depth"] == 6


def test_no_match_returns_empty(conn):
    """A query that matches nothing (bogus annotation_id, nonsense
    substring, or nonexistent exact name) returns an empty list, not None
    and not an error -- same pattern as test_mappings_sql.py's INVALID ID
    case and test_cache_sql.py's test_no_match_returns_empty_list."""
    result1 = get_search_annotations(
        conn, sources=["cog", "kegg", "enzyme", "taxonomy"], q="INVALID", annotation_id=None, name_exact=None
    )
    assert result1 == []

    result2 = get_search_annotations(
            conn, sources=["cog", "kegg", "enzyme", "taxonomy"], q=None, annotation_id="INVALID", name_exact=None
    )
    assert result2 == []

    result3 = get_search_annotations(
            conn, sources=["cog", "kegg", "enzyme", "taxonomy"], q=None, annotation_id=None, name_exact="INVALID"
    )
    assert result3 == []
