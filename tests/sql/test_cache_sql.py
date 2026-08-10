"""
test_cache_sql.py
====================
Tests for FastAPI/api/cache_sql.py -- the DATA_BACKEND=sql query layer.

  taxon_paths_under()       -- depth-picks-the-column join between a
                               taxonomy annotation_series node and the
                               taxon_paths rows it covers.
  get_annotation_series_sql() -- SQL equivalent of cache_mongo's
                               get_annotation_series_split(), for the
                               /series/annotations route.

Runs against the REAL hab_mappings.db, read-only -- taxon_paths and
annotation_series/cog/kegg are Phase 1/2 data already fully built (only
enzyme/taxonomy sources of the Phase 2 migration may still be in
progress), so this is safe to run even while that migration continues.
Same real-data-not-synthetic-fixture spirit as tests/sql/test_mappings_sql.py.
Skips automatically if the database doesn't exist yet.

Import target doesn't exist yet. Write taxon_paths_under() and
get_annotation_series_sql() in FastAPI/api/cache_sql.py to make this pass.

Run:
    pytest tests/sql/test_cache_sql.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.cache_sql import (
    get_all_sample_names_sql,
    get_annotation_scaffolds_sql,
    get_annotation_series_sql,
    get_taxonomy_children_sql,
    get_top_annotations_sql,
    taxon_exists_sql,
    taxon_paths_under,
)
from api.config import SQLITE_DB_PATH

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


# Real counts, independently confirmed against the live database right
# before this file was written.
EXPECTED_BACTEROIDETES_PHYLUM_COUNT = 2561
EXPECTED_BACTERIA_DOMAIN_COUNT = 39237
EXPECTED_AQUIFICAE_PHYLUM_COUNT = 30
EXPECTED_AQUIFICAE_CLASS_COUNT = 30


def test_phylum_level_node_returns_every_lineage_under_it(conn):
    """A phylum node covers MANY taxon_paths rows, not one -- proves this
    isn't accidentally behaving like a single-row lookup."""
    rows = taxon_paths_under(conn, "Bacteroidetes", depth=2)
    assert len(rows) == EXPECTED_BACTEROIDETES_PHYLUM_COUNT


def test_domain_level_node_returns_a_much_larger_set(conn):
    rows = taxon_paths_under(conn, "Bacteria", depth=1)
    assert len(rows) == EXPECTED_BACTERIA_DOMAIN_COUNT


def test_known_full_path_is_present_in_the_result(conn):
    """Spot-checks one specific real lineage (the same gene/lineage used
    throughout Phase 1's tests) actually comes back, not just a count."""
    rows = taxon_paths_under(conn, "Bacteroidetes", depth=2)
    # SELECT * column order: id, domain, phylum, class_, order, family,
    # genus, species, strain, full_path -- full_path is index 9, not 1.
    full_paths = [row[9] for row in rows]
    assert any(fp.startswith("Bacteria;Bacteroidetes;Flavobacteriia") for fp in full_paths)


def test_no_match_returns_empty_list_not_none_or_error(conn):
    rows = taxon_paths_under(conn, "totally_bogus_xyz", depth=2)
    assert rows == []


def test_depth_disambiguates_a_real_cross_rank_homonym(conn):
    """"Aquificae" is a REAL confirmed case of the same bare name existing
    at two different ranks (phylum in some lineages, class in others,
    30 taxon_paths rows each) -- this is exactly why depth, not just
    annotation_id, must pick the column. Querying depth=2 must return only
    the phylum-Aquificae rows, not accidentally include the class ones."""
    phylum_rows = taxon_paths_under(conn, "Aquificae", depth=2)
    class_rows = taxon_paths_under(conn, "Aquificae", depth=3)
    assert len(phylum_rows) == EXPECTED_AQUIFICAE_PHYLUM_COUNT
    assert len(class_rows) == EXPECTED_AQUIFICAE_CLASS_COUNT


@pytest.mark.parametrize("bad_depth", [0, 9, -1, 100])
def test_depth_outside_valid_range_raises(conn, bad_depth):
    """depth=9 is a real observed case (a Drosophila strain name with an
    extra semicolon token, see Phase 1) -- there's no 9th taxon_paths
    column to map it to, so this must fail loudly, not silently return []
    and look identical to a real "found nothing" result."""
    with pytest.raises(ValueError):
        taxon_paths_under(conn, "whatever", depth=bad_depth)


# ═══════════════════════════════════════════════════════════════════════════
# get_annotation_series_sql -- real counts confirmed against the live
# database right before this file was written.
# ═══════════════════════════════════════════════════════════════════════════

EXPECTED_COG0055_SAMPLE_COUNT = 128


def test_returns_one_row_per_sample_that_has_this_annotation(conn):
    """COG0055 is common enough to appear in all 128 real samples."""
    rows = get_annotation_series_sql(conn, "cog", "COG0055")
    assert len(rows) == EXPECTED_COG0055_SAMPLE_COUNT


def test_row_shape_matches_the_mongo_equivalent(conn):
    """Same keys get_annotation_series_split() returns (sample_name, name,
    category, egc, norm_egc, scaffold_count, gene_count) -- even though
    the underlying column is `sample`, not `sample_name` -- so routes.py's
    future sql branches (both /series/annotations AND
    /annotations/scaffolds/summary, which this same function backs) can
    mirror their mongo branches almost line for line."""
    rows = get_annotation_series_sql(conn, "cog", "COG0055")
    row = next(r for r in rows if r["sample_name"] == "3300060358")
    assert row == {
        "sample_name":    "3300060358",
        "name":           "FoF1-type ATP synthase, beta subunit",
        "category":       "C",
        "egc":            7092.0,
        "norm_egc":       0.0005778704463674381,
        "scaffold_count": 169,
        "gene_count":     170,
    }


def test_no_match_returns_empty_list(conn):
    rows = get_annotation_series_sql(conn, "cog", "COG_TOTALLY_BOGUS")
    assert rows == []


def test_does_not_cross_source_with_a_shared_annotation_id_string(conn):
    """Same real cross-source-collision protection the schema's UNIQUE
    constraint was built for -- a bogus id under 'kegg' must not
    accidentally return cog's real rows for the same string."""
    rows = get_annotation_series_sql(conn, "kegg", "COG0055")
    assert rows == []


# ═══════════════════════════════════════════════════════════════════════════
# get_all_sample_names_sql -- real counts confirmed against the live
# mappings table (Phase 1, always fully populated) right before this file
# was written.
# ═══════════════════════════════════════════════════════════════════════════

EXPECTED_TOTAL_SAMPLE_COUNT = 128
EXPECTED_FIRST_SAMPLE = "3300060358"
EXPECTED_LAST_SAMPLE = "3300068252"


def test_returns_all_128_real_samples(conn):
    names = get_all_sample_names_sql(conn)
    assert len(names) == EXPECTED_TOTAL_SAMPLE_COUNT


def test_returns_no_duplicates(conn):
    """Derived from `mappings`, which has ~74M rows (many per sample) --
    must come back as one entry per sample, not one per row."""
    names = get_all_sample_names_sql(conn)
    assert len(names) == len(set(names))


def test_sorted_lexicographically(conn):
    """Matches cache.get_all_sample_names()'s sorted() behavior -- callers
    on either backend should see the same order."""
    names = get_all_sample_names_sql(conn)
    assert names == sorted(names)
    assert names[0] == EXPECTED_FIRST_SAMPLE
    assert names[-1] == EXPECTED_LAST_SAMPLE


class _ExplodingConnection(sqlite3.Connection):
    """A real sqlite3.Connection subclass whose .execute() always raises --
    used to prove a cached call never reaches the database. Can't do this
    via monkeypatch: sqlite3.Connection is an immutable C type, so neither
    instance attribute assignment (AttributeError: read-only) nor
    class-level monkeypatching (TypeError: immutable type) work, confirmed
    directly -- a real subclass passed as sqlite3.connect(factory=...) is
    the only way to intercept .execute()."""

    def execute(self, *args, **kwargs):
        raise AssertionError("get_all_sample_names_sql hit the database on a cached call")


def test_second_call_does_not_hit_the_database(conn, monkeypatch):
    """This is the actual /annotations/top bug: get_all_sample_names_sql()
    runs `SELECT DISTINCT sample FROM mappings` -- a scan over ~74M rows --
    on every call, uncached, measured at 4.6s+ per call. It must be cached
    after the first call.

    Proven here, not assumed: reset the module-level cache to force a real
    first call, then pass a connection whose .execute() always raises for
    the second call. If the second call still returns the right data
    without raising, it must have come from the cache, not a second query.
    """
    import api.cache_sql as cache_sql_module

    monkeypatch.setattr(cache_sql_module, "_ALL_SAMPLES_SQL_CACHE", None, raising=False)

    first = get_all_sample_names_sql(conn)
    assert len(first) == EXPECTED_TOTAL_SAMPLE_COUNT

    exploding_conn = sqlite3.connect(
        f"file:{SQLITE_DB_PATH}?mode=ro", uri=True, factory=_ExplodingConnection
    )
    try:
        second = get_all_sample_names_sql(exploding_conn)
    finally:
        sqlite3.Connection.close(exploding_conn)

    assert second == first


# ═══════════════════════════════════════════════════════════════════════════
# get_taxonomy_children_sql -- real counts confirmed against the live
# taxon_paths table (Phase 1, unaffected by the still-in-progress Phase 2
# annotation migration) right before this file was written.
# ═══════════════════════════════════════════════════════════════════════════

EXPECTED_ROOT_DOMAINS = ["Archaea", "Bacteria", "Eukaryota", "Viruses"]
EXPECTED_BACTEROIDETES_CHILDREN = [
    "Bacteroidia", "Chitinophagia", "Cytophagia", "Flavobacteriia",
    "Saprospiria", "Sphingobacteriia", "unclassified Bacteroidetes",
]


def test_root_case_returns_the_four_domains(conn):
    """parent=None -> domain roots, no depth needed."""
    children = get_taxonomy_children_sql(conn, None)
    assert sorted(c["annotation_id"] for c in children) == EXPECTED_ROOT_DOMAINS
    assert all(c["depth"] == 1 for c in children)
    # a domain is its own category -- e.g. "Bacteria"'s category is "Bacteria"
    assert all(c["annotation_id"] == c["category"] for c in children)


def test_phylum_level_parent_returns_its_real_classes(conn):
    """Bacteroidetes (depth=2) -- real 7 classes underneath it in
    taxon_paths, independently recomputed above, not assumed."""
    children = get_taxonomy_children_sql(conn, "Bacteroidetes", depth=2)
    assert sorted(c["annotation_id"] for c in children) == EXPECTED_BACTEROIDETES_CHILDREN
    assert all(c["depth"] == 3 for c in children)
    assert all(c["category"] == "Bacteria" for c in children)


def test_strain_level_parent_has_no_children(conn):
    """depth=8 (strain) is a real leaf rank -- must return [], not raise
    (unlike taxon_paths_under()'s out-of-range depths, which DO raise --
    depth=8 here is perfectly valid, it just has nothing beneath it)."""
    children = get_taxonomy_children_sql(conn, "Flagellimonas pacifica DSM 25885", depth=8)
    assert children == []


def test_parent_given_without_depth_auto_resolves(conn):
    """no depth is pasted in. must find and determine the correct depth and than 
        get the children. 
    """
    children_no_depth = get_taxonomy_children_sql(conn, "Bacteroidetes")
    children_depth = get_taxonomy_children_sql(conn, "Bacteroidetes", depth=2)
    assert children_no_depth == children_depth


def test_no_real_children_returns_empty_list_not_none(conn):
    children = get_taxonomy_children_sql(conn, "totally_bogus_taxon_xyz", depth=2)
    assert children == []


# ═══════════════════════════════════════════════════════════════════════════
# get_annotation_scaffolds_sql -- real counts confirmed against the live
# database right before this file was written. 29,307 cross-checks
# against a figure already independently confirmed in an earlier session
# (COG0055's real total scaffold count across all samples).
# ═══════════════════════════════════════════════════════════════════════════

EXPECTED_COG0055_TOTAL_SCAFFOLD_ROWS = 29307
EXPECTED_COG0055_SAMPLE_3300060358_SCAFFOLD_ROWS = 169


def test_returns_all_scaffold_rows_across_every_sample_when_unscoped(conn):
    rows = get_annotation_scaffolds_sql(conn, "cog", "COG0055")
    assert len(rows) == EXPECTED_COG0055_TOTAL_SCAFFOLD_ROWS


def test_sample_param_restricts_to_just_that_sample(conn):
    rows = get_annotation_scaffolds_sql(conn, "cog", "COG0055", sample="3300060358")
    assert len(rows) == EXPECTED_COG0055_SAMPLE_3300060358_SCAFFOLD_ROWS
    assert all(r["sample_name"] == "3300060358" for r in rows)


def test_row_shape_and_a_known_real_value(conn):
    rows = get_annotation_scaffolds_sql(conn, "cog", "COG0055", sample="3300060358")
    row = next(r for r in rows if r["scaffold_id"] == "Ga0590986_0000001")
    assert row == {"sample_name": "3300060358", "scaffold_id": "Ga0590986_0000001", "gene_count": 1}


def test_scaffolds_no_match_returns_empty_list(conn):
    rows = get_annotation_scaffolds_sql(conn, "cog", "COG_TOTALLY_BOGUS")
    assert rows == []


def test_sample_scoping_excludes_other_samples_real_rows(conn):
    """A scaffold_id that's real for a DIFFERENT sample must not leak into
    a query scoped to this one -- proves the join is actually filtering by
    sample, not just by (source, annotation_id)."""
    rows = get_annotation_scaffolds_sql(conn, "cog", "COG0055", sample="3300060359")
    assert all(r["sample_name"] == "3300060359" for r in rows)
    assert not any(r["scaffold_id"] == "Ga0590986_0000001" for r in rows)


# ═══════════════════════════════════════════════════════════════════════════
# taxon_exists_sql -- real names at different real ranks (phylum/domain/
# strain), confirming existence doesn't care which column matched.
# ═══════════════════════════════════════════════════════════════════════════

def test_true_for_a_real_phylum_level_name(conn):
    assert taxon_exists_sql(conn, "Bacteroidetes") is True


def test_true_for_a_real_domain_root(conn):
    assert taxon_exists_sql(conn, "Bacteria") is True


def test_true_for_a_real_strain_level_leaf(conn):
    """Confirms the check doesn't stop early or only look at high-rank
    columns -- strain is the LAST column checked in RANK_COLUMNS order."""
    assert taxon_exists_sql(conn, "Flagellimonas pacifica DSM 25885") is True


def test_false_for_a_name_that_appears_nowhere(conn):
    assert taxon_exists_sql(conn, "totally_bogus_taxon_xyz") is False


# ═══════════════════════════════════════════════════════════════════════════
# get_top_annotations_sql -- real stats independently recomputed in Python
# from the raw annotation_series rows for these 2 samples, right before
# this file was written -- not assumed.
# ═══════════════════════════════════════════════════════════════════════════

TWO_SAMPLES = ["3300060358", "3300060359"]
EXPECTED_DISTINCT_COG_ANNOTATION_COUNT = 4594


def test_returns_one_row_per_distinct_annotation_id(conn):
    results = get_top_annotations_sql(conn, "cog", TWO_SAMPLES)
    assert len(results) == EXPECTED_DISTINCT_COG_ANNOTATION_COUNT


def test_sorted_by_mean_egc_descending(conn):
    results = get_top_annotations_sql(conn, "cog", TWO_SAMPLES)
    mean_egcs = [r["mean_egc"] for r in results]
    assert mean_egcs == sorted(mean_egcs, reverse=True)


def test_top_result_matches_independently_recomputed_stats(conn):
    """COG1028, present in both samples -- mean/max independently computed
    in plain Python from the raw rows, not assumed."""
    results = get_top_annotations_sql(conn, "cog", TWO_SAMPLES)
    top = results[0]
    assert top["annotation_id"] == "COG1028"
    assert top["name"] == "NAD(P)-dependent dehydrogenase, short-chain alcohol dehydrogenase family"
    assert top["parent"] is None  # cog never populates parent
    assert top["mean_egc"] == 70109.5
    assert top["max_egc"] == 83265.0
    assert top["mean_norm_egc"] == 0.006534575058285045
    assert top["max_norm_egc"] == 0.0067845999318647396
    assert top["sample_count"] == 2


def test_sample_count_reflects_how_many_of_the_given_samples_actually_have_it(conn):
    """COG3477 is only real in one of these two samples -- sample_count
    must be 1, not 2 (must not silently assume every requested sample
    contributed a row)."""
    results = get_top_annotations_sql(conn, "cog", TWO_SAMPLES)
    row = next(r for r in results if r["annotation_id"] == "COG3477")
    assert row["sample_count"] == 1
    assert row["mean_egc"] == row["max_egc"] == 360.0


def test_parent_comes_from_parent_name_for_kegg_no_resolve_parent_needed(conn):
    """K09014, real kegg example -- parent already resolved to parent_name
    at migration time (no category/parent_id fallback logic needed here,
    unlike the Mongo version's _resolve_parent())."""
    results = get_top_annotations_sql(conn, "kegg", TWO_SAMPLES)
    row = next(r for r in results if r["annotation_id"] == "K09014")
    assert row["parent"] == "General function prediction only"
    assert row["mean_egc"] == 3721.0
    assert row["max_egc"] == 4067.0
    assert row["sample_count"] == 2


def test_only_counts_the_requested_samples_not_every_sample(conn):
    """A third, unrequested sample's data must not leak in -- proves the
    WHERE sample IN (...) filter is real, not accidentally unscoped."""
    results_two = get_top_annotations_sql(conn, "cog", TWO_SAMPLES)
    results_one = get_top_annotations_sql(conn, "cog", ["3300060358"])
    top_two = next(r for r in results_two if r["annotation_id"] == "COG1028")
    top_one = next(r for r in results_one if r["annotation_id"] == "COG1028")
    assert top_two["sample_count"] == 2
    assert top_one["sample_count"] == 1
    assert top_two["mean_egc"] != top_one["mean_egc"]
