"""
test_fix_semicolon_strains.py
=============================
FastAPI/scripts/fix_semicolon_strains.py repairs a database built before
api/taxon_lineage.py: a strain name containing ";" had been split into a
fake strain-level node (its text before the ";") plus a fake 9th-level node
holding the identical data. The fix keeps one strain-level node named by
normalize_lineage, removes the 9th-level copy (and its scaffold rows), and
writes taxon_paths' strain/full_path the same way.

Run:
    pytest tests/test_fix_semicolon_strains.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI", "scripts"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from fix_semicolon_strains import fix_semicolon_strains  # pylint: disable=wrong-import-position,import-error

SPECIES = "Eukaryota;Arthropoda;Insecta;Diptera;Drosophilidae;Drosophila;Drosophila melanogaster"
FAKE8   = SPECIES + ";Drosophila melanogaster y"
FAKE9   = FAKE8 + ";cn bw sp"
GOOD    = SPECIES + ";Drosophila melanogaster y, cn bw sp"
RAW     = SPECIES + ";Drosophila melanogaster y; cn bw sp"


def _db():
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE annotation_series (id INTEGER PRIMARY KEY, source TEXT, sample TEXT,
            annotation_id TEXT, name TEXT, category TEXT, parent TEXT, depth INTEGER,
            egc REAL, norm_egc REAL, scaffold_count INTEGER, gene_count INTEGER);
        CREATE TABLE annotation_catalog (id INTEGER PRIMARY KEY, source TEXT, annotation_id TEXT,
            name TEXT, parent TEXT, mean_egc REAL, max_egc REAL, mean_norm_egc REAL,
            max_norm_egc REAL, sample_count INTEGER, depth INTEGER);
        CREATE TABLE scaffolds (id INTEGER PRIMARY KEY, annotation_series_id INTEGER,
            scaffold_id TEXT, gene_count INTEGER);
        CREATE TABLE correlations_cache (id INTEGER PRIMARY KEY, catalog_id_a INTEGER,
            catalog_id_b INTEGER, r REAL, metric TEXT, method TEXT, lag_samples INTEGER,
            p_value REAL, n_pairs INTEGER, at_p_floor INTEGER);
        CREATE TABLE taxon_paths (id INTEGER PRIMARY KEY, domain TEXT, phylum TEXT, class_ TEXT,
            "order" TEXT, family TEXT, genus TEXT, species TEXT, strain TEXT, full_path TEXT);
    """)
    for sample in ("s1", "s2"):
        for aid, name, parent, depth in [(SPECIES, "Drosophila melanogaster", "x", 7),
                                         (FAKE8, "Drosophila melanogaster y", SPECIES, 8),
                                         (FAKE9, "cn bw sp", FAKE8, 9)]:
            cur = conn.execute(
                "INSERT INTO annotation_series (source, sample, annotation_id, name, category, parent, depth, egc, norm_egc, scaffold_count, gene_count) "
                "VALUES ('taxonomy', ?, ?, ?, 'Eukaryota', ?, ?, 10, 0.1, 2, 3)",
                (sample, aid, name, parent, depth))
            conn.execute("INSERT INTO scaffolds (annotation_series_id, scaffold_id, gene_count) VALUES (?, 'sc1', 3)", (cur.lastrowid,))
    for aid, name, parent, depth in [(SPECIES, "Drosophila melanogaster", "x", 7),
                                     (FAKE8, "Drosophila melanogaster y", SPECIES, 8),
                                     (FAKE9, "cn bw sp", FAKE8, 9)]:
        conn.execute(
            "INSERT INTO annotation_catalog (source, annotation_id, name, parent, mean_egc, max_egc, mean_norm_egc, max_norm_egc, sample_count, depth) "
            "VALUES ('taxonomy', ?, ?, ?, 10, 10, 0.1, 0.1, 2, ?)", (aid, name, parent, depth))
    conn.execute(
        "INSERT INTO taxon_paths (domain, phylum, class_, \"order\", family, genus, species, strain, full_path) "
        "VALUES ('Eukaryota','Arthropoda','Insecta','Diptera','Drosophilidae','Drosophila','Drosophila melanogaster','Drosophila melanogaster y; cn bw sp', ?)",
        (RAW,))
    conn.commit()
    return conn


def test_merges_the_two_fake_nodes_into_one_strain():
    conn = _db()
    fix_semicolon_strains(conn)

    ids = {r[0] for r in conn.execute("SELECT DISTINCT annotation_id FROM annotation_series")}
    assert ids == {SPECIES, GOOD}
    assert conn.execute("SELECT MAX(depth) FROM annotation_catalog").fetchone()[0] == 8
    name, parent, depth = conn.execute(
        "SELECT name, parent, depth FROM annotation_catalog WHERE annotation_id = ?", (GOOD,)).fetchone()
    assert (name, parent, depth) == ("Drosophila melanogaster y, cn bw sp", SPECIES, 8)
    assert conn.execute("SELECT COUNT(*) FROM annotation_series WHERE annotation_id = ?", (GOOD,)).fetchone()[0] == 2
    # the 9th-level copy's scaffold rows are gone; the kept node's remain
    assert conn.execute("SELECT COUNT(*) FROM scaffolds").fetchone()[0] == 4


def test_taxon_paths_uses_the_same_name():
    conn = _db()
    fix_semicolon_strains(conn)
    strain, full_path = conn.execute("SELECT strain, full_path FROM taxon_paths").fetchone()
    assert strain == "Drosophila melanogaster y, cn bw sp"
    assert full_path == GOOD


def test_running_twice_changes_nothing_more():
    conn = _db()
    fix_semicolon_strains(conn)
    before = conn.execute("SELECT COUNT(*) FROM annotation_series").fetchone()[0]
    assert fix_semicolon_strains(conn)["merged"] == 0
    assert conn.execute("SELECT COUNT(*) FROM annotation_series").fetchone()[0] == before


def test_refuses_when_the_fake_strain_has_another_child():
    conn = _db()
    conn.execute(
        "INSERT INTO annotation_catalog (source, annotation_id, name, parent, depth) VALUES ('taxonomy', ?, 'other', ?, 9)",
        (FAKE8 + ";other", FAKE8))
    conn.commit()
    with pytest.raises(SystemExit):
        fix_semicolon_strains(conn)
    # nothing was changed
    assert conn.execute("SELECT COUNT(*) FROM annotation_catalog WHERE annotation_id = ?", (FAKE9,)).fetchone()[0] == 1
