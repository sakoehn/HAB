"""
test_series_export_sql.py
=========================
Tests for the two cache_sql.py functions behind the bulk time-series
download (Explore > Bulk download):

  get_taxa_under_at_rank_sql()  -- every taxon at one rank under a parent
                                   lineage (e.g. every family under
                                   Gammaproteobacteria), from annotation_catalog.
  iter_taxa_series_sql()        -- the per-sample egc/norm_egc rows for a
                                   list of taxa, from annotation_series.

Runs against the REAL hab_mappings.db, read-only. Expected counts are
recomputed independently in each test with a plain substr() scan rather
than hardcoded, so they track the data if it is rebuilt.

Run:
    pytest tests/sql/test_series_export_sql.py -v
"""

import os
import sqlite3
import sys
from collections import defaultdict

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.cache_sql import get_taxa_under_at_rank_sql, iter_taxa_series_sql
from api.config import SQLITE_DB_PATH
from test_cache_sql import BOSEA_NEW_LINEAGE, BOSEA_OLD_LINEAGE

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

GAMMA = "Bacteria;Proteobacteria;Gammaproteobacteria"
PSEUDOMONADACEAE = "Bacteria;Proteobacteria;Gammaproteobacteria;Pseudomonadales;Pseudomonadaceae"
ALPHA = "Bacteria;Proteobacteria;Alphaproteobacteria"
# Two real sibling genera where one lineage is a plain-text prefix of the
# other -- "under Mycolicibacter" must not pick up Mycolicibacterium.
MYCOLICIBACTER = "Bacteria;Actinobacteria;Actinomycetia;Corynebacteriales;Mycobacteriaceae;Mycolicibacter"
MYCOLICIBACTERIUM = MYCOLICIBACTER + "ium"


@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


def _independent_ids_under(conn, parent, depth):
    prefix = parent + ";"
    return sorted(r[0] for r in conn.execute(
        "SELECT annotation_id FROM annotation_catalog "
        "WHERE source = 'taxonomy' AND depth = ? AND substr(annotation_id, 1, ?) = ?",
        (depth, len(prefix), prefix),
    ))


# ── get_taxa_under_at_rank_sql ───────────────────────────────────────────────

def test_families_under_gammaproteobacteria_match_an_independent_scan(conn):
    taxa = get_taxa_under_at_rank_sql(conn, GAMMA, 5)
    assert [t["annotation_id"] for t in taxa] == _independent_ids_under(conn, GAMMA, 5)
    assert len(taxa) == 76


def test_can_skip_ranks_family_to_species(conn):
    taxa = get_taxa_under_at_rank_sql(conn, PSEUDOMONADACEAE, 7)
    assert [t["annotation_id"] for t in taxa] == _independent_ids_under(conn, PSEUDOMONADACEAE, 7)
    assert len(taxa) > 500  # large enough to exercise iter_taxa_series_sql's chunking below


def test_rows_are_id_and_name(conn):
    taxa = get_taxa_under_at_rank_sql(conn, GAMMA, 5)
    assert all(set(t) == {"annotation_id", "name"} for t in taxa)
    assert all(t["annotation_id"].rsplit(";", 1)[1] == t["name"] for t in taxa)


def test_unclassified_placeholders_are_included(conn):
    """They carry the reads that stop above this rank -- dropping them
    would make the children no longer add up to the parent."""
    names = {t["name"] for t in get_taxa_under_at_rank_sql(conn, GAMMA, 5)}
    assert any(n.startswith("unclassified ") for n in names)


def test_prefix_sibling_is_not_counted_as_a_descendant(conn):
    ids = [t["annotation_id"] for t in get_taxa_under_at_rank_sql(conn, MYCOLICIBACTER, 7)]
    assert ids, "expected real species under Mycolicibacter"
    assert all(i.startswith(MYCOLICIBACTER + ";") for i in ids)
    assert not any(i.startswith(MYCOLICIBACTERIUM) for i in ids)


def test_homonym_genera_are_separate_rows(conn):
    ids = {t["annotation_id"] for t in get_taxa_under_at_rank_sql(conn, ALPHA, 6)}
    assert BOSEA_OLD_LINEAGE in ids
    assert BOSEA_NEW_LINEAGE in ids


def test_no_parent_means_the_whole_dataset(conn):
    taxa = get_taxa_under_at_rank_sql(conn, None, 1)
    assert [t["annotation_id"] for t in taxa] == ["Archaea", "Bacteria", "Eukaryota", "Viruses"]


def test_parent_with_nothing_under_it_returns_empty(conn):
    assert get_taxa_under_at_rank_sql(conn, "Not a real taxon", 5) == []


@pytest.mark.parametrize("bad_depth", [0, 9])
def test_depth_outside_valid_range_raises(conn, bad_depth):
    with pytest.raises(ValueError):
        get_taxa_under_at_rank_sql(conn, GAMMA, bad_depth)


# ── iter_taxa_series_sql ─────────────────────────────────────────────────────

def test_series_rows_match_an_independent_count(conn):
    ids = [t["annotation_id"] for t in get_taxa_under_at_rank_sql(conn, GAMMA, 5)]
    rows = list(iter_taxa_series_sql(conn, ids))
    placeholders = ",".join("?" * len(ids))
    expected = conn.execute(
        f"SELECT COUNT(*) FROM annotation_series WHERE source = 'taxonomy' AND annotation_id IN ({placeholders})",
        ids,
    ).fetchone()[0]
    assert len(rows) == expected
    assert all(set(r) == {"annotation_id", "name", "sample", "egc", "norm_egc"} for r in rows)


def test_series_rows_are_grouped_by_taxon_in_id_order(conn):
    ids = [t["annotation_id"] for t in get_taxa_under_at_rank_sql(conn, GAMMA, 5)]
    seen = [r["annotation_id"] for r in iter_taxa_series_sql(conn, ids)]
    assert seen == sorted(seen)


def test_more_than_one_chunk_returns_every_row_exactly_once(conn):
    ids = [t["annotation_id"] for t in get_taxa_under_at_rank_sql(conn, PSEUDOMONADACEAE, 7)]
    rows = list(iter_taxa_series_sql(conn, ids))
    keys = [(r["annotation_id"], r["sample"]) for r in rows]
    assert len(keys) == len(set(keys))
    assert {r["annotation_id"] for r in rows} == set(ids)


def test_families_add_up_to_their_class_in_every_sample(conn):
    """Real-data check that the download is complete: summed per sample,
    every family under Gammaproteobacteria (placeholders included) equals
    Gammaproteobacteria's own egc."""
    ids = [t["annotation_id"] for t in get_taxa_under_at_rank_sql(conn, GAMMA, 5)]
    summed = defaultdict(float)
    for r in iter_taxa_series_sql(conn, ids):
        summed[r["sample"]] += r["egc"]
    parent = dict(conn.execute(
        "SELECT sample, egc FROM annotation_series WHERE source = 'taxonomy' AND annotation_id = ?",
        (GAMMA,),
    ).fetchall())
    assert set(summed) == set(parent)
    for sample, egc in parent.items():
        assert summed[sample] == pytest.approx(egc)


def test_no_ids_yields_nothing(conn):
    assert list(iter_taxa_series_sql(conn, [])) == []
