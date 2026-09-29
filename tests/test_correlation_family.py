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

CREATE TABLE kegg_paths(
    id INTEGER PRIMARY KEY,
    a_id TEXT, a_name TEXT,
    b_id TEXT, b_name TEXT,
    c_id TEXT, c_name TEXT,
    d_id TEXT, d_name TEXT,
    full_path TEXT NOT NULL UNIQUE
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    yield connection
    connection.close()


def insert(conn, id, source, annotation_id, parent=None, depth=None, name=None):
    conn.execute(
        "INSERT INTO annotation_catalog (id, source, annotation_id, name, parent, depth) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (id, source, annotation_id, name or annotation_id, parent, depth),
    )
    conn.commit()


def insert_kegg_path(conn, a_id=None, b_id=None, c_id=None, d_id=None):
    """One real occurrence-path row for kegg_paths -- CR3's fix
    (_kegg_family_exclusions in correlation_sql.py) reads this table
    instead of annotation_catalog.parent for same-source kegg families,
    since a KEGG node can have multiple real parents (annotation_catalog's
    single `parent` column can't represent that -- see E14/CR3)."""
    full_path = "|".join(v for v in (a_id, b_id, c_id, d_id) if v is not None)
    conn.execute(
        "INSERT INTO kegg_paths (a_id, b_id, c_id, d_id, full_path) VALUES (?, ?, ?, ?, ?)",
        (a_id, b_id, c_id, d_id, full_path),
    )
    conn.commit()


# ── Section 1: basic enumeration (item #1) ─────────────────────────────────

class TestFamilyEnumeration:
    def test_cross_source_returns_all_candidates(self, conn):
        insert(conn, 1, "taxonomy", "Bacteria")
        insert(conn, 2, "kegg", "K00001", name="Nitrogenase")
        insert(conn, 3, "kegg", "K00002")
        insert(conn, 4, "kegg", "K00003")

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="kegg")

        assert {c["id"]: c["name"] for c in family}[2] == "Nitrogenase"

        assert {c["id"] for c in family} == {2, 3, 4}

    def test_ref_excluded_from_its_own_same_source_family(self, conn):
        # Distinct parents -- post-CR3, cog participates in the same
        # sibling-exclusion rule as every other source (see
        # TestExclusionRules.test_cog_hierarchy_siblings_and_ancestors_excluded
        # for that specific behavior); giving these three different
        # parents keeps this test focused on plain self-exclusion only.
        insert(conn, 1, "cog", "COG0001", parent="C")
        insert(conn, 2, "cog", "COG0002", parent="D")
        insert(conn, 3, "cog", "COG0003", parent="E")

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
    def test_cog_hierarchy_siblings_and_ancestors_excluded(self, conn):
        # CR3 (docs/AUDIT.md): cog used to be exempted from exclusions
        # entirely, back when it really was flat with no parent field at
        # all. Post-E15, cog has a real 2-level hierarchy (category ->
        # specific COG id) and now participates in the same exclusion
        # walk as every other source -- no more special-cased pass-through.
        insert(conn, 1, "cog", "C", parent=None, depth=1)       # category (ancestor of ref)
        insert(conn, 2, "cog", "COG0055", parent="C", depth=2)  # ref
        insert(conn, 3, "cog", "COG1028", parent="C", depth=2)  # sibling (same category)
        insert(conn, 4, "cog", "D", parent=None, depth=1)       # unrelated category
        insert(conn, 5, "cog", "COG9999", parent="D", depth=2)  # cousin (different category)

        family = get_family_candidates(conn, ref_catalog_id=2, target_source="cog")

        assert {c["id"] for c in family} == {4, 5}

    def test_cog_category_ref_excludes_its_own_members_and_sibling_categories(self, conn):
        # The more consequential direction for cog, not covered above: a
        # category's EGC is literally the sum of its own members' EGC, so
        # "category correlates with its own member" is exactly the
        # containment artifact CR3 exists to prevent -- for EVERY cog
        # category, with no exceptions, since cog is always exactly 2
        # levels. Descendant exclusion has to reach down from a
        # category-level ref, not just work in the leaf-as-ref direction
        # the test above covers.
        insert(conn, 1, "cog", "C", parent=None, depth=1)       # ref (category)
        insert(conn, 2, "cog", "COG0055", parent="C", depth=2)  # member (descendant of ref)
        insert(conn, 3, "cog", "COG1028", parent="C", depth=2)  # member (descendant of ref)
        insert(conn, 4, "cog", "D", parent=None, depth=1)       # sibling category (shares NULL parent)
        insert(conn, 5, "cog", "COG9999", parent="D", depth=2)  # unrelated leaf, different category

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="cog")

        assert {c["id"] for c in family} == {5}

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
        # Single-real-parent case (the common one) -- CR3's kegg_paths-based
        # walk (_kegg_family_exclusions) must still get this right, not
        # just the new multi-parent case below. Reads kegg_paths, not
        # annotation_catalog.parent, for kegg same-source families -- the
        # `insert(...)` rows below deliberately don't even set `parent`.
        insert(conn, 10, "kegg", "A1", depth=1)  # grandparent
        insert(conn, 11, "kegg", "B1", depth=2)  # ref (parent)
        insert(conn, 12, "kegg", "C1", depth=3)  # child of ref
        insert(conn, 13, "kegg", "B2", depth=2)  # sibling of ref
        insert(conn, 15, "kegg", "A2", depth=1)  # unrelated root
        insert(conn, 14, "kegg", "B3", depth=2)  # cousin

        insert_kegg_path(conn, a_id="A1", b_id="B1", c_id="C1")
        insert_kegg_path(conn, a_id="A1", b_id="B2")
        insert_kegg_path(conn, a_id="A2", b_id="B3")

        family = get_family_candidates(conn, ref_catalog_id=11, target_source="kegg")

        assert {c["id"] for c in family} == {14, 15}

    def test_kegg_multi_parent_ko_excluded_from_every_real_parents_family(self, conn):
        # CR3's actual fix target: annotation_catalog.parent can only ever
        # hold ONE of a multi-parent KO's real parents (E14 confirmed KOs
        # like hexokinase have up to 14), but kegg_paths records every
        # real occurrence. A KO genuinely belonging to two different
        # pathways must be excluded from BOTH pathways' families, not just
        # whichever one its single recorded parent happened to be.
        insert(conn, 20, "kegg", "P1", depth=3)          # pathway 1
        insert(conn, 21, "kegg", "P2", depth=3)          # pathway 2 -- unrelated to P1
        insert(conn, 22, "kegg", "KMulti", depth=4)      # real member of BOTH P1 and P2
        insert(conn, 23, "kegg", "KOnlyP1", depth=4)     # real member of only P1
        insert(conn, 24, "kegg", "KUnrelated", depth=4)  # real member of neither

        insert_kegg_path(conn, a_id="A", b_id="B", c_id="P1", d_id="KMulti")
        insert_kegg_path(conn, a_id="A", b_id="B", c_id="P2", d_id="KMulti")  # same KO, 2nd real parent
        insert_kegg_path(conn, a_id="A", b_id="B", c_id="P1", d_id="KOnlyP1")
        insert_kegg_path(conn, a_id="A", b_id="B", c_id="P3", d_id="KUnrelated")

        family_p1_ids = {c["id"] for c in get_family_candidates(conn, ref_catalog_id=20, target_source="kegg")}
        assert 22 not in family_p1_ids  # KMulti excluded from P1's family
        assert 23 not in family_p1_ids  # KOnlyP1 excluded too (regular single-parent case)
        assert 24 in family_p1_ids      # KUnrelated stays -- real member of neither

        family_p2_ids = {c["id"] for c in get_family_candidates(conn, ref_catalog_id=21, target_source="kegg")}
        assert 22 not in family_p2_ids  # KMulti excluded from P2's family too -- the actual bug this fixes

    def test_kegg_multi_parent_ko_as_ref_excludes_all_its_real_parents(self, conn):
        # The reverse direction: when the multi-parent KO itself is ref,
        # ALL of its real ancestors must be excluded, not just one.
        insert(conn, 20, "kegg", "P1", depth=3)
        insert(conn, 21, "kegg", "P2", depth=3)
        insert(conn, 22, "kegg", "KMulti", depth=4)  # ref -- real member of both P1 and P2

        insert_kegg_path(conn, a_id="A", b_id="B", c_id="P1", d_id="KMulti")
        insert_kegg_path(conn, a_id="A", b_id="B", c_id="P2", d_id="KMulti")

        family_ids = {c["id"] for c in get_family_candidates(conn, ref_catalog_id=22, target_source="kegg")}
        assert 20 not in family_ids  # P1 excluded (a real ancestor)
        assert 21 not in family_ids  # P2 excluded too -- its OTHER real ancestor

    def test_kegg_unknown_ref_id_returns_self_exclusion_only_not_a_crash(self, conn):
        # ref exists in annotation_catalog but was never real enough to
        # make it into kegg_paths (e.g. filtered out at migration time) --
        # _kegg_node_depth returns None; must degrade to self-exclusion
        # only, not raise.
        insert(conn, 30, "kegg", "GhostId", depth=2)
        insert(conn, 31, "kegg", "Real", depth=2)
        insert_kegg_path(conn, a_id="A", b_id="Real")

        family_ids = {c["id"] for c in get_family_candidates(conn, ref_catalog_id=30, target_source="kegg")}
        assert 30 not in family_ids  # ref always excludes itself
        assert 31 in family_ids      # no real relationship data -- nothing else excluded


class TestTaxonomyDepthCutoff:
    # Found via live testing: taxonomy has ~60k annotations, ~89% of them
    # species/strain (depth 7-8). Scoring a family against all of them took
    # up to ~83 minutes cold. Capped candidates at genus-and-coarser
    # (depth <= TAXONOMY_DEPTH_CUTOFF, currently 6) -- same cutoff the old
    # abandoned all-pairs batch job used for the identical reason.

    def test_species_and_strain_excluded_from_taxonomy_candidates(self, conn):
        insert(conn, 1, "kegg", "K00001")  # ref, cross-source query
        insert(conn, 2, "taxonomy", "Bacteria;Proteobacteria;Rhizobiaceae;Bosea", depth=6)          # genus
        insert(conn, 3, "taxonomy", "Bacteria;Proteobacteria;Rhizobiaceae;Bosea;sp1", depth=7)       # species
        insert(conn, 4, "taxonomy", "Bacteria;Proteobacteria;Rhizobiaceae;Bosea;sp1;strain1", depth=8)  # strain

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="taxonomy")

        assert {c["id"] for c in family} == {2}  # only the genus-level entry survives

    def test_genus_and_coarser_all_included(self, conn):
        insert(conn, 1, "kegg", "K00001")  # ref, cross-source query
        insert(conn, 2, "taxonomy", "Bacteria", depth=1)
        insert(conn, 3, "taxonomy", "Bacteria;Proteobacteria", depth=2)
        insert(conn, 4, "taxonomy", "Bacteria;Proteobacteria;C", depth=3)
        insert(conn, 5, "taxonomy", "Bacteria;Proteobacteria;C;O", depth=4)
        insert(conn, 6, "taxonomy", "Bacteria;Proteobacteria;C;O;F", depth=5)
        insert(conn, 7, "taxonomy", "Bacteria;Proteobacteria;C;O;F;G", depth=6)  # genus, still included

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="taxonomy")

        assert {c["id"] for c in family} == {2, 3, 4, 5, 6, 7}

    def test_cutoff_does_not_affect_non_taxonomy_targets(self, conn):
        insert(conn, 1, "taxonomy", "Bacteria", depth=1)
        insert(conn, 2, "kegg", "K00001")
        insert(conn, 3, "kegg", "K00002")

        family = get_family_candidates(conn, ref_catalog_id=1, target_source="kegg")

        assert {c["id"] for c in family} == {2, 3}


class TestCR9StrainSelfCorrelation:
    # CR9 (docs/AUDIT-2026-09-22.md): the ancestor walk in
    # get_family_candidates keys off `by_id`, which is built only from
    # target_rows -- itself already capped at depth <= TAXONOMY_DEPTH_CUTOFF
    # (see TestTaxonomyDepthCutoff above). For a STRAIN reference (depth 8),
    # ref_parent is the species (depth 7) -- one level past the cutoff, so
    # it's not a key in by_id and the walk stops on its very first lookup.
    # Every real ancestor from genus (depth 6) up through domain (depth 1)
    # then stays unexcluded, despite each one genuinely containing every
    # gene the strain has. Confirmed live against the real local database
    # before writing this fix: a real depth-8 strain reference leaked
    # exactly 6 real ancestors (depths 1-6) as "significant correlates" of
    # itself.
    #
    # A SPECIES reference (depth 7) doesn't hit this bug under the old code
    # -- ref_parent is the genus (depth 6), which *is* in by_id, so the walk
    # continues correctly all the way to domain. Both cases are covered here
    # since the fix replaces the whole ancestor-computation mechanism for
    # taxonomy (a direct ';'-prefix check against ref_annotation_id, not a
    # walk through the depth-truncated by_id map), not just the strain path.

    def test_strain_reference_excludes_every_real_ancestor_past_the_depth_cutoff(self, conn):
        insert(conn, 1, "taxonomy", "D", depth=1)                                                            # domain
        insert(conn, 2, "taxonomy", "D;P", parent="D", depth=2)                                              # phylum
        insert(conn, 3, "taxonomy", "D;P;C", parent="D;P", depth=3)                                          # class
        insert(conn, 4, "taxonomy", "D;P;C;O", parent="D;P;C", depth=4)                                      # order
        insert(conn, 5, "taxonomy", "D;P;C;O;F", parent="D;P;C;O", depth=5)                                  # family
        insert(conn, 6, "taxonomy", "D;P;C;O;F;G", parent="D;P;C;O;F", depth=6)                              # genus -- real ancestor, past every by_id lookup a strain ref can reach
        insert(conn, 7, "taxonomy", "D;P;C;O;F;G;S", parent="D;P;C;O;F;G", depth=7)                          # species -- not a candidate itself (depth > cutoff), but this is the ref_parent that breaks the old by_id walk
        insert(conn, 8, "taxonomy", "D;P;C;O;F;G;S;strain1", parent="D;P;C;O;F;G;S", depth=8)                # ref
        insert(conn, 9, "taxonomy", "D;P;C;O;F;G2", parent="D;P;C;O;F", depth=6)                             # unrelated cousin genus -- real negative control, must stay included

        family = get_family_candidates(conn, ref_catalog_id=8, target_source="taxonomy")

        assert {c["id"] for c in family} == {9}

    def test_species_reference_also_excludes_every_real_ancestor(self, conn):
        insert(conn, 1, "taxonomy", "D", depth=1)
        insert(conn, 2, "taxonomy", "D;P", parent="D", depth=2)
        insert(conn, 3, "taxonomy", "D;P;C", parent="D;P", depth=3)
        insert(conn, 4, "taxonomy", "D;P;C;O", parent="D;P;C", depth=4)
        insert(conn, 5, "taxonomy", "D;P;C;O;F", parent="D;P;C;O", depth=5)
        insert(conn, 6, "taxonomy", "D;P;C;O;F;G", parent="D;P;C;O;F", depth=6)      # genus
        insert(conn, 7, "taxonomy", "D;P;C;O;F;G;S", parent="D;P;C;O;F;G", depth=7)  # ref (species)
        insert(conn, 8, "taxonomy", "D;P;C;O;F;G2", parent="D;P;C;O;F", depth=6)     # unrelated cousin genus

        family = get_family_candidates(conn, ref_catalog_id=7, target_source="taxonomy")

        assert {c["id"] for c in family} == {8}
