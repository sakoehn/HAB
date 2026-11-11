"""
test_migrate_annotations.py
==============================
Tests for build_annotation_series_row() in
FastAPI/scripts/migrate_annotations_to_sql.py -- the pure transform from
one (sample, annotation_id, entry) triple out of a source JSON into a flat
dict matching annotation_series' columns.

Data-layer test: no database, no server, no real files -- just the
transform function in isolation, same spirit as test_taxon_paths.py
testing parse_taxon_path().

Run:
    pytest tests/sql/test_migrate_annotations.py -v
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from scripts.migrate_annotations_to_sql import build_annotation_series_row


# Real COG leaf entry, sample 3300060358, DataStructures/COG/3300060358.cog.json.
# Registered at both its own COG id (depth=2, this entry) and its category
# letter (depth=1, COG_CATEGORY_ENTRY below). `category` holds the real
# descriptive text, never the bare letter -- but `parent` DOES hold parent_id
# ("C"), not parent_name, same as KEGG/Enzyme (see
# test_kegg_and_enzyme_do_not_store_parent_name).
COG_ENTRY = {
    "name": "FoF1-type ATP synthase, beta subunit",
    "category": "Energy production and conversion",
    "depth": 2,
    "parent_id": "C",
    "parent_name": "Energy production and conversion",
    "egc": 7092.0,
    "norm_egc": 0.00043946025951950113,
    "scaffolds": {
        "Ga0590986_0000001": 1,
        "Ga0590986_0000003": 1,
        "Ga0590986_0000170": 1,
    },
}

# Real COG category (depth=1) entry, same sample, key "C" in the same file --
# COG's hierarchy root, same role as taxonomy's domain root
# (TAXONOMY_ROOT_ENTRY below): parent_id/parent_name are both None since
# nothing is above a category letter.
COG_CATEGORY_ENTRY = {
    "name": "Energy production and conversion",
    "category": "Energy production and conversion",
    "depth": 1,
    "parent_id": None,
    "parent_name": None,
    "egc": 670876.0,
    "norm_egc": 0.041571255085364474,
    "scaffolds": {"Ga0590986_0000001": 15},
}

# Real Taxonomy entry, sample 3300060358, DataStructures/Taxonomy/3300060358.tax.json,
# keyed "Bacteria;Bacteroidetes" (full-lineage keying). Taxonomy entries
# carry a "name" field (the bare rank label) alongside the lineage-prefix key.
TAXONOMY_ENTRY = {
    "name": "Bacteroidetes",
    "depth": 2,
    "category": "Bacteria",
    "parent": "Bacteria",
    "egc": 3555560.0,
    "norm_egc": 0.22032252119813275,
    "scaffolds": {
        "scaffold_a": 5,
        "scaffold_b": 2,
    },
}

# Real Taxonomy ROOT entry (sample 3300060358, "Bacteria" itself) -- "parent"
# key IS present but explicitly None, must not be confused with "missing".
TAXONOMY_ROOT_ENTRY = {
    "name": "Bacteria",
    "depth": 1,
    "category": "Bacteria",
    "parent": None,
    "egc": 13121942.0,
    "norm_egc": 0.8131094242413764,
    "scaffolds": {"scaffold_a": 1},
}

# Real KEGG entry, sample 3300060358, DataStructures/Kegg/3300060358.ko.json --
# uses parent_id/parent_name, not a single "parent" field like Taxonomy.
KEGG_ENTRY = {
    "name": "sufB; Fe-S cluster assembly protein SufB",
    "category": "Not Included in Pathway or Brite",
    "depth": 4,
    "parent_id": "99996",
    "parent_name": "General function prediction only",
    "egc": 4067.0,
    "norm_egc": 0.00048112737359227065,
    "scaffolds": {"scaffold_a": 1, "scaffold_b": 1},
}

# Real Enzyme entry, sample 3300060358, DataStructures/Enzyme/3300060358.enzyme.json --
# same parent_id/parent_name shape as KEGG.
ENZYME_ENTRY = {
    "name": "dUTP diphosphatase",
    "category": "Hydrolases",
    "depth": 4,
    "parent_id": "3.6.1",
    "parent_name": "In phosphorus-containing anhydrides",
    "egc": 3985.0,
    "norm_egc": 0.0007087560451021401,
    "scaffolds": {"scaffold_a": 1},
}


def test_cog_leaf_row_carries_depth_and_parent_from_parent_id():
    """A COG leaf row (COG#### id) carries depth and parent -- parent
    falls back to parent_id ("C") exactly like
    KEGG/Enzyme, parent_name ("Energy production and conversion") is
    dropped the same way theirs is."""
    row = build_annotation_series_row("cog", "3300060358", "COG0055", COG_ENTRY)
    assert row["parent"] == "C"
    assert row["depth"] == 2


def test_cog_category_row_has_null_parent_but_real_depth():
    """The category-letter row itself (depth=1) is COG's hierarchy root --
    null parent (nothing above it), same shape as taxonomy's domain root
    (test_taxonomy_root_node_parent_is_explicitly_none_not_missing) --
    but depth IS populated (1, not NULL), unlike the old flat-COG
    assumption where both were always null."""
    row = build_annotation_series_row("cog", "3300060358", "C", COG_CATEGORY_ENTRY)
    assert row["parent"] is None
    assert row["depth"] == 1
    assert row["name"] == "Energy production and conversion"


def test_cog_row_carries_over_name_category_egc_norm_egc():
    row = build_annotation_series_row("cog", "3300060358", "COG0055", COG_ENTRY)
    assert row["source"] == "cog"
    assert row["sample"] == "3300060358"
    assert row["annotation_id"] == "COG0055"
    assert row["name"] == "FoF1-type ATP synthase, beta subunit"
    assert row["category"] == "Energy production and conversion"
    assert row["egc"] == 7092.0
    assert row["norm_egc"] == 0.00043946025951950113


def test_cog_row_derives_scaffold_count_and_gene_count():
    """scaffold_count = number of distinct scaffolds; gene_count = sum of
    their individual counts -- must be derived from the actual scaffolds
    dict, not trusted from a precomputed field that may not exist on
    every source."""
    row = build_annotation_series_row("cog", "3300060358", "COG0055", COG_ENTRY)
    assert row["scaffold_count"] == 3
    assert row["gene_count"] == 3  # 1 + 1 + 1


def test_taxonomy_row_carries_parent_and_depth():
    row = build_annotation_series_row("taxonomy", "3300060358", "Bacteria;Bacteroidetes", TAXONOMY_ENTRY)
    assert row["parent"] == "Bacteria"
    assert row["depth"] == 2
    assert row["category"] == "Bacteria"


def test_taxonomy_row_derives_scaffold_count_and_gene_count():
    row = build_annotation_series_row("taxonomy", "3300060358", "Bacteria;Bacteroidetes", TAXONOMY_ENTRY)
    assert row["scaffold_count"] == 2
    assert row["gene_count"] == 7  # 5 + 2


def test_entry_with_no_scaffolds_yields_zero_counts_not_a_crash():
    """A real, legitimate case -- an annotation with zero real scaffold
    hits recorded (e.g. entry["scaffolds"] is {} or missing entirely)
    must not raise, and must produce 0, not None."""
    entry = {"name": "x", "category": "X", "egc": 0.0, "norm_egc": 0.0, "scaffolds": {}}
    row = build_annotation_series_row("cog", "s1", "COGXXXX", entry)
    assert row["scaffold_count"] == 0
    assert row["gene_count"] == 0


def test_row_has_no_id_key():
    """id is assigned by SQLite on insert -- the transform must not
    invent one."""
    row = build_annotation_series_row("cog", "3300060358", "COG0055", COG_ENTRY)
    assert "id" not in row


# ═══════════════════════════════════════════════════════════════════════════
# Taxonomy's "name" field (annotation_id is the lineage-prefix, e.g.
# "Bacteria;Bacteroidetes", so a separate bare-label "name" field is
# required for display)
# ═══════════════════════════════════════════════════════════════════════════

def test_taxonomy_row_uses_its_own_name_field():
    """Taxonomy entries now carry a real "name" field (the bare rank
    label) distinct from annotation_id (the full lineage-prefix) -- the
    row's name must come from entry["name"], not be derived from the
    lineage-prefix id."""
    row = build_annotation_series_row("taxonomy", "3300060358", "Bacteria;Bacteroidetes", TAXONOMY_ENTRY)
    assert row["name"] == "Bacteroidetes"
    assert row["name"] == TAXONOMY_ENTRY["name"]


def test_taxonomy_row_name_falls_back_to_annotation_id_if_name_missing():
    """Defensive coverage for the fallback branch itself
    (entry.get("name", annotation_id)): if an entry somehow lacked "name"
    (the pre-fix raw format, or a future source), the row must still get
    a usable name instead of silently going NULL."""
    entry_without_name = {k: v for k, v in TAXONOMY_ENTRY.items() if k != "name"}
    row = build_annotation_series_row("taxonomy", "3300060358", "Bacteria;Bacteroidetes", entry_without_name)
    assert row["name"] == "Bacteria;Bacteroidetes"


def test_taxonomy_root_node_parent_is_explicitly_none_not_missing():
    """The root node's "parent" key IS present, just set to None -- must
    stay None, not be confused with a missing key that would otherwise
    fall back to parent_id (which doesn't exist on taxonomy entries
    anyway, but the fallback logic must get this right regardless)."""
    row = build_annotation_series_row("taxonomy", "3300060358", "Bacteria", TAXONOMY_ROOT_ENTRY)
    assert row["parent"] is None
    assert row["name"] == "Bacteria"
    assert row["depth"] == 1


# ═══════════════════════════════════════════════════════════════════════════
# KEGG / Enzyme: parent_id + parent_name instead of Taxonomy's single "parent"
# ═══════════════════════════════════════════════════════════════════════════

def test_kegg_row_parent_falls_back_to_parent_id():
    """parent must be parent_id ("99996"), not
    parent_name ("General function prediction only") -- parent_id is what
    matches another row's own annotation_id, which the correlation
    family-exclusion tree-walk and the frontend's expandParentLabel() both
    depend on. Storing the display name instead silently broke both."""
    row = build_annotation_series_row("kegg", "3300060358", "K09014", KEGG_ENTRY)
    assert row["parent"] == "99996"
    assert row["name"] == "sufB; Fe-S cluster assembly protein SufB"
    assert row["category"] == "Not Included in Pathway or Brite"


def test_kegg_row_depth_is_kept_even_though_its_not_a_taxonomic_rank():
    """KEGG's depth means "pathway hierarchy depth", not taxonomic rank --
    still stored as-is (the column's meaning is source-specific, enforced
    by callers/readers, not by this transform)."""
    row = build_annotation_series_row("kegg", "3300060358", "K09014", KEGG_ENTRY)
    assert row["depth"] == 4


def test_enzyme_row_parent_falls_back_to_parent_id():
    """Same as KEGG: parent must be parent_id ("3.6.1"), not
    parent_name ("In phosphorus-containing anhydrides")."""
    row = build_annotation_series_row("enzyme", "3300060358", "3.6.1.23", ENZYME_ENTRY)
    assert row["parent"] == "3.6.1"
    assert row["name"] == "dUTP diphosphatase"
    assert row["category"] == "Hydrolases"


def test_kegg_and_enzyme_do_not_store_parent_name():
    """parent_name (e.g. KEGG's "General function prediction only",
    Enzyme's "In phosphorus-containing anhydrides") has no column of its
    own -- a deliberate, documented gap (display code re-derives it from
    parent_id per source instead), not an oversight. Confirms the real
    parent_name VALUE isn't silently leaking into some other field (like
    `parent`, which should only ever hold parent_id)."""
    kegg_row = build_annotation_series_row("kegg", "3300060358", "K09014", KEGG_ENTRY)
    enzyme_row = build_annotation_series_row("enzyme", "3300060358", "3.6.1.23", ENZYME_ENTRY)
    assert KEGG_ENTRY["parent_name"] not in kegg_row.values()
    assert ENZYME_ENTRY["parent_name"] not in enzyme_row.values()
    # And parent_id DOES now show up, specifically as `parent`.
    assert kegg_row["parent"] == KEGG_ENTRY["parent_id"]
    assert enzyme_row["parent"] == ENZYME_ENTRY["parent_id"]


# A file in the source folder whose name is not a real sample (a stray
# copy, a test file) must stop the load, not become an extra sample.
def test_a_file_that_is_not_a_known_sample_stops_the_load(tmp_path):
    import pytest
    from scripts.migrate_annotations_to_sql import check_samples_are_known
    (tmp_path / "3300060358.cog.json").write_text("{}")
    (tmp_path / "3300060358 (1).cog.json").write_text("{}")
    with pytest.raises(SystemExit) as exc:
        check_samples_are_known([("3300060358", "a"), ("3300060358 (1)", "b")])
    assert "3300060358 (1)" in str(exc.value)
    check_samples_are_known([("3300060358", "a")])
