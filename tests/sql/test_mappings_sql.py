"""
test_mappings_sql.py
======================
Real-data tests against the populated SQLite database (hab_mappings.db) --
same spirit as tests/mongo/test_mongo.py: verifies the actual data that's
actually there, not a synthetic fixture. Skips automatically if the
database doesn't exist yet (e.g. a fresh checkout that hasn't run
migrate_mappings_to_sql.py).

Covers three things:
  1. Structural/referential integrity across the whole dataset (no
     duplicate genes per sample, no orphaned junction rows, every
     taxon_path_id resolves, multi-value cells were actually split).
  2. Known real examples, independently re-verified against the database
     immediately before writing these assertions (not assumed from
     memory) -- pins down the exact behavior for a normal gene, a sparse
     gene with only one source, and a genuinely multi-COG gene.
  3. The actual point of the junction-table design: an exact-match query
     on a single COG/EC value works correctly, which a flat comma-joined
     column could not do reliably.

Full-table scans over 74M+ mappings rows are marked @pytest.mark.slow --
run with `-m slow` to include them; the default run covers row counts and
known-example spot checks, which are fast.

Run:
    pytest tests/sql/test_mappings_sql.py -v
    pytest tests/sql/test_mappings_sql.py -v -m slow   # include full-scan checks
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH
from api.cache_sql import get_mappings_sql

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# Known-good totals, independently confirmed against the real database
# right before this file was written (see conversation/project memory for
# provenance -- e.g. sample 3300060358's count matches the figure verified
# independently three separate times during the mapping-TSV rebuild).
EXPECTED_TOTAL_MAPPINGS   = 74_109_175
EXPECTED_TOTAL_TAXON_PATHS = 42_099
EXPECTED_SAMPLE_COUNT      = 128
EXPECTED_SAMPLE_3300060358_ROWS = 569_700


# Every test below takes a `conn` parameter to receive this fixture's
# value -- pylint sees that as shadowing the module-level `conn` name,
# but it's the standard pytest fixture-injection pattern, not a real bug.
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


# ═══════════════════════════════════════════════════════════════════════════
# Row counts -- fast, whole-table COUNT(*) only
# ═══════════════════════════════════════════════════════════════════════════

def test_total_mapping_row_count(conn):
    assert conn.execute("SELECT COUNT(*) FROM mappings").fetchone()[0] == EXPECTED_TOTAL_MAPPINGS


def test_total_taxon_path_count(conn):
    assert conn.execute("SELECT COUNT(*) FROM taxon_paths").fetchone()[0] == EXPECTED_TOTAL_TAXON_PATHS


def test_all_128_samples_present(conn):
    assert conn.execute("SELECT COUNT(DISTINCT sample) FROM mappings").fetchone()[0] == EXPECTED_SAMPLE_COUNT


def test_known_sample_row_count_matches_independently_verified_figure(conn):
    """Cross-check against the exact figure independently verified three
    separate times during the mapping-TSV rebuild (union-of-raw-sources
    count for this sample) -- if this ever drifts, something upstream of
    the SQL population changed without the SQL side being rebuilt to match."""
    count = conn.execute("SELECT COUNT(*) FROM mappings WHERE sample = ?", ("3300060358",)).fetchone()[0]
    assert count == EXPECTED_SAMPLE_3300060358_ROWS


# ═══════════════════════════════════════════════════════════════════════════
# Known real examples -- values re-verified against the live database
# immediately before writing these assertions, not assumed from memory
# ═══════════════════════════════════════════════════════════════════════════

def test_known_gene_with_multi_value_enzyme(conn):
    """Ga0590986_0000001_100946_102454 in sample 3300060358: single KEGG
    hit, single COG hit, two genuinely distinct EC numbers (bifunctional
    enzyme), real taxonomy. The gene this whole SQL branch has used as its
    running example since the very first schema discussion."""
    row = conn.execute(
        "SELECT id, scaffold_id, taxon_path_id, kegg_id FROM mappings WHERE sample=? AND gene_id=?",
        ("3300060358", "Ga0590986_0000001_100946_102454"),
    ).fetchone()
    assert row is not None
    mapping_id, scaffold_id, taxon_path_id, kegg_id = row

    assert scaffold_id == "Ga0590986_0000001"
    assert kegg_id == "KO:K02112"

    cogs = [r[0] for r in conn.execute("SELECT cog_id FROM gene_cog WHERE mapping_id=?", (mapping_id,))]
    assert cogs == ["COG0055"]

    enzymes = sorted(r[0] for r in conn.execute("SELECT ec_id FROM gene_enzyme WHERE mapping_id=?", (mapping_id,)))
    assert enzymes == ["EC:7.1.2.2", "EC:7.2.2.1"]

    full_path = conn.execute("SELECT full_path FROM taxon_paths WHERE id=?", (taxon_path_id,)).fetchone()[0]
    assert full_path == (
        "Bacteria;Bacteroidetes;Flavobacteriia;Flavobacteriales;Flavobacteriaceae;"
        "Wenyingzhuangia;Wenyingzhuangia heitensis;Wenyingzhuangia heitensis DSM 101599"
    )


def test_known_sparse_gene_with_only_one_source(conn):
    """Ga0590986_0139918_1152_1319 in sample 3300060358: only a (weak,
    evalue 0.0026 -- no filtering applied, by design) COG hit, nothing in
    taxonomy/kegg/enzyme. Proves the union-not-intersection behavior
    (a gene needs only ONE source to get a row) survived into SQL."""
    row = conn.execute(
        "SELECT id, taxon_path_id, kegg_id FROM mappings WHERE sample=? AND gene_id=?",
        ("3300060358", "Ga0590986_0139918_1152_1319"),
    ).fetchone()
    assert row is not None
    mapping_id, taxon_path_id, kegg_id = row

    assert taxon_path_id is None
    assert kegg_id is None
    assert [r[0] for r in conn.execute("SELECT cog_id FROM gene_cog WHERE mapping_id=?", (mapping_id,))] == ["COG0864"]
    assert conn.execute("SELECT COUNT(*) FROM gene_enzyme WHERE mapping_id=?", (mapping_id,)).fetchone()[0] == 0


def test_known_gene_with_two_genuinely_distinct_cog_hits(conn):
    """Ga0590839_000001_63531_65801 in sample 3300060395: real multi-domain
    gene with two DIFFERENT COG ids (COG0280, COG0281), not a duplicate
    hit collapsing to one -- confirmed via the smoke test that first
    exercised this population logic."""
    mapping_id = conn.execute(
        "SELECT id FROM mappings WHERE sample=? AND gene_id=?",
        ("3300060395", "Ga0590839_000001_63531_65801"),
    ).fetchone()[0]
    cogs = sorted(r[0] for r in conn.execute("SELECT cog_id FROM gene_cog WHERE mapping_id=?", (mapping_id,)))
    assert cogs == ["COG0280", "COG0281"]


# ═══════════════════════════════════════════════════════════════════════════
# The actual point of the junction-table design: real indexed-shape queries
# ═══════════════════════════════════════════════════════════════════════════

def test_exact_match_cog_query_finds_the_right_gene(conn):
    """The whole reason gene_cog exists instead of a comma-joined column:
    an exact WHERE cog_id = '...' match must find a gene correctly even
    though that gene ALSO has other COG/EC values -- a flat multi-value
    cell couldn't do this without a fragile string-contains check."""
    rows = conn.execute(
        """
        SELECT m.sample, m.gene_id FROM mappings m
        JOIN gene_cog c ON c.mapping_id = m.id
        WHERE c.cog_id = 'COG0055' AND m.sample = ? AND m.gene_id = ?
        """,
        ("3300060358", "Ga0590986_0000001_100946_102454"),
    ).fetchall()
    assert rows == [("3300060358", "Ga0590986_0000001_100946_102454")]

    # Negative control: a COG id that this specific gene does NOT have
    # must not match it, proving this isn't a substring-style false match.
    rows = conn.execute(
        """
        SELECT m.gene_id FROM mappings m
        JOIN gene_cog c ON c.mapping_id = m.id
        WHERE c.cog_id = 'COG9999999' AND m.sample = ? AND m.gene_id = ?
        """,
        ("3300060358", "Ga0590986_0000001_100946_102454"),
    ).fetchall()
    assert rows == []


def test_full_gene_picture_reconstructs_via_join(conn):
    """One JOIN query, not a giant pre-joined flat row, reconstructs
    everything about a gene -- demonstrating the query-time join pattern
    discussed for this schema (mappings + taxon_paths + gene_cog)."""
    row = conn.execute(
        """
        SELECT m.gene_id, m.scaffold_id, tp.full_path, m.kegg_id, c.cog_id
        FROM mappings m
        LEFT JOIN taxon_paths tp ON tp.id = m.taxon_path_id
        LEFT JOIN gene_cog c ON c.mapping_id = m.id
        WHERE m.sample = ? AND m.gene_id = ?
        """,
        ("3300060358", "Ga0590986_0000001_100946_102454"),
    ).fetchone()
    assert row[0] == "Ga0590986_0000001_100946_102454"
    assert row[1] == "Ga0590986_0000001"
    assert row[2].startswith("Bacteria;Bacteroidetes")
    assert row[3] == "KO:K02112"
    assert row[4] == "COG0055"


# ═══════════════════════════════════════════════════════════════════════════
# Full-dataset integrity checks -- real work at 74M+ rows, marked slow
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.slow
def test_no_duplicate_gene_id_within_a_sample(conn):
    """gene_id is only meaningful within its own sample (each JGI project
    is independent) -- but WITHIN one sample, a gene_id must be unique.
    A duplicate would mean the same gene got inserted twice."""
    dupes = conn.execute(
        "SELECT sample, gene_id, COUNT(*) c FROM mappings GROUP BY sample, gene_id HAVING c > 1 LIMIT 5"
    ).fetchall()
    assert dupes == []


@pytest.mark.slow
def test_no_orphaned_gene_cog_rows(conn):
    """Every gene_cog row must point at a mapping_id that actually exists
    -- SQLite doesn't enforce this FK by default, so it has to be checked."""
    orphans = conn.execute("SELECT COUNT(*) FROM gene_cog WHERE mapping_id NOT IN (SELECT id FROM mappings)").fetchone()[0]
    assert orphans == 0


@pytest.mark.slow
def test_no_orphaned_gene_enzyme_rows(conn):
    orphans = conn.execute("SELECT COUNT(*) FROM gene_enzyme WHERE mapping_id NOT IN (SELECT id FROM mappings)").fetchone()[0]
    assert orphans == 0


@pytest.mark.slow
def test_all_non_null_taxon_path_ids_resolve(conn):
    """Every taxon_path_id actually used in mappings must exist in
    taxon_paths -- a dangling reference would mean the lookup dict used
    during population missed a real taxonomy string."""
    dangling = conn.execute(
        """
        SELECT COUNT(*) FROM mappings
        WHERE taxon_path_id IS NOT NULL
          AND taxon_path_id NOT IN (SELECT id FROM taxon_paths)
        """
    ).fetchone()[0]
    assert dangling == 0


@pytest.mark.slow
def test_no_multi_value_cells_leaked_into_columns(conn):
    """kegg_id (a plain column, not a junction table) must never contain a
    comma -- confirms the "KEGG is always single-valued" assumption this
    whole design depends on still held for every real row, not just the
    samples spot-checked earlier."""
    bad = conn.execute("SELECT COUNT(*) FROM mappings WHERE kegg_id LIKE '%,%'").fetchone()[0]
    assert bad == 0


@pytest.mark.slow
def test_junction_table_values_are_single_ids_not_leftover_joined_strings(conn):
    """gene_cog.cog_id / gene_enzyme.ec_id must each hold exactly ONE
    annotation id -- if the comma-split in populate_mappings_for_sample
    ever failed silently, a row here would still contain a joined string
    like "COG0055,COG0056" instead of being split into two rows."""
    bad_cog = conn.execute("SELECT COUNT(*) FROM gene_cog WHERE cog_id LIKE '%,%'").fetchone()[0]
    bad_enz = conn.execute("SELECT COUNT(*) FROM gene_enzyme WHERE ec_id LIKE '%,%'").fetchone()[0]
    assert bad_cog == 0
    assert bad_enz == 0


@pytest.mark.slow
def test_no_duplicate_cog_id_within_one_gene(conn):
    """A single gene shouldn't have the same COG id inserted twice into
    gene_cog -- the TSV build already deduped to a sorted unique set
    before writing, so this should never happen; a violation would mean
    the SQL population itself introduced a duplicate."""
    dupes = conn.execute(
        "SELECT mapping_id, cog_id, COUNT(*) c FROM gene_cog GROUP BY mapping_id, cog_id HAVING c > 1 LIMIT 5"
    ).fetchall()
    assert dupes == []


#=============================================================
#  Test Mapping Search
#=============================================================
@pytest.mark.slow
def test_search_response_shape_correct(conn):
    expected_keys = {"sample", "gene_id", "contig_id", "kegg_id", "cog_id", "enzyme", "taxonomy"}
    for source, annotation_id in [
        ("kegg", "KO:K02112"),
        ("cog", "COG0055"),
        ("enzyme", "EC:7.1.2.2"),
        ("taxonomy", "Wenyingzhuangia heitensis"),
    ]:
        result = get_mappings_sql(conn, source, annotation_id)
        assert result, f"expected at least one row for {source}"
        for row in result:
            assert set(row.keys()) == expected_keys


@pytest.mark.slow
def test_exact_match_only_search(conn):

    assert get_mappings_sql(conn, "cog", "COG0055")
    assert get_mappings_sql(conn, "cog", "COG005") == []

    assert get_mappings_sql(conn, "kegg", "KO:K02112")
    assert get_mappings_sql(conn, "kegg", "KO:K0211") == []

    assert get_mappings_sql(conn, "enzyme", "EC:7.1.2.2")
    assert get_mappings_sql(conn, "enzyme", "EC:7.1.2") == []

    # nonexistent taxonomy value returns empty, not an error
    assert get_mappings_sql(conn, "taxonomy", "INVALID ID") == []

    assert get_mappings_sql(conn, "kegg", "KO:K02112")
    assert get_mappings_sql(conn, "kegg", "KO:K0211") == []

    assert get_mappings_sql(conn, "enzyme", "EC:7.1.2.2")
    assert get_mappings_sql(conn, "enzyme", "EC:7.1.2") == []


@pytest.mark.slow
def test_search_values_correct(conn):
    result = get_mappings_sql(conn, "cog", "COG0055")
    matching_dict = next((item for item in result if item.get("gene_id") == "Ga0590986_0000001_100946_102454" and item.get("sample")=="3300060358"), None)
    assert matching_dict is not None
    assert matching_dict['contig_id'] == "Ga0590986_0000001"
    assert matching_dict['kegg_id'] == "KO:K02112"
    assert matching_dict['cog_id'] == "COG0055"
    assert set(matching_dict['enzyme'].split(",")) == {"EC:7.1.2.2", "EC:7.2.2.1"}
