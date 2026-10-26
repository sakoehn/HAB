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
