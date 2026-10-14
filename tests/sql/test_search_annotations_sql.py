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
        # Post-E15 + CR3: cog DOES populate parent now, as the category's
        # own id/letter ("C"), not its display name -- reconfirmed live
        # before fixing this.
        "parent":        "C",
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


# W5: category/scaffold_count were entirely missing from get_search_annotations
# (annotation_catalog has no such columns -- they live per-sample on
# annotation_series), so the frontend's Annotation Lookup card silently
# rendered those fields blank on the SQL backend. Fixed with correlated
# subqueries against annotation_series.

def test_category_matches_the_known_cog_functional_category(conn):
    """COG0055's category is the expanded functional-category name for its
    single-letter parent "C" ("Energy production and conversion") --
    independently confirmed via a direct query against annotation_series
    during investigation, same value test_correct_values already pins
    `parent` to."""
    results = get_search_annotations(conn, sources=["cog"], q=None, annotation_id="COG0055", name_exact=None)
    assert results[0]["category"] == "Energy production and conversion"


def test_category_is_identical_for_every_row_of_the_same_annotation(conn):
    """category is a property of the annotation, not the sample -- there
    must be exactly one distinct category value across every
    annotation_series row for a given (source, annotation_id), so an
    arbitrary single-row pick (no aggregation) is exact, not approximate.
    Spot-checks a handful of real, distinct annotation_ids across sources."""
    for source, ann_id in [("cog", "COG0055"), ("kegg", "K00001"), ("enzyme", "1.1.1.1")]:
        rows = conn.execute(
            "SELECT DISTINCT category FROM annotation_series WHERE source = ? AND annotation_id = ?",
            (source, ann_id),
        ).fetchall()
        assert len(rows) == 1, f"{source}/{ann_id} has {len(rows)} distinct categories, expected exactly 1"


def test_scaffold_count_is_a_real_positive_int_not_none(conn):
    """scaffold_count must come back as a real number for a widely-present
    annotation -- not silently missing (the pre-fix bug) and not zero for
    an annotation known to be on many scaffolds."""
    results = get_search_annotations(conn, sources=["cog"], q=None, annotation_id="COG0055", name_exact=None)
    assert isinstance(results[0]["scaffold_count"], int)
    assert results[0]["scaffold_count"] > 0


def test_scaffold_count_matches_a_real_per_sample_value(conn):
    """The returned scaffold_count must be a genuine per-sample value for
    this annotation, not an aggregate or a made-up number -- confirm it
    matches at least one real row in annotation_series (the subquery is
    unordered, so which sample it lands on isn't pinned down, only that
    the value it returns is real)."""
    results = get_search_annotations(conn, sources=["cog"], q=None, annotation_id="COG0055", name_exact=None)
    real_counts = {
        row[0] for row in conn.execute(
            "SELECT scaffold_count FROM annotation_series WHERE source = 'cog' AND annotation_id = 'COG0055'"
        ).fetchall()
    }
    assert results[0]["scaffold_count"] in real_counts


def test_category_and_scaffold_count_present_across_all_four_sources(conn):
    """Not just a cog-specific fix -- kegg/enzyme/taxonomy all get both
    fields populated too."""
    for source, ann_id in [
        ("kegg", "K00001"), ("enzyme", "1.1.1.1"), ("taxonomy", "Bacteria"),
    ]:
        results = get_search_annotations(conn, sources=[source], q=None, annotation_id=ann_id, name_exact=None)
        assert results, f"no results for {source}/{ann_id}"
        assert results[0]["category"] is not None, f"{source}/{ann_id} has no category"
        assert results[0]["scaffold_count"] is not None, f"{source}/{ann_id} has no scaffold_count"


@pytest.mark.slow
def test_broad_taxonomy_search_completes_quickly(conn):
    """Regression guard for the slow ORDER BY variant considered and
    rejected during W5 (minutes for the full taxonomy catalog vs ~8s
    unordered) -- a realistic broad taxonomy search must stay fast.

    Marked slow: this is a wall-clock threshold assertion (5s), not a
    correctness check -- a loaded/throttled CI runner could legitimately
    exceed it without the underlying query plan having regressed. Note
    pytest.ini's `slow` marker is currently informational only (nothing
    in this repo's config passes `-m "not slow"` by default), so this
    mark doesn't yet skip the test automatically -- it's here so a
    future CI split can select on it, and so a human reading a failure
    here knows to suspect machine load before the query itself."""
    import time
    t0 = time.time()
    results = get_search_annotations(conn, sources=["taxonomy"], q="bacteria", annotation_id=None, name_exact=None)
    elapsed = time.time() - t0
    assert results
    assert elapsed < 5.0, f"broad taxonomy search took {elapsed:.2f}s, expected < 5s"


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


def test_empty_string_q_matches_everything_not_nothing(conn):
    """q="" is falsy in Python, so `if annotation_id: ... elif q: ... else:
    pass` falls all the way to the no-clause branch -- an empty string
    behaves exactly like q=None (matches every annotation for the given
    sources), NOT like "search for nothing". This is real, current
    behavior of get_search_annotations itself; the /search/annotations
    route separately rejects q shorter than 3 chars before ever reaching
    this function (see test_search_annotations_sql_route.py), so this
    matters only to callers of the data-layer function directly."""
    results_empty = get_search_annotations(conn, sources=["cog"], q="", annotation_id=None, name_exact=None)
    results_none = get_search_annotations(conn, sources=["cog"], q=None, annotation_id=None, name_exact=None)
    assert results_empty  # not []: an empty string must not match nothing
    assert {(r["source"], r["annotation_id"]) for r in results_empty} == \
           {(r["source"], r["annotation_id"]) for r in results_none}


def test_search_is_case_insensitive(conn):
    """SQLite's LIKE is case-insensitive for ASCII by default (verified
    directly against an in-memory table before writing this test) -- a
    mixed-case query must return the exact same rows as the lowercase
    form already proven to work in test_all_sources_search."""
    results_lower = get_search_annotations(
        conn, sources=["cog", "kegg", "enzyme", "taxonomy"], q="synthase", annotation_id=None, name_exact=None,
    )
    results_upper = get_search_annotations(
        conn, sources=["cog", "kegg", "enzyme", "taxonomy"], q="SYNTHASE", annotation_id=None, name_exact=None,
    )
    results_mixed = get_search_annotations(
        conn, sources=["cog", "kegg", "enzyme", "taxonomy"], q="SynThAse", annotation_id=None, name_exact=None,
    )
    assert results_lower
    key = lambda rows: {(r["source"], r["annotation_id"]) for r in rows}
    assert key(results_lower) == key(results_upper) == key(results_mixed)


def test_percent_and_underscore_in_query_act_as_sql_wildcards_not_literals(conn):
    """KNOWN BEHAVIOR, not asserted as desirable: q is interpolated into a
    LIKE pattern as f"%{q}%" with no escaping of LIKE's own metacharacters.
    A literal '%' in the query becomes part of the pattern (not a literal
    percent sign to search for), so q="%" produces the pattern "%%%",
    which matches every row with a non-null name/annotation_id -- same
    "matches everything" surprise as the empty-string case above, just
    reached through a different input. A literal '_' similarly matches
    any single character rather than a literal underscore (confirmed
    directly: pattern "%K_0001%" matches "K10001" too, not just a real
    "K_0001"). This test pins down the actual behavior so a future caller
    can't be surprised twice, without claiming it's the right behavior."""
    results_percent = get_search_annotations(conn, sources=["cog"], q="%", annotation_id=None, name_exact=None)
    results_q_none = get_search_annotations(conn, sources=["cog"], q=None, annotation_id=None, name_exact=None)
    assert results_percent
    key = lambda rows: {(r["source"], r["annotation_id"]) for r in rows}
    assert key(results_percent) == key(results_q_none)

    # "COG0055" contains no literal underscore, but "%COG0_55%" (one
    # wildcard character standing in for "0") still matches it.
    results_wildcard_underscore = get_search_annotations(
        conn, sources=["cog"], q="COG0_55", annotation_id=None, name_exact=None,
    )
    ann_ids = {r["annotation_id"] for r in results_wildcard_underscore}
    assert "COG0055" in ann_ids


def test_sql_metacharacters_in_query_are_safely_parameterized(conn):
    """q is always bound as a query parameter (params.append(...)), never
    string-concatenated into the SQL text -- a single quote, semicolon, or
    SQL-comment sequence in q must not raise sqlite3.OperationalError or
    otherwise break the query, and (since none of these appear in any
    real annotation_id/name) must simply return no matches."""
    for bad_q in ["O'Brien", "x'; DROP TABLE annotation_catalog; --", "a' OR '1'='1"]:
        results = get_search_annotations(
            conn, sources=["cog", "kegg", "enzyme", "taxonomy"], q=bad_q, annotation_id=None, name_exact=None,
        )
        assert results == []


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
