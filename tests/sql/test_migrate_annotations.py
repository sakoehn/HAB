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

Import target doesn't exist yet. Write build_annotation_series_row() in
FastAPI/scripts/migrate_annotations_to_sql.py to make this pass.

Run:
    pytest tests/sql/test_migrate_annotations.py -v
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from scripts.migrate_annotations_to_sql import build_annotation_series_row


# Real COG entry, sample 3300060358, DataStructures/COG/3300060358.cog.json
COG_ENTRY = {
    "name": "FoF1-type ATP synthase, beta subunit",
    "category": "C",
    "egc": 7092.0,
    "norm_egc": 0.0005778704463674381,
    "scaffolds": {
        "Ga0590986_0000001": 1,
        "Ga0590986_0000003": 1,
        "Ga0590986_0000170": 1,
    },
}

# Real Taxonomy entry, sample 3300060358, DataStructures/Taxonomy/3300060358.tax.json
# Note: NO "name" key -- confirmed absent from the raw file, unlike COG/KEGG/Enzyme.
TAXONOMY_ENTRY = {
    "depth": 2,
    "category": "Bacteria",
    "parent": "Bacteria",
    "egc": 3555560.0,
    "norm_egc": 0.22798534249867464,
    "scaffolds": {
        "scaffold_a": 5,
        "scaffold_b": 2,
    },
}

# Real Taxonomy ROOT entry (sample 3300060358, "Bacteria" itself) -- "parent"
# key IS present but explicitly None, must not be confused with "missing".
TAXONOMY_ROOT_ENTRY = {
    "depth": 1,
    "category": "Bacteria",
    "parent": None,
    "egc": 13121942.0,
    "norm_egc": 0.8413893848276344,
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


def test_cog_row_has_no_parent_or_depth():
    row = build_annotation_series_row("cog", "3300060358", "COG0055", COG_ENTRY)
    assert row["parent"] is None
    assert row["depth"] is None


def test_cog_row_carries_over_name_category_egc_norm_egc():
    row = build_annotation_series_row("cog", "3300060358", "COG0055", COG_ENTRY)
    assert row["source"] == "cog"
    assert row["sample"] == "3300060358"
    assert row["annotation_id"] == "COG0055"
    assert row["name"] == "FoF1-type ATP synthase, beta subunit"
    assert row["category"] == "C"
    assert row["egc"] == 7092.0
    assert row["norm_egc"] == 0.0005778704463674381


def test_cog_row_derives_scaffold_count_and_gene_count():
    """scaffold_count = number of distinct scaffolds; gene_count = sum of
    their individual counts -- must be derived from the actual scaffolds
    dict, not trusted from a precomputed field that may not exist on
    every source."""
    row = build_annotation_series_row("cog", "3300060358", "COG0055", COG_ENTRY)
    assert row["scaffold_count"] == 3
    assert row["gene_count"] == 3  # 1 + 1 + 1


def test_taxonomy_row_carries_parent_and_depth():
    row = build_annotation_series_row("taxonomy", "3300060358", "Bacteroidetes", TAXONOMY_ENTRY)
    assert row["parent"] == "Bacteria"
    assert row["depth"] == 2
    assert row["category"] == "Bacteria"


def test_taxonomy_row_derives_scaffold_count_and_gene_count():
    row = build_annotation_series_row("taxonomy", "3300060358", "Bacteroidetes", TAXONOMY_ENTRY)
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
# Taxonomy's missing "name" key -- real gap, no test previously caught it
# ═══════════════════════════════════════════════════════════════════════════

def test_taxonomy_row_name_falls_back_to_annotation_id():
    """Taxonomy's raw JSON has NO "name" key at all -- annotation_id IS
    the name (e.g. "Bacteroidetes"). Without this fallback, every
    taxonomy row's name would silently be NULL."""
    row = build_annotation_series_row("taxonomy", "3300060358", "Bacteroidetes", TAXONOMY_ENTRY)
    assert row["name"] == "Bacteroidetes"


def test_taxonomy_root_node_parent_is_explicitly_none_not_missing():
    """The root node's "parent" key IS present, just set to None -- must
    stay None, not be confused with a missing key that would otherwise
    fall back to parent_name (which doesn't exist on taxonomy entries
    anyway, but the fallback logic must get this right regardless)."""
    row = build_annotation_series_row("taxonomy", "3300060358", "Bacteria", TAXONOMY_ROOT_ENTRY)
    assert row["parent"] is None
    assert row["name"] == "Bacteria"
    assert row["depth"] == 1


# ═══════════════════════════════════════════════════════════════════════════
# KEGG / Enzyme: parent_id + parent_name instead of Taxonomy's single "parent"
# ═══════════════════════════════════════════════════════════════════════════

def test_kegg_row_parent_falls_back_to_parent_name():
    row = build_annotation_series_row("kegg", "3300060358", "K09014", KEGG_ENTRY)
    assert row["parent"] == "General function prediction only"
    assert row["name"] == "sufB; Fe-S cluster assembly protein SufB"
    assert row["category"] == "Not Included in Pathway or Brite"


def test_kegg_row_depth_is_kept_even_though_its_not_a_taxonomic_rank():
    """KEGG's depth means "pathway hierarchy depth", not taxonomic rank --
    still stored as-is (the column's meaning is source-specific, enforced
    by callers/readers, not by this transform)."""
    row = build_annotation_series_row("kegg", "3300060358", "K09014", KEGG_ENTRY)
    assert row["depth"] == 4


def test_enzyme_row_parent_falls_back_to_parent_name():
    row = build_annotation_series_row("enzyme", "3300060358", "3.6.1.23", ENZYME_ENTRY)
    assert row["parent"] == "In phosphorus-containing anhydrides"
    assert row["name"] == "dUTP diphosphatase"
    assert row["category"] == "Hydrolases"


def test_kegg_and_enzyme_do_not_store_parent_id():
    """parent_id (e.g. KEGG's "99996", Enzyme's "3.6.1") has no column --
    a deliberate, documented gap, not an oversight. Confirms the real
    parent_id VALUE isn't silently leaking into some other field (like
    `parent`, which should only ever hold parent_name)."""
    kegg_row = build_annotation_series_row("kegg", "3300060358", "K09014", KEGG_ENTRY)
    enzyme_row = build_annotation_series_row("enzyme", "3300060358", "3.6.1.23", ENZYME_ENTRY)
    assert KEGG_ENTRY["parent_id"] not in kegg_row.values()
    assert ENZYME_ENTRY["parent_id"] not in enzyme_row.values()
