"""
test_annotation_schema.py
============================
Schema-level tests for the Phase 2 `annotation_series` + `scaffolds` tables
(create_sql_schema.py) -- the SQL-side home for the COG/KEGG/Enzyme/
Taxonomy annotation JSONs (name/category/egc/norm_egc + per-scaffold gene
counts), analogous to Mongo's split annotation_series/scaffolds
collections but without bucketing (SQLite has no document-size limit).

These tests exercise the schema itself directly -- column shape,
constraints, insert/query round-trips -- against a fresh throwaway
database per test (tmp_path), never the real hab_mappings.db (the real
tables are fully populated now, but a schema test wants a controlled,
disposable database it can insert arbitrary/edge-case rows into, not
migrated real data). Same spirit as tests/sql/test_taxon_paths.py testing
logic in isolation.

Run:
    pytest tests/sql/test_annotation_schema.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from scripts.create_sql_schema import create_schema


@pytest.fixture
def db_path(tmp_path):
    path = str(tmp_path / "test_schema.db")
    create_schema(path)
    return path


# Every test below takes a `conn` parameter to receive this fixture's
# value -- pylint sees that as shadowing the module-level `conn` name,
# but it's the standard pytest fixture-injection pattern, not a real bug.
# pylint: disable=redefined-outer-name

@pytest.fixture
def conn(db_path):
    connection = sqlite3.connect(db_path)
    yield connection
    connection.close()


def _columns(connection, table):
    """{column_name: (declared_type, notnull, is_pk)} via PRAGMA table_info."""
    return {
        row[1]: (row[2], bool(row[3]), bool(row[5]))
        for row in connection.execute(f"PRAGMA table_info({table})")
    }


# ═══════════════════════════════════════════════════════════════════════════
# Structural: table + column shape
# ═══════════════════════════════════════════════════════════════════════════

def test_annotation_series_has_expected_columns(conn):
    assert _columns(conn, "annotation_series") == {
        "id":             ("INTEGER", False, True),
        "source":         ("TEXT", True, False),
        "sample":         ("TEXT", True, False),
        "annotation_id":  ("TEXT", True, False),
        "name":           ("TEXT", False, False),
        "category":       ("TEXT", False, False),
        "parent":         ("TEXT", False, False),
        "depth":          ("INTEGER", False, False),
        "egc":            ("REAL", False, False),
        "norm_egc":       ("REAL", False, False),
        "scaffold_count": ("INTEGER", False, False),
        "gene_count":     ("INTEGER", False, False),
    }


def test_scaffolds_has_expected_columns(conn):
    assert _columns(conn, "scaffolds") == {
        "id":                   ("INTEGER", False, True),
        "annotation_series_id": ("INTEGER", True, False),
        "scaffold_id":          ("TEXT", True, False),
        "gene_count":           ("INTEGER", True, False),
    }


def test_annotation_series_has_a_unique_index(conn):
    """UNIQUE(source, sample, annotation_id) must be a real DB-level index,
    not just a design intention -- this is what makes a future migration
    script safe to re-run, same role as mappings(sample, gene_id) in
    Phase 1."""
    indexes = conn.execute("PRAGMA index_list(annotation_series)").fetchall()
    assert any(row[2] == 1 for row in indexes), "expected a UNIQUE index on annotation_series"


def test_schema_creation_is_idempotent_and_preserves_data(db_path, conn):
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'COG0001')")
    conn.commit()

    create_schema(db_path)  # re-run against the same file, must be a no-op

    count = conn.execute("SELECT COUNT(*) FROM annotation_series").fetchone()[0]
    assert count == 1


# ═══════════════════════════════════════════════════════════════════════════
# NOT NULL enforcement
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("missing_column", ["source", "sample", "annotation_id"])
def test_annotation_series_required_columns_reject_null(conn, missing_column):
    values = {"source": "cog", "sample": "3300060358", "annotation_id": "COG0055"}
    values[missing_column] = None
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id) VALUES (?, ?, ?)",
            (values["source"], values["sample"], values["annotation_id"]),
        )


@pytest.mark.parametrize("missing_column", ["annotation_series_id", "scaffold_id", "gene_count"])
def test_scaffolds_required_columns_reject_null(conn, missing_column):
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'COG0001')")
    series_id = conn.execute("SELECT id FROM annotation_series").fetchone()[0]

    values = {"annotation_series_id": series_id, "scaffold_id": "scaffold_1", "gene_count": 3}
    values[missing_column] = None
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO scaffolds (annotation_series_id, scaffold_id, gene_count) VALUES (?, ?, ?)",
            (values["annotation_series_id"], values["scaffold_id"], values["gene_count"]),
        )


def test_annotation_series_optional_columns_default_to_null(conn):
    """name/category/parent/depth/egc/norm_egc/scaffold_count/gene_count
    are all legitimately absent for some rows (e.g. COG/KEGG/Enzyme never
    populate parent/depth) -- must not require a value."""
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'COG0001')")
    row = conn.execute(
        "SELECT name, category, parent, depth, egc, norm_egc, scaffold_count, gene_count "
        "FROM annotation_series WHERE annotation_id='COG0001'"
    ).fetchone()
    assert row == (None, None, None, None, None, None, None, None)


# ═══════════════════════════════════════════════════════════════════════════
# UNIQUE(source, sample, annotation_id) scoping
# ═══════════════════════════════════════════════════════════════════════════

def test_unique_constraint_rejects_exact_duplicate(conn):
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'COG0001')")
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'COG0001')")


def test_unique_constraint_allows_same_annotation_id_different_sample(conn):
    """The same COG id legitimately recurs across all 128 samples -- the
    constraint must be scoped per-sample, not global on annotation_id."""
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'COG0001')")
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's2', 'COG0001')")
    conn.commit()
    count = conn.execute("SELECT COUNT(*) FROM annotation_series WHERE annotation_id='COG0001'").fetchone()[0]
    assert count == 2


def test_unique_constraint_allows_same_annotation_id_different_source(conn):
    """A raw annotation_id string is only meaningful within its own source
    -- scoping uniqueness by source prevents a false cross-source
    collision from ever being possible."""
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'X0001')")
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('kegg', 's1', 'X0001')")
    conn.commit()
    count = conn.execute("SELECT COUNT(*) FROM annotation_series WHERE annotation_id='X0001'").fetchone()[0]
    assert count == 2


# ═══════════════════════════════════════════════════════════════════════════
# Realistic round-trip inserts
# ═══════════════════════════════════════════════════════════════════════════

def test_round_trip_cog_row_has_no_parent_or_depth(conn):
    conn.execute(
        """INSERT INTO annotation_series
           (source, sample, annotation_id, name, category, egc, norm_egc, scaffold_count, gene_count)
           VALUES ('cog', '3300060358', 'COG0055', 'F-type ATPase', 'C', 12272647.0, 0.812, 55898, 60000)"""
    )
    conn.commit()
    row = conn.execute(
        "SELECT name, category, parent, depth, egc, norm_egc, scaffold_count, gene_count "
        "FROM annotation_series WHERE source='cog' AND annotation_id='COG0055'"
    ).fetchone()
    assert row == ("F-type ATPase", "C", None, None, 12272647.0, 0.812, 55898, 60000)


def test_round_trip_taxonomy_row_with_parent_and_depth(conn):
    """Taxonomy is the one source that populates parent/depth for real --
    confirms those columns actually round-trip real values, not just
    NULL (real numbers from sample 3300060358's "Bacteria;Bacteroidetes"
    node -- annotation_id is the full lineage-prefix post
    taxonomy_egc_homonym_bug, `name` holds the bare rank label)."""
    conn.execute(
        """INSERT INTO annotation_series
           (source, sample, annotation_id, name, category, parent, depth, egc, norm_egc, scaffold_count, gene_count)
           VALUES ('taxonomy', '3300060358', 'Bacteria;Bacteroidetes', 'Bacteroidetes', 'Bacteria',
                   'Bacteria', 2, 3555560.0, 0.22032252119813275, 55898, 104616)"""
    )
    conn.commit()
    row = conn.execute(
        "SELECT name, category, parent, depth, egc, norm_egc FROM annotation_series WHERE annotation_id='Bacteria;Bacteroidetes'"
    ).fetchone()
    assert row == ("Bacteroidetes", "Bacteria", "Bacteria", 2, 3555560.0, 0.22032252119813275)


def test_ids_autoincrement_and_are_unique(conn):
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'A')")
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'B')")
    conn.commit()
    ids = [r[0] for r in conn.execute("SELECT id FROM annotation_series ORDER BY id")]
    assert len(ids) == len(set(ids)) == 2
    assert ids[1] > ids[0]


# ═══════════════════════════════════════════════════════════════════════════
# scaffolds junction behavior
# ═══════════════════════════════════════════════════════════════════════════

def test_multiple_scaffolds_join_back_to_their_annotation_series(conn):
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'COG0001')")
    series_id = conn.execute("SELECT id FROM annotation_series").fetchone()[0]
    conn.executemany(
        "INSERT INTO scaffolds (annotation_series_id, scaffold_id, gene_count) VALUES (?, ?, ?)",
        [(series_id, "scaffold_A", 2), (series_id, "scaffold_B", 5)],
    )
    conn.commit()

    rows = sorted(conn.execute(
        """SELECT s.scaffold_id, s.gene_count FROM scaffolds s
           JOIN annotation_series a ON a.id = s.annotation_series_id
           WHERE a.annotation_id = 'COG0001'"""
    ).fetchall())
    assert rows == [("scaffold_A", 2), ("scaffold_B", 5)]


def test_scaffolds_for_one_annotation_dont_leak_into_another(conn):
    """Two different annotation_series rows each get their own scaffolds --
    a join must never cross-associate them."""
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'COG0001')")
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('cog', 's1', 'COG0002')")
    id1, id2 = [r[0] for r in conn.execute("SELECT id FROM annotation_series ORDER BY id")]
    conn.execute("INSERT INTO scaffolds (annotation_series_id, scaffold_id, gene_count) VALUES (?, 'scaffold_A', 1)", (id1,))
    conn.execute("INSERT INTO scaffolds (annotation_series_id, scaffold_id, gene_count) VALUES (?, 'scaffold_B', 1)", (id2,))
    conn.commit()

    scaffolds_for_cog1 = [r[0] for r in conn.execute(
        "SELECT scaffold_id FROM scaffolds WHERE annotation_series_id=?", (id1,)
    )]
    assert scaffolds_for_cog1 == ["scaffold_A"]


def test_orphaned_scaffold_row_is_not_rejected_by_default(conn):
    """SQLite does not enforce FOREIGN KEY constraints unless
    'PRAGMA foreign_keys = ON' is set per-connection -- same known gap as
    gene_cog/gene_enzyme in Phase 1 (which is exactly why those tables
    need explicit orphan-scan tests instead of relying on the DB to
    reject bad inserts). This documents the current real behavior: if it
    ever starts raising IntegrityError here, FK enforcement was turned on
    somewhere and the future Phase-1-style orphan-scan test for this table
    may no longer be needed."""
    conn.execute(
        "INSERT INTO scaffolds (annotation_series_id, scaffold_id, gene_count) VALUES (99999, 'ghost', 1)"
    )
    conn.commit()
    row = conn.execute("SELECT scaffold_id FROM scaffolds WHERE annotation_series_id=99999").fetchone()
    assert row == ("ghost",)


# ═══════════════════════════════════════════════════════════════════════════
# Known, currently-open gap -- documented, not asserted as correct
# ═══════════════════════════════════════════════════════════════════════════

def test_source_column_has_no_check_constraint_yet(conn):
    """Documents a real, currently-open gap rather than a requirement:
    nothing in the schema stops an invalid source value like 'bogus' from
    being inserted -- there's no CHECK(source IN (...)). Flagged so this is
    a visible, deliberate gap instead of a silent assumption; worth
    revisiting once the per-source migration scripts exist (either add a
    CHECK constraint, or rely on those scripts being the only writers and
    always using one of the 4 real source strings)."""
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id) VALUES ('bogus', 's1', 'X')")
    conn.commit()
    row = conn.execute("SELECT source FROM annotation_series WHERE annotation_id='X'").fetchone()
    assert row == ("bogus",)
