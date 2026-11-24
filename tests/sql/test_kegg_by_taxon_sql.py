"""
test_kegg_by_taxon_sql.py
===========================
Tests for iter_kegg_by_taxon_sql() and count_kegg_genes_sql()
(FastAPI/api/cache_sql.py): a KO's egc split by taxon, per sample.

A gene's EGC is its scaffold's AvgFold (scaffold_fold), so a taxon's share
of a KO is the sum over that KO's genes in that taxon. kegg_taxon_fold
holds that sum per KO, sample and full taxon path (built by
build_kegg_taxon_fold), and the query adds paths up to the chosen rank.
Taxa are grouped by lineage, so two genera with the same name under
different families stay apart.

The first group uses an in-memory database; the last group checks the real
hab_mappings.db: the taxa of every KO must add up to its stored egc, and
the stored table must match summing the genes directly.

Run:
    pytest tests/sql/test_kegg_by_taxon_sql.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.cache_sql import count_kegg_genes_sql, iter_kegg_by_taxon_sql  # noqa: E402
from api.config import SQLITE_DB_PATH  # noqa: E402
from scripts.create_sql_schema import SCHEMA  # noqa: E402
from scripts.migrate_scaffold_fold_to_sql import build_kegg_taxon_fold  # noqa: E402


# pylint: disable=redefined-outer-name

GENUS = 6
PHYLUM = 2
STRAIN = 8

# Two strains in one genus, plus a same-named genus in another family.
PATH_A1 = "Bacteria;P1;C1;O1;F1;Gen;Gen sp1;Gen sp1 str1"
PATH_A2 = "Bacteria;P1;C1;O1;F1;Gen;Gen sp2;Gen sp2 str2"
PATH_B = "Bacteria;P1;C1;O1;F2;Gen;Gen sp3;Gen sp3 str3"


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    for i, path in enumerate([PATH_A1, PATH_A2, PATH_B], 1):
        parts = path.split(";")
        connection.execute(
            'INSERT INTO taxon_paths (id, domain, phylum, class_, "order", family, genus, species, strain, full_path) '
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (i, *parts, path),
        )
    connection.executemany(
        "INSERT INTO sample_totals (sample, weighted_total) VALUES (?, ?)",
        [("s1", 100.0), ("s2", 200.0)],
    )
    connection.commit()
    yield connection
    connection.close()


def add_gene(conn, sample, scaffold, fold, ko, taxon_path_id):
    n = conn.execute("SELECT COUNT(*) FROM mappings").fetchone()[0]
    conn.execute(
        "INSERT INTO mappings (sample, gene_id, scaffold_id, taxon_path_id, kegg_id) VALUES (?, ?, ?, ?, ?)",
        (sample, f"{scaffold}_{n}_{n + 9}", scaffold, taxon_path_id, f"KO:{ko}" if ko else None),
    )
    conn.execute(
        "INSERT OR IGNORE INTO scaffold_fold (sample, scaffold_id, avg_fold) VALUES (?, ?, ?)",
        (sample, scaffold, fold),
    )
    conn.commit()
    build_kegg_taxon_fold(conn)


def stored(conn):
    return conn.execute("SELECT kegg_id, sample, taxon_path_id, egc FROM kegg_taxon_fold ORDER BY 1, 2, 3").fetchall()


# ── build_kegg_taxon_fold ─────────────────────────────────────────────────────

def test_build_sums_a_kos_genes_per_sample_and_path(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)
    add_gene(conn, "s1", "sc2", 4.0, "K00001", 1)
    add_gene(conn, "s1", "sc3", 5.0, "K00001", 2)
    add_gene(conn, "s2", "sc1", 7.0, "K00001", 1)

    assert stored(conn) == [("K00001", "s1", 1, 14.0), ("K00001", "s1", 2, 5.0), ("K00001", "s2", 1, 7.0)]


def test_build_skips_genes_without_a_ko_and_keeps_no_taxonomy_as_0(conn):
    add_gene(conn, "s1", "sc1", 10.0, None, 1)
    add_gene(conn, "s1", "sc2", 4.0, "K00001", None)

    assert stored(conn) == [("K00001", "s1", 0, 4.0)]


def test_build_replaces_the_old_rows(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)
    conn.execute("DELETE FROM mappings")
    conn.commit()
    build_kegg_taxon_fold(conn)

    assert stored(conn) == []


# ── iter_kegg_by_taxon_sql ────────────────────────────────────────────────────


def rows(conn, kos, depth, samples=("s1", "s2")):
    return [
        (r["ko"], r["taxon"], r["lineage"], r["sample"], r["egc"])
        for r in iter_kegg_by_taxon_sql(conn, list(kos), depth, list(samples))
    ]


def test_genes_in_one_genus_are_added_together(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)
    add_gene(conn, "s1", "sc2", 4.0, "K00001", 2)

    assert rows(conn, ["K00001"], GENUS) == [("K00001", "Gen", "Bacteria;P1;C1;O1;F1;Gen", "s1", 14.0)]


def test_same_named_genus_in_another_family_stays_separate(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)
    add_gene(conn, "s1", "sc3", 5.0, "K00001", 3)

    assert rows(conn, ["K00001"], GENUS) == [
        ("K00001", "Gen", "Bacteria;P1;C1;O1;F1;Gen", "s1", 10.0),
        ("K00001", "Gen", "Bacteria;P1;C1;O1;F2;Gen", "s1", 5.0),
    ]


def test_higher_rank_merges_lineages(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)
    add_gene(conn, "s1", "sc3", 5.0, "K00001", 3)

    assert rows(conn, ["K00001"], PHYLUM) == [("K00001", "P1", "Bacteria;P1", "s1", 15.0)]


def test_strain_rank_gives_the_full_lineage(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)

    assert rows(conn, ["K00001"], STRAIN) == [("K00001", "Gen sp1 str1", PATH_A1, "s1", 10.0)]


def test_gene_with_no_taxonomy_is_unclassified(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", None)

    assert rows(conn, ["K00001"], GENUS) == [("K00001", "Unclassified", "", "s1", 10.0)]


def test_each_gene_counts_its_scaffold_fold(conn):
    # Two genes of the KO on one scaffold: EGC counts the scaffold twice.
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)

    assert rows(conn, ["K00001"], GENUS)[0][4] == 20.0


def test_norm_egc_divides_by_the_sample_total(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)
    add_gene(conn, "s2", "sc1", 10.0, "K00001", 1)

    norms = {r["sample"]: r["norm_egc"] for r in iter_kegg_by_taxon_sql(conn, ["K00001"], GENUS, ["s1", "s2"])}
    assert norms == {"s1": pytest.approx(0.1), "s2": pytest.approx(0.05)}


def test_only_requested_samples_and_kos(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)
    add_gene(conn, "s2", "sc1", 3.0, "K00001", 1)
    add_gene(conn, "s1", "sc2", 4.0, "K00002", 1)
    add_gene(conn, "s1", "sc4", 2.0, None, 1)

    assert rows(conn, ["K00001"], GENUS, samples=["s2"]) == [
        ("K00001", "Gen", "Bacteria;P1;C1;O1;F1;Gen", "s2", 3.0),
    ]


def test_rows_come_back_by_ko_then_lineage_then_sample(conn):
    add_gene(conn, "s2", "sc3", 1.0, "K00002", 3)
    add_gene(conn, "s1", "sc3", 1.0, "K00002", 3)
    add_gene(conn, "s1", "sc1", 1.0, "K00002", 1)
    add_gene(conn, "s1", "sc5", 1.0, "K00001", 1)

    keys = [(r[0], r[2], r[3]) for r in rows(conn, ["K00002", "K00001"], GENUS)]
    assert keys == sorted(keys)


def test_ko_with_no_genes_gives_no_rows(conn):
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)

    assert rows(conn, ["K09999"], GENUS) == []


def test_reads_only_the_prebuilt_table(conn):
    # The download must not touch the big mappings / scaffold_fold tables.
    add_gene(conn, "s1", "sc1", 10.0, "K00001", 1)
    conn.execute("DELETE FROM mappings")
    conn.execute("DELETE FROM scaffold_fold")
    conn.commit()

    assert rows(conn, ["K00001"], GENUS) == [("K00001", "Gen", "Bacteria;P1;C1;O1;F1;Gen", "s1", 10.0)]


def test_bad_depth_is_rejected(conn):
    with pytest.raises(ValueError):
        list(iter_kegg_by_taxon_sql(conn, ["K00001"], 9, ["s1"]))


def test_count_kegg_genes_counts_genes_in_samples(conn):
    add_gene(conn, "s1", "sc1", 1.0, "K00001", 1)
    add_gene(conn, "s1", "sc1", 1.0, "K00001", 1)
    add_gene(conn, "s2", "sc1", 1.0, "K00001", 1)
    add_gene(conn, "s1", "sc2", 1.0, "K00002", 1)

    assert count_kegg_genes_sql(conn, ["K00001", "K00002"], ["s1"]) == 3
    assert count_kegg_genes_sql(conn, ["K00001"], ["s1", "s2"]) == 3


# ── Real database ─────────────────────────────────────────────────────────────

REAL_SAMPLES = ["3300060358", "3300060426", "3300068252"]


@pytest.fixture(scope="module")
def real_conn():
    if not os.path.exists(SQLITE_DB_PATH) or os.path.getsize(SQLITE_DB_PATH) == 0:
        pytest.skip(f"{SQLITE_DB_PATH} not found")
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    names = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if not {"scaffold_fold", "kegg_taxon_fold"} <= names:
        connection.close()
        pytest.skip("scaffold_fold / kegg_taxon_fold not built -- run migrate_scaffold_fold_to_sql.py")
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def real_kos(real_conn):
    """The most widespread KOs plus a few rare ones."""
    common = [r[0] for r in real_conn.execute(
        "SELECT annotation_id FROM annotation_catalog WHERE source = 'kegg' ORDER BY mean_egc DESC LIMIT 15"
    )]
    rare = [r[0] for r in real_conn.execute(
        "SELECT annotation_id FROM annotation_catalog WHERE source = 'kegg' AND sample_count < 10 "
        "ORDER BY annotation_id LIMIT 5"
    )]
    return common + rare


@pytest.mark.parametrize("depth", [PHYLUM, GENUS, STRAIN])
def test_real_taxa_add_up_to_stored_egc(real_conn, real_kos, depth):
    totals = {}
    for r in iter_kegg_by_taxon_sql(real_conn, real_kos, depth, REAL_SAMPLES):
        key = (r["ko"], r["sample"])
        totals[key] = totals.get(key, 0.0) + r["egc"]
    placeholders = ",".join("?" * len(real_kos))
    stored = {
        (ko, sample): egc
        for ko, sample, egc in real_conn.execute(
            f"SELECT annotation_id, sample, egc FROM annotation_series "
            f"WHERE source = 'kegg' AND annotation_id IN ({placeholders}) AND sample IN (?, ?, ?)",
            (*real_kos, *REAL_SAMPLES),
        )
    }
    assert stored, "no stored series for the chosen KOs"
    assert totals.keys() == stored.keys()
    wrong = [k for k in stored if totals[k] != pytest.approx(stored[k], rel=1e-9)]
    assert not wrong, f"{len(wrong)} (KO, sample) totals differ, e.g. {wrong[:5]}"


def test_real_prebuilt_table_matches_summing_the_genes(real_conn, real_kos):
    """kegg_taxon_fold equals summing each gene's scaffold AvgFold directly."""
    placeholders = ",".join("?" * len(real_kos))
    direct = {
        (ko, sample, path): egc
        for ko, sample, path, egc in real_conn.execute(
            f"SELECT substr(m.kegg_id, 4), m.sample, COALESCE(m.taxon_path_id, 0), SUM(f.avg_fold) "
            f"FROM mappings m JOIN scaffold_fold f ON f.sample = m.sample AND f.scaffold_id = m.scaffold_id "
            f"WHERE m.kegg_id IN ({placeholders}) AND m.sample IN (?, ?, ?) GROUP BY 1, 2, 3",
            (*(f"KO:{k}" for k in real_kos), *REAL_SAMPLES),
        )
    }
    prebuilt = {
        (ko, sample, path): egc
        for ko, sample, path, egc in real_conn.execute(
            f"SELECT kegg_id, sample, taxon_path_id, egc FROM kegg_taxon_fold "
            f"WHERE kegg_id IN ({placeholders}) AND sample IN (?, ?, ?)",
            (*real_kos, *REAL_SAMPLES),
        )
    }
    assert direct and prebuilt.keys() == direct.keys()
    wrong = [k for k in direct if prebuilt[k] != pytest.approx(direct[k], rel=1e-12)]
    assert not wrong, f"{len(wrong)} rows differ, e.g. {wrong[:5]}"


def test_real_genus_lineages_are_taxonomy_node_ids(real_conn, real_kos):
    """Each genus row's lineage is a taxon the site knows by that id."""
    lineages = {
        r["lineage"] for r in iter_kegg_by_taxon_sql(real_conn, real_kos[:3], GENUS, REAL_SAMPLES) if r["lineage"]
    }
    placeholders = ",".join("?" * len(lineages))
    known = {
        r[0] for r in real_conn.execute(
            f"SELECT annotation_id FROM annotation_catalog WHERE source = 'taxonomy' AND annotation_id IN ({placeholders})",
            tuple(lineages),
        )
    }
    assert lineages and lineages == known
