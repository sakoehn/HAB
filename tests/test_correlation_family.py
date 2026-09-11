"""
Tests for family enumeration + exclusion rules (Tier 2 of the correlation
cache -- see the correlation-cache design memory for the full picture).

get_family_candidates(conn, ref_catalog_id, target_source) doesn't exist yet
-- these are written test-first and are expected to fail on import until
it's added to api/correlation_sql.py.

Uses an isolated in-memory sqlite db per test (not the real 47GB db) so each
test can set up its own small, known annotation_catalog fixture -- family
enumeration and exclusion rules are about *relationships* between rows, which
is much easier to pin down with synthetic data than to go hunting for real
examples in production data.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.correlation_sql import get_family_candidates  # noqa: E402  (import after sys.path fix)

SCHEMA = """
CREATE TABLE annotation_catalog(
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    annotation_id TEXT NOT NULL,
    name TEXT,
    parent TEXT,
    depth INTEGER,
    UNIQUE (source, annotation_id)
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.execute(SCHEMA)
    yield connection
    connection.close()


def insert(conn, id, source, annotation_id, parent=None, depth=None, name=None):
    conn.execute(
        "INSERT INTO annotation_catalog (id, source, annotation_id, name, parent, depth) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (id, source, annotation_id, name or annotation_id, parent, depth),
    )
    conn.commit()


# ── Section 1: basic enumeration (item #1) ─────────────────────────────────

class TestFamilyEnumeration:
    def test_cross_source_returns_all_candidates(self, conn):
        insert(conn, 1, "taxonomy", "Bacteria")
        insert(conn, 2, "kegg", "K00001")
        insert(conn, 3, "kegg", "K00002")
        insert(conn, 4, "kegg", "K00003")

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="kegg")

        assert {c["id"] for c in family} == {2, 3, 4}

    def test_ref_excluded_from_its_own_same_source_family(self, conn):
        insert(conn, 1, "cog", "C")
        insert(conn, 2, "cog", "D")
        insert(conn, 3, "cog", "E")

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="cog")

        assert 1 not in {c["id"] for c in family}
        assert {c["id"] for c in family} == {2, 3}

    def test_empty_target_source_returns_empty_list(self, conn):
        insert(conn, 1, "taxonomy", "Bacteria")
        # no enzyme rows at all

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="enzyme")

        assert family == []


# ── Section 2: exclusion rules (item #2 -- included now since it shares the
#    same fixture shape, but treat this section as "not yet" until item #1
#    is green) ────────────────────────────────────────────────────────────

class TestExclusionRules:
    def test_cog_has_no_exclusions_even_same_source(self, conn):
        # cog is flat -- no parent field means nothing can be a sibling/
        # ancestor/descendant of anything else.
        insert(conn, 1, "cog", "C")
        insert(conn, 2, "cog", "D")
        insert(conn, 3, "cog", "E")

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="cog")

        assert {c["id"] for c in family} == {2, 3}

    def test_cross_source_never_excludes_even_if_names_overlap(self, conn):
        # Same annotation_id string can legitimately exist in two sources;
        # cross-source pairs are never excluded regardless of any apparent
        # relationship.
        insert(conn, 1, "taxonomy", "Bosea", parent="Bacteria;Proteobacteria;Rhizobiaceae", depth=4)
        insert(conn, 2, "kegg", "Bosea")  # coincidental name collision

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="kegg")

        assert {c["id"] for c in family} == {2}

    def test_taxonomy_siblings_excluded(self, conn):
        # Two genera sharing the exact same direct parent.
        insert(conn, 1, "taxonomy", "Bacteria;Proteobacteria;Rhizobiaceae;Bosea",
               parent="Bacteria;Proteobacteria;Rhizobiaceae", depth=4)
        insert(conn, 2, "taxonomy", "Bacteria;Proteobacteria;Rhizobiaceae;OtherGenus",
               parent="Bacteria;Proteobacteria;Rhizobiaceae", depth=4)

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="taxonomy")

        assert 2 not in {c["id"] for c in family}

    def test_taxonomy_ancestors_and_descendants_excluded_at_any_depth(self, conn):
        insert(conn, 1, "taxonomy", "Bacteria", depth=1)
        insert(conn, 2, "taxonomy", "Bacteria;Proteobacteria", parent="Bacteria", depth=2)
        insert(conn, 3, "taxonomy", "Bacteria;Proteobacteria;Rhizobiaceae",
               parent="Bacteria;Proteobacteria", depth=3)
        insert(conn, 4, "taxonomy", "Bacteria;Proteobacteria;Rhizobiaceae;Bosea",
               parent="Bacteria;Proteobacteria;Rhizobiaceae", depth=4)  # ref
        insert(conn, 5, "taxonomy", "Bacteria;Proteobacteria;Rhizobiaceae;Bosea;species1",
               parent="Bacteria;Proteobacteria;Rhizobiaceae;Bosea", depth=5)

        family = get_family_candidates(conn, ref_catalog_id=4, target_source="taxonomy")
        excluded_or_ref = {1, 2, 3, 4, 5} - {c["id"] for c in family}

        # domain root (1), phylum (2), and direct parent (3) are all
        # ancestors regardless of depth; the species below Bosea (5) is a
        # descendant; ref (4) excludes itself.
        assert excluded_or_ref == {1, 2, 3, 4, 5}

    def test_taxonomy_cousins_not_excluded(self, conn):
        # Two genera under different families that only share a distant
        # common ancestor (the phylum) -- NOT siblings, NOT ancestor/
        # descendant of each other, so must stay in the family.
        insert(conn, 1, "taxonomy", "Bacteria;Proteobacteria;Rhizobiaceae;Bosea",
               parent="Bacteria;Proteobacteria;Rhizobiaceae", depth=4)  # ref
        insert(conn, 2, "taxonomy", "Bacteria;Proteobacteria;OtherFamily;CousinGenus",
               parent="Bacteria;Proteobacteria;OtherFamily", depth=4)
        insert(conn, 3, "taxonomy", "Bacteria;Proteobacteria;OtherFamily",
               parent="Bacteria;Proteobacteria", depth=3)

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="taxonomy")

        assert {c["id"] for c in family} == {2, 3}

    def test_kegg_hierarchy_siblings_and_ancestors_excluded(self, conn):
        # kegg/enzyme don't store a full lineage string like taxonomy --
        # just a single `parent` pointer to another row's annotation_id --
        # so ancestor/descendant exclusion has to walk that chain.
        insert(conn, 10, "kegg", "K00001", parent=None, depth=1)               # grandparent
        insert(conn, 11, "kegg", "K00002", parent="K00001", depth=2)           # ref (parent)
        insert(conn, 12, "kegg", "K00003", parent="K00002", depth=3)           # child of ref
        insert(conn, 13, "kegg", "K00004", parent="K00001", depth=2)           # sibling of ref
        insert(conn, 15, "kegg", "K00005", parent=None, depth=1)               # unrelated root
        insert(conn, 14, "kegg", "K00006", parent="K00005", depth=2)           # cousin

        family = get_family_candidates(conn, ref_catalog_id=11, target_source="kegg")

        assert {c["id"] for c in family} == {14, 15}
