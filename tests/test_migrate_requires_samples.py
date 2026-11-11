"""
test_migrate_requires_samples.py
================================
The mapping rebuild (FastAPI/scripts/migrate_mappings_to_sql.py) reads its
sample list from the Mappings_by_Sample folder. If that folder can't be
found (e.g. a case mismatch on Linux), it must stop with a clear error --
not "succeed" having loaded 0 samples and print "Done".

Run:
    pytest tests/test_migrate_requires_samples.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI", "scripts"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

import migrate_mappings_to_sql as migrate  # pylint: disable=wrong-import-position,import-error


def test_taxon_path_pass_stops_when_no_samples_are_found(monkeypatch):
    monkeypatch.setattr(migrate, "get_all_sample_names", lambda: [])
    with pytest.raises(SystemExit) as exc:
        list(migrate.iter_unique_taxon_paths())
    assert "Mappings_by_Sample" in str(exc.value) or "no samples" in str(exc.value).lower()


def test_mappings_pass_stops_when_no_samples_are_found(monkeypatch, tmp_path):
    import sqlite3
    db = tmp_path / "empty.db"
    sqlite3.connect(db).executescript(
        "CREATE TABLE taxon_paths (id INTEGER PRIMARY KEY, full_path TEXT);"
        "CREATE TABLE mappings (id INTEGER PRIMARY KEY);"
    )
    monkeypatch.setattr(migrate, "SQLITE_DB_PATH", str(db))
    monkeypatch.setattr(migrate, "get_all_sample_names", lambda: [])
    with pytest.raises(SystemExit):
        migrate.populate_mappings()


def test_a_lineage_missing_from_the_lookup_stops_before_touching_the_sample(monkeypatch, tmp_path):
    """Every gene's lineage must resolve; one that doesn't would silently
    store the gene with no taxonomy. The sample's existing rows stay."""
    import sqlite3
    db = sqlite3.connect(":memory:")
    db.executescript(
        "CREATE TABLE mappings (id INTEGER PRIMARY KEY, sample TEXT, gene_id TEXT, scaffold_id TEXT, taxon_path_id INTEGER, kegg_id TEXT);"
        "CREATE TABLE gene_cog (mapping_id INTEGER, cog_id TEXT, sample TEXT);"
        "CREATE TABLE gene_enzyme (mapping_id INTEGER, ec_id TEXT, sample TEXT);"
        "INSERT INTO mappings (sample, gene_id) VALUES ('s1', 'old_gene');"
    )
    (tmp_path / "s1_mapping.tsv").write_text(
        "gene_id\tscaffold_id\ttaxonomy\tkegg\tcog\tenzyme\n"
        "g1\tsc1\tBacteria;Proteobacteria\t\t\t\n"
        "g2\tsc1\tBacteria;Nowhere\t\t\t\n"
    )
    monkeypatch.setattr(migrate, "MAPPINGS_DIR", str(tmp_path))
    lookup = {migrate.normalize_lineage("Bacteria;Proteobacteria"): 1}
    with pytest.raises(SystemExit) as exc:
        migrate.populate_mappings_for_sample(db, "s1", lookup)
    assert "Bacteria;Nowhere" in str(exc.value)
    assert db.execute("SELECT gene_id FROM mappings").fetchall() == [("old_gene",)]
