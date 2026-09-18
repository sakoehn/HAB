"""
test_annotation_trees.py
========================
JSON tree file tests for all annotation types.

Tests the per-sample annotation JSON files in DataStructures/:
  KEGG     : DataStructures/Kegg/<sample>.ko.json       (new format)
  COG      : DataStructures/COG/<sample>.cog.json       (new format)
  Enzyme   : DataStructures/Enzyme/<sample>.enzyme.json  (new format)
  Taxonomy : DataStructures/Taxonomy/<sample>.tax.json   (new format, different schema)

No API, no HTTP — pure JSON file inspection.

All new-format entries share:
  {
    "<id>": {
      "name":        str,          # absent in Taxonomy (taxon name IS the key)
      "depth":       int,
      "category":    str,
      "parent_id":   str|null,     # Taxonomy uses "parent" instead
      "parent_name": str|null,     # absent in Taxonomy
      "egc":         float,
      "norm_egc":    float,
      "scaffolds":   {scaffold_id: gene_count, ...}
    }
  }

EGC is validated against JGI ground-truth for KEGG, COG, and Enzyme.
Taxonomy is excluded from JGI comparison. 

ID format mapping (JGI → JSON key):
  KEGG   : "KO:K00001" → "K00001"   (strip "KO:")
  COG    : "COG0001"   → "COG0001"  (no change)
  Enzyme : "EC:1.1.1.1"→ "1.1.1.1"  (strip "EC:")

Depth conventions:
  KEGG   : 1=A-level … 4=D-level; leaf KO entries are depth=4 (K##### IDs)
  COG    : 1=letter category (C, H …); depth=2 are leaf COG#### entries
  Enzyme : 1–4 matching EC hierarchy; depth=4 are fully-specified X.X.X.X entries

Run:
    pytest tests/test_annotation_trees.py -v
    pytest tests/test_annotation_trees.py -v -k kegg
    pytest tests/test_annotation_trees.py -v -k cog
    pytest tests/test_annotation_trees.py -v -k enzyme
    pytest tests/test_annotation_trees.py -v -k jgi
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Optional

import pytest

from conftest import (
    DATA_ROOT,
    METAGENOME_SAMPLES_DIR,
    egc_within_tolerance,
    EGC_ABS_FLOOR,
    EGC_PCT_TOLERANCE,
    load_sample_annotation_dir,
)

# ── Paths ─────────────────────────────────────────────────────────────────────

KEGG_JSON_DIR     = DATA_ROOT / "DataStructures" / "Kegg"
COG_JSON_DIR      = DATA_ROOT / "DataStructures" / "COG"
ENZYME_JSON_DIR   = DATA_ROOT / "DataStructures" / "Enzyme"
TAXONOMY_JSON_DIR = DATA_ROOT / "DataStructures" / "Taxonomy"
BRITE_FILE        = DATA_ROOT / "DataStructures" / "Kegg" / "ko00001.keg"

EXPECTED_SAMPLES = 128
NORM_TOLERANCE   = 1e-9

# ── Annotation type registries ────────────────────────────────────────────────

# All four types: used for tests that pass for every annotation source.
ALL_TYPES = [
    ("kegg",     KEGG_JSON_DIR,     "*.ko.json"),
    ("cog",      COG_JSON_DIR,      "*.cog.json"),
    ("enzyme",   ENZYME_JSON_DIR,   "*.enzyme.json"),
    ("taxonomy", TAXONOMY_JSON_DIR, "*.tax.json"),
]

# KEGG / COG / Enzyme share the name and parent_id fields.
# Taxonomy intentionally omits both — the taxon name IS the dict key,
# and uses "parent" instead of "parent_id" to avoid redundancy.
FULL_SCHEMA_TYPES = [
    ("kegg",   KEGG_JSON_DIR,   "*.ko.json"),
    ("cog",    COG_JSON_DIR,    "*.cog.json"),
    ("enzyme", ENZYME_JSON_DIR, "*.enzyme.json"),
]

# parent_name is only written by KEGG and Enzyme notebooks.
# COG omits it because for a 2-level hierarchy parent_name == category
# (redundant).  Taxonomy omits it entirely.
PARENT_NAME_TYPES = [
    ("kegg",   KEGG_JSON_DIR,   "*.ko.json"),
    ("enzyme", ENZYME_JSON_DIR, "*.enzyme.json"),
]


# ── Session fixtures ──────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def kegg_by_sample() -> dict[str, dict]:
    """All KEGG .ko.json files as {sample_id: {node_id: entry}}."""
    return load_sample_annotation_dir(KEGG_JSON_DIR, "*.ko.json")


@pytest.fixture(scope="session")
def cog_by_sample() -> dict[str, dict]:
    """All COG .cog.json files as {sample_id: {node_id: entry}}."""
    return load_sample_annotation_dir(COG_JSON_DIR, "*.cog.json")


@pytest.fixture(scope="session")
def enzyme_by_sample() -> dict[str, dict]:
    """All Enzyme .enzyme.json files as {sample_id: {node_id: entry}}."""
    return load_sample_annotation_dir(ENZYME_JSON_DIR, "*.enzyme.json")


@pytest.fixture(scope="session")
def brite_dict() -> dict[str, dict]:
    """Parse ko00001.keg → {node_id: {name, depth, category, parent_id, parent_name}}.

    Deliberately single-parent, last-occurrence-wins (current_at_depth is
    overwritten per node, same as the pre-E14-fix notebook parser) --
    this matches .ko.json's own single-parent DISPLAY metadata fields, which
    are intentionally last-occurrence too. It is NOT a ground-truth
    multi-parent structure and must never be used to assert anything about
    the EGC/scaffold rollup (E14) -- see TestKEGGHierarchyRollup for that."""
    if not BRITE_FILE.exists():
        pytest.skip(f"BRITE file not found: {BRITE_FILE}")

    brite: dict = {}
    current_at_depth: dict = {}

    with BRITE_FILE.open() as f:
        for line in f:
            if not any(line.startswith(c) for c in "ABCDEFGHIJK"):
                continue
            level_char = line[0]
            depth      = ord(level_char) - ord('A') + 1
            rest       = line[1:].strip()
            if not rest:
                continue
            parts = rest.split(None, 1)
            if len(parts) < 2:
                continue
            node_id, name = parts[0], parts[1]
            parent   = current_at_depth.get(depth - 1)
            category = name if depth == 1 else current_at_depth.get(1, {}).get('name')
            current_at_depth[depth] = {'id': node_id, 'name': name}
            for d in list(current_at_depth):
                if d > depth:
                    del current_at_depth[d]
            brite[node_id] = {
                'name':        name,
                'depth':       depth,
                'category':    category,
                'parent_id':   parent['id']   if parent else None,
                'parent_name': parent['name'] if parent else None,
            }
    return brite


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Common structure — all annotation types
# ═══════════════════════════════════════════════════════════════════════════════

class TestNewFormatStructure:
    """
    Structural field checks across all annotation types.

    Fields present in every type:  egc, norm_egc, depth, category, scaffolds.
    Fields absent from Taxonomy:   name, parent_id, parent_name
      → kept as xfail so the gap is documented until Taxonomy is rebuilt.
    """

    # ── Shared fields — all four types ───────────────────────────────────────

    @pytest.mark.parametrize("src,directory,glob", ALL_TYPES, ids=[t[0] for t in ALL_TYPES])
    def test_directory_exists(self, src, directory, glob):
        assert directory.exists(), f"{src} JSON directory not found: {directory}"

    @pytest.mark.parametrize("src,directory,glob", ALL_TYPES, ids=[t[0] for t in ALL_TYPES])
    def test_file_count(self, src, directory, glob):
        if not directory.exists():
            pytest.skip(f"{src} directory missing")
        n = len(list(directory.glob(glob)))
        assert n >= EXPECTED_SAMPLES, f"{src}: expected ≥{EXPECTED_SAMPLES} files, found {n}"

    @pytest.mark.parametrize("src,directory,glob", ALL_TYPES, ids=[t[0] for t in ALL_TYPES])
    def test_entries_have_egc(self, src, directory, glob):
        if not directory.exists():
            pytest.skip()
        path = next(directory.glob(glob), None)
        if not path:
            pytest.skip()
        data  = json.loads(path.read_text())
        first = next(iter(data.values()))
        assert "egc" in first or "EGC" in first

    @pytest.mark.parametrize("src,directory,glob", ALL_TYPES, ids=[t[0] for t in ALL_TYPES])
    def test_entries_have_norm_egc(self, src, directory, glob):
        if not directory.exists():
            pytest.skip()
        path = next(directory.glob(glob), None)
        if not path:
            pytest.skip()
        data  = json.loads(path.read_text())
        first = next(iter(data.values()))
        assert "norm_egc" in first or "NORM_EGC" in first

    @pytest.mark.parametrize("src,directory,glob", ALL_TYPES, ids=[t[0] for t in ALL_TYPES])
    def test_entries_have_depth(self, src, directory, glob):
        if not directory.exists():
            pytest.skip()
        path = next(directory.glob(glob), None)
        if not path:
            pytest.skip()
        data  = json.loads(path.read_text())
        first = next(iter(data.values()))
        assert "depth" in first

    @pytest.mark.parametrize("src,directory,glob", ALL_TYPES, ids=[t[0] for t in ALL_TYPES])
    def test_entries_have_category(self, src, directory, glob):
        if not directory.exists():
            pytest.skip()
        path = next(directory.glob(glob), None)
        if not path:
            pytest.skip()
        data  = json.loads(path.read_text())
        first = next(iter(data.values()))
        assert "category" in first

    @pytest.mark.parametrize("src,directory,glob", ALL_TYPES, ids=[t[0] for t in ALL_TYPES])
    def test_entries_have_scaffolds(self, src, directory, glob):
        if not directory.exists():
            pytest.skip()
        path = next(directory.glob(glob), None)
        if not path:
            pytest.skip()
        data = json.loads(path.read_text())
        has_scaffolds = any(
            isinstance(e, dict) and isinstance(e.get("scaffolds"), dict) and e["scaffolds"]
            for e in data.values()
        )
        assert has_scaffolds, f"{src}: no entries have a populated 'scaffolds' dict"

    @pytest.mark.parametrize("src,directory,glob", ALL_TYPES, ids=[t[0] for t in ALL_TYPES])
    def test_egc_non_negative(self, src, directory, glob):
        if not directory.exists():
            pytest.skip()
        path = next(directory.glob(glob), None)
        if not path:
            pytest.skip()
        data = json.loads(path.read_text())
        for node_id, entry in data.items():
            if not isinstance(entry, dict):
                continue
            val = entry.get("egc") or entry.get("EGC") or 0
            assert float(val) >= 0, f"{src}: negative EGC for {node_id}"

    # ── Schema fields missing from Taxonomy (xfail for taxonomy) ─────────────

    @pytest.mark.parametrize(
        "src,directory,glob",
        FULL_SCHEMA_TYPES,
        ids=[t[0] for t in FULL_SCHEMA_TYPES],
    )
    def test_entries_have_name(self, src, directory, glob):
        """KEGG/COG/Enzyme store the annotation name in a 'name' subfield.
        Taxonomy is excluded — the taxon name IS the dict key."""
        if not directory.exists():
            pytest.skip()
        path = next(directory.glob(glob), None)
        if not path:
            pytest.skip()
        data  = json.loads(path.read_text())
        first = next(iter(data.values()))
        assert "name" in first

    @pytest.mark.parametrize(
        "src,directory,glob",
        FULL_SCHEMA_TYPES,
        ids=[t[0] for t in FULL_SCHEMA_TYPES],
    )
    def test_entries_have_parent_id(self, src, directory, glob):
        """KEGG/COG/Enzyme use 'parent_id'.
        Taxonomy is excluded — it uses 'parent' to avoid repeating the name."""
        if not directory.exists():
            pytest.skip()
        path = next(directory.glob(glob), None)
        if not path:
            pytest.skip()
        data  = json.loads(path.read_text())
        first = next(iter(data.values()))
        assert "parent_id" in first

    @pytest.mark.parametrize(
        "src,directory,glob",
        PARENT_NAME_TYPES,
        ids=[t[0] for t in PARENT_NAME_TYPES],
    )
    def test_entries_have_parent_name(self, src, directory, glob):
        """Only KEGG and Enzyme carry parent_name. COG omits it (equals category).
        Taxonomy omits it entirely."""
        if not directory.exists():
            pytest.skip()
        path = next(directory.glob(glob), None)
        if not path:
            pytest.skip()
        data  = json.loads(path.read_text())
        first = next(iter(data.values()))
        assert "parent_name" in first


# ═══════════════════════════════════════════════════════════════════════════════
# 2. KEGG structural integrity
# ═══════════════════════════════════════════════════════════════════════════════

class TestKEGGFormat:
    """KEGG .ko.json structural invariants."""

    SPOT_SAMPLE = "3300060590"

    @pytest.fixture(autouse=True)
    def _skip_if_missing(self):
        if not KEGG_JSON_DIR.exists():
            pytest.skip("KEGG JSON directory missing")

    def test_ids_are_not_ko_prefixed(self, kegg_by_sample):
        """New format uses bare IDs (K00001, 09100) — not KO:K00001."""
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        prefixed = [k for k in kegg_by_sample[sid] if k.startswith("KO:")]
        assert not prefixed, f"KO:-prefixed IDs found: {prefixed[:3]}"

    def test_depth_values_are_1_to_4(self, kegg_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        bad = [
            (k, e["depth"])
            for k, e in kegg_by_sample[sid].items()
            if isinstance(e, dict) and not (1 <= e.get("depth", 0) <= 4)
        ]
        assert not bad, f"depth outside 1–4: {bad[:5]}"

    def test_depth1_nodes_have_null_parent_id(self, kegg_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        bad = [
            k for k, e in kegg_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 1 and e.get("parent_id") is not None
        ]
        assert not bad, f"depth-1 nodes with non-null parent_id: {bad[:5]}"

    def test_non_root_nodes_have_nonnull_parent_id(self, kegg_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        bad = [
            k for k, e in kegg_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth", 1) > 1 and e.get("parent_id") is None
        ]
        assert not bad, f"non-root nodes missing parent_id: {bad[:5]}"

    def test_category_non_empty(self, kegg_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        bad = [
            k for k, e in kegg_by_sample[sid].items()
            if isinstance(e, dict) and not e.get("category")
        ]
        assert not bad, f"entries with empty/missing category: {bad[:5]}"

    def test_scaffolds_values_are_positive_ints(self, kegg_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        bad = []
        for node_id, e in kegg_by_sample[sid].items():
            if not isinstance(e, dict):
                continue
            for scaf, cnt in e.get("scaffolds", {}).items():
                if not isinstance(cnt, int) or cnt <= 0:
                    bad.append(f"{node_id}/{scaf}={cnt!r}")
                    if len(bad) >= 5:
                        break
        assert not bad, f"invalid scaffold gene counts: {bad}"

    def test_hierarchy_nodes_alongside_ko_nodes(self, kegg_by_sample):
        """Files must contain both KO entries (K#####) and hierarchy entries (##### numeric)."""
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        data        = kegg_by_sample[sid]
        ko_ids      = [k for k in data if re.match(r'^K\d{5}$', k)]
        numeric_ids = [k for k in data if re.match(r'^\d{5}$', k)]
        assert ko_ids,      "No KO IDs (K#####) found — KO entries missing"
        assert numeric_ids, "No numeric IDs (#####) found — hierarchy ancestor nodes missing"

    def test_all_128_files_loaded(self, kegg_by_sample):
        assert len(kegg_by_sample) >= EXPECTED_SAMPLES


# ═══════════════════════════════════════════════════════════════════════════════
# 2b. KEGG hierarchy correctness (E14 regression)
# ═══════════════════════════════════════════════════════════════════════════════

class TestKEGGHierarchyRollup:
    """
    Regression coverage for E14: the BRITE parser kept only the last parent
    seen per KO (plain dict keyed by node_id, each occurrence overwriting the
    last), so a KO belonging to several real pathways got filed under
    whichever pathway happened to be listed last in ko00001.keg -- usually
    the "Brite Hierarchies" catch-all, since it comes near the end of the
    file. Pathway/category totals, built by summing only each node's
    last-recorded members, were therefore missing most of their real members.

    K00844 (hexokinase) is the known case: it appears 14 times in
    ko00001.keg under 14 different parents, the first of which is Glycolysis
    / Gluconeogenesis (00010). A correct rollup must count K00844's coverage
    toward 00010's total in every sample where both are annotated.

    KNOWN_HEXOKINASE_GENE below is a real gene confirmed (by directly
    searching DataStructures/Kegg/kegg_db.json) to be annotated K00844 in
    sample 3300060358 -- not a synthetic fixture, an actual entry in the
    dataset. Its scaffold is the ground truth used to check whether K00844
    is actually being rolled up into Glycolysis, rather than a looser
    magnitude check (00010's EGC total happens to already exceed a single
    member's own small EGC from OTHER, correctly-parented members, even
    while the bug is fully present -- a magnitude-only assertion silently
    passes against the buggy output and proves nothing).
    """

    SPOT_SAMPLE           = "3300060358"
    KNOWN_HEXOKINASE_GENE = "Ga0590986_0048567_1997_2740"
    KNOWN_HEXOKINASE_SCAFFOLD = "Ga0590986_0048567"  # gene_id.rsplit('_', 2)[0]

    @pytest.fixture(autouse=True)
    def _skip_if_missing(self):
        if not KEGG_JSON_DIR.exists():
            pytest.skip("KEGG JSON directory missing")

    def test_hexokinase_scaffold_reaches_glycolysis(self, kegg_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip(f"{sid} not loaded")
        data       = kegg_by_sample[sid]
        hexokinase = data.get("K00844")
        glycolysis = data.get("00010")
        assert hexokinase is not None, "K00844 missing from sample -- can't test"
        assert glycolysis is not None, "00010 missing from sample -- can't test"

        scaffold = self.KNOWN_HEXOKINASE_SCAFFOLD
        assert scaffold in hexokinase.get("scaffolds", {}), (
            f"sanity check failed: {scaffold} not even under K00844 itself -- "
            f"the known gene/scaffold no longer matches this dataset"
        )
        assert scaffold in glycolysis.get("scaffolds", {}), (
            f"{scaffold} (gene {self.KNOWN_HEXOKINASE_GENE}, confirmed K00844/"
            f"hexokinase -- a real member of Glycolysis / Gluconeogenesis per "
            f"ko00001.keg) is missing from 00010's scaffold set. K00844 is "
            f"currently rolled up under its last-seen parent instead "
            f"({hexokinase.get('parent_id')!r} {hexokinase.get('parent_name')!r}), "
            f"not under Glycolysis."
        )


# ═══════════════════════════════════════════════════════════════════════════════
# 3. COG structural integrity
# ═══════════════════════════════════════════════════════════════════════════════

class TestCOGFormat:
    """COG .cog.json structural invariants."""

    SPOT_SAMPLE = "3300060590"

    @pytest.fixture(autouse=True)
    def _skip_if_missing(self):
        if not COG_JSON_DIR.exists():
            pytest.skip("COG JSON directory missing")

    def test_depth_values_are_1_or_2(self, cog_by_sample):
        """COG hierarchy: depth=1 are letter categories (C, H …), depth=2 are COG#### leaves."""
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            (k, e["depth"])
            for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and not (1 <= e.get("depth", 0) <= 2)
        ]
        assert not bad, f"COG depth outside 1–2: {bad[:5]}"

    def test_depth1_are_single_letter_keys(self, cog_by_sample):
        """Depth-1 category nodes have single-letter IDs like C, H, O."""
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            k for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 1 and not re.match(r'^[A-Z]$', k)
        ]
        assert not bad, f"Depth-1 COG entries with non-letter key: {bad[:5]}"

    def test_depth2_are_cog_ids(self, cog_by_sample):
        """Depth-2 leaf nodes have COG#### IDs."""
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            k for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 2 and not re.match(r'^COG\d+$', k)
        ]
        assert not bad, f"Depth-2 COG entries with non-COG#### key: {bad[:5]}"

    def test_depth1_nodes_have_null_parent_id(self, cog_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            k for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 1 and e.get("parent_id") is not None
        ]
        assert not bad, f"depth-1 COG nodes with non-null parent_id: {bad[:5]}"

    def test_depth2_nodes_have_nonnull_parent_id(self, cog_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            k for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 2 and e.get("parent_id") is None
        ]
        assert not bad, f"depth-2 COG nodes missing parent_id: {bad[:5]}"

    def test_category_non_empty(self, cog_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            k for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and not e.get("category")
        ]
        assert not bad, f"COG entries with empty/missing category: {bad[:5]}"

    def test_scaffolds_values_are_positive_ints(self, cog_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = []
        for node_id, e in cog_by_sample[sid].items():
            if not isinstance(e, dict):
                continue
            for scaf, cnt in e.get("scaffolds", {}).items():
                if not isinstance(cnt, int) or cnt <= 0:
                    bad.append(f"{node_id}/{scaf}={cnt!r}")
                    if len(bad) >= 5:
                        break
        assert not bad, f"invalid COG scaffold gene counts: {bad}"

    def test_all_128_files_loaded(self, cog_by_sample):
        assert len(cog_by_sample) >= EXPECTED_SAMPLES


class TestCOGHierarchyRollup:
    """
    Regression coverage for E15: EGC_COG_TREE.ipynb registered each gene
    at its own COG id only -- never at that COG's category letter -- so
    category nodes didn't exist in the data at all (the notebook's own
    printed output said so outright: "4612 COG nodes (flat -- no category
    parent nodes)"). Fixed by registering every gene at both levels, the
    same per-node gene-set dedup pattern KEGG/Enzyme already used.

    Two things specific to this fix, beyond "category rollup exists at
    all" (already covered generically by TestAncestorAggregation):
    category's `category`/`name` fields must hold the real descriptive
    text (e.g. "Energy production and conversion"), not the bare letter
    id -- matching KEGG/Enzyme's convention that `category` is always a
    human-readable name, never a code. And -- caught while writing this
    test, not assumed -- NCBI's own live COG-category page for letter X
    was found to render a literal "nan" instead of X's real description
    ("Mobilome: prophages, transposons"), a genuine upstream data bug,
    not an extraction bug on our side.
    """

    SPOT_SAMPLE = "3300060358"

    @pytest.fixture(autouse=True)
    def _skip_if_missing(self):
        if not COG_JSON_DIR.exists():
            pytest.skip("COG JSON directory missing")

    def test_category_nodes_have_real_descriptive_names(self, cog_by_sample):
        """A depth-1 node's name/category must be more than its own bare
        letter id -- proves the NCBI category-description scrape actually
        ran, not that the field just got filled with the id again."""
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            (k, e["name"])
            for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 1 and e["name"] == k
        ]
        assert not bad, f"category nodes whose name is just their own bare letter: {bad}"

    def test_leaf_category_field_is_full_name_not_bare_letter(self, cog_by_sample):
        """A depth-2 (COG id) node's category field must be the category's
        real name, not its bare parent letter -- matches KEGG/Enzyme's
        convention that `category` is always a human-readable name."""
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            (k, e["category"], e["parent_id"])
            for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 2 and e["category"] == e["parent_id"]
        ]
        assert not bad, f"COG entries whose category is just the bare parent letter: {bad[:5]}"

    def test_category_depth1_self_referential_name_equals_category(self, cog_by_sample):
        """Same convention KEGG's root nodes follow: a top-level node's own
        name and category field must match (it IS its own category)."""
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            k for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 1 and e["name"] != e["category"]
        ]
        assert not bad, f"category nodes where name != category: {bad}"

    def test_no_category_name_is_a_known_bad_placeholder(self, cog_by_sample):
        """Caught live: NCBI's own page for category X currently renders
        "nan" instead of a real description -- an upstream data bug, not
        ours, but one this pipeline shouldn't silently pass through into
        something a user would see. If this starts failing because NCBI
        fixed their page, that's fine -- update/remove the check then."""
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        bad = [
            (k, e["name"])
            for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 1 and e["name"].strip().lower() == "nan"
        ]
        assert not bad, f"category nodes with a placeholder/NaN name: {bad}"


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Enzyme structural integrity
# ═══════════════════════════════════════════════════════════════════════════════

class TestEnzymeFormat:
    """Enzyme .enzyme.json structural invariants."""

    SPOT_SAMPLE = "3300060590"

    @pytest.fixture(autouse=True)
    def _skip_if_missing(self):
        if not ENZYME_JSON_DIR.exists():
            pytest.skip("Enzyme JSON directory missing")

    def test_depth_values_are_1_to_4(self, enzyme_by_sample):
        """Enzyme hierarchy mirrors EC number depth: 1=class, 2=subclass, 3=sub-subclass, 4=leaf."""
        sid = self.SPOT_SAMPLE
        if sid not in enzyme_by_sample:
            pytest.skip()
        bad = [
            (k, e["depth"])
            for k, e in enzyme_by_sample[sid].items()
            if isinstance(e, dict) and not (1 <= e.get("depth", 0) <= 4)
        ]
        assert not bad, f"Enzyme depth outside 1–4: {bad[:5]}"

    def test_depth4_are_leaf_ec_numbers(self, enzyme_by_sample):
        """Leaf EC numbers at depth=4 must be X.X.X.X format."""
        sid = self.SPOT_SAMPLE
        if sid not in enzyme_by_sample:
            pytest.skip()
        leaf_pat = re.compile(r'^\d+\.\d+\.\d+\.\d+$')
        bad = [
            k for k, e in enzyme_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 4 and not leaf_pat.match(k)
        ]
        assert not bad, f"Depth-4 Enzyme entries with non-leaf key: {bad[:5]}"

    def test_depth1_nodes_have_null_parent_id(self, enzyme_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in enzyme_by_sample:
            pytest.skip()
        bad = [
            k for k, e in enzyme_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth") == 1 and e.get("parent_id") is not None
        ]
        assert not bad, f"depth-1 Enzyme nodes with non-null parent_id: {bad[:5]}"

    def test_non_root_nodes_have_nonnull_parent_id(self, enzyme_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in enzyme_by_sample:
            pytest.skip()
        bad = [
            k for k, e in enzyme_by_sample[sid].items()
            if isinstance(e, dict) and e.get("depth", 1) > 1 and e.get("parent_id") is None
        ]
        assert not bad, f"non-root Enzyme nodes missing parent_id: {bad[:5]}"

    def test_category_non_empty(self, enzyme_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in enzyme_by_sample:
            pytest.skip()
        bad = [
            k for k, e in enzyme_by_sample[sid].items()
            if isinstance(e, dict) and not e.get("category")
        ]
        assert not bad, f"Enzyme entries with empty/missing category: {bad[:5]}"

    def test_scaffolds_values_are_positive_ints(self, enzyme_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in enzyme_by_sample:
            pytest.skip()
        bad = []
        for node_id, e in enzyme_by_sample[sid].items():
            if not isinstance(e, dict):
                continue
            for scaf, cnt in e.get("scaffolds", {}).items():
                if not isinstance(cnt, int) or cnt <= 0:
                    bad.append(f"{node_id}/{scaf}={cnt!r}")
                    if len(bad) >= 5:
                        break
        assert not bad, f"invalid Enzyme scaffold gene counts: {bad}"

    def test_all_128_files_loaded(self, enzyme_by_sample):
        assert len(enzyme_by_sample) >= EXPECTED_SAMPLES


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Taxonomy structural integrity
# ═══════════════════════════════════════════════════════════════════════════════

class TestTaxonomyFormat:
    """
    Taxonomy .tax.json schema (as of the 2026-09-02 full-lineage rekeying,
    see taxonomy_egc_homonym_bug):

      - The dict KEY is the full lineage prefix through this rank
        (e.g. "Bacteria;Bacteroidetes"), NOT the bare taxon name — the same
        bare name can legitimately appear under more than one ancestry
        (taxonomic reclassification across samples/pipeline versions), so
        keying by full lineage instead of bare name avoids silently merging
        two such occurrences into one node with a wrong parent.
      - A separate 'name' field holds the bare rank label (e.g. "Bacteroidetes")
        for display, matching how KEGG/COG/Enzyme already carry 'name'.
      - Uses 'parent' (the parent's own lineage-prefix string, or null for
        roots) instead of 'parent_id'/'parent_name'.
      - Shares the common fields: depth, category, egc, norm_egc, scaffolds
    """

    SPOT_SAMPLE = "3300060590"

    @pytest.fixture(autouse=True)
    def _skip_if_missing(self):
        if not TAXONOMY_JSON_DIR.exists():
            pytest.skip("Taxonomy JSON directory missing")

    def _load_spot(self) -> dict:
        path = TAXONOMY_JSON_DIR / f"{self.SPOT_SAMPLE}.tax.json"
        if not path.exists():
            pytest.skip(f"{path} not found")
        return json.loads(path.read_text())

    def test_all_128_files_loaded(self):
        n = len(list(TAXONOMY_JSON_DIR.glob("*.tax.json")))
        assert n >= EXPECTED_SAMPLES

    def test_keys_are_taxon_names_not_ids(self):
        """Keys must be taxon lineage-prefix strings, not numeric IDs."""
        data = self._load_spot()
        numeric = [k for k in data if re.match(r'^\d+$', k)]
        assert not numeric, f"Numeric keys found (expected taxon lineage strings): {numeric[:5]}"

    def test_entries_have_name_field(self):
        """The dict key is now the full lineage prefix, not the display name,
        so a separate 'name' field (the bare rank label) must exist."""
        data  = self._load_spot()
        first = next(iter(data.values()))
        assert "name" in first, "'name' field missing"

    def test_entries_use_parent_not_parent_id(self):
        """Taxonomy uses 'parent' (taxon lineage-prefix string) not 'parent_id'."""
        data  = self._load_spot()
        first = next(iter(data.values()))
        assert "parent" in first, "'parent' field missing"
        assert "parent_id" not in first, "'parent_id' present — should use 'parent'"

    def test_root_nodes_have_null_parent(self):
        data = self._load_spot()
        bad  = [k for k, e in data.items()
                if isinstance(e, dict) and e.get("depth") == 1 and e.get("parent") is not None]
        assert not bad, f"depth-1 taxonomy nodes with non-null parent: {bad[:5]}"

    def test_non_root_nodes_have_nonnull_parent(self):
        data = self._load_spot()
        bad  = [k for k, e in data.items()
                if isinstance(e, dict) and e.get("depth", 1) > 1 and e.get("parent") is None]
        assert not bad, f"non-root taxonomy nodes with null parent: {bad[:5]}"

    def test_parent_value_is_a_key_in_same_file(self):
        """Every non-null 'parent' must be a key that exists in the same file."""
        data = self._load_spot()
        bad  = [k for k, e in data.items()
                if isinstance(e, dict) and e.get("parent") is not None
                and e["parent"] not in data]
        assert not bad, f"'parent' values not found as keys: {bad[:5]}"

    def test_ancestor_chain_reaches_root_no_cycles(self):
        """
        Walking 'parent' from any node must reach a root (parent=None) without
        ever hitting a missing key or revisiting a node. Checked exhaustively
        (every node in the spot sample), not sampled — this is the structural
        guarantee the tree builder in EGC_TAX_TREE.ipynb (cell 8) relies on:
        every prefix of every taxonomy path is registered as a node with a
        timepoints entry for the same sample in the same pass that registers
        the leaf, so a child can never outlive its own ancestor chain.
        """
        data = self._load_spot()
        bad: list[str] = []
        for node_id in data:
            visited, curr = set(), node_id
            while curr is not None:
                if curr in visited:
                    bad.append(f"{node_id}: cycle at '{curr}'")
                    break
                visited.add(curr)
                entry = data.get(curr)
                if entry is None:
                    bad.append(f"{node_id}: ancestor '{curr}' missing from file")
                    break
                curr = entry.get("parent")
            if len(bad) >= 5:
                break
        assert not bad, "Broken/cyclic ancestor chains:\n" + "\n".join(bad)

    def test_entries_have_depth(self):
        data  = self._load_spot()
        first = next(iter(data.values()))
        assert "depth" in first

    def test_entries_have_category(self):
        data  = self._load_spot()
        first = next(iter(data.values()))
        assert "category" in first

    def test_entries_have_egc_and_norm_egc(self):
        data  = self._load_spot()
        first = next(iter(data.values()))
        assert "egc"      in first
        assert "norm_egc" in first

    def test_entries_have_scaffolds(self):
        data = self._load_spot()
        has  = any(isinstance(e, dict) and isinstance(e.get("scaffolds"), dict) and e["scaffolds"]
                   for e in data.values())
        assert has, "No taxonomy entries have a populated 'scaffolds' dict"


class TestTaxonomyLineageCollapseRemoved:
    """
    Regression coverage for E16 (docs/AUDIT.md): EGC_TAX_TREE.ipynb used to
    collapse every consecutive repeated name in a raw lineage, not just a
    trailing one -- checked directly against all 128 real .a.phylodist.txt
    files before this fix: 7.6M of 71.1M lineage observations (10.7%) have
    an internal (non-trailing) repeat, e.g. genus AND species both
    "unclassified Flavobacteriaceae". Collapsing those silently deleted a
    real rank position, shifting every rank below it one level too shallow.

    Real anchor example, sample 3300060358 (independently confirmed present
    in the raw .a.phylodist.txt before writing this test, not assumed):
      Bacteria;Bacteroidetes;Flavobacteriia;Flavobacteriales;
      Flavobacteriaceae;unclassified Flavobacteriaceae;
      unclassified Flavobacteriaceae;Flavobacteriaceae bacterium AU392
    Genus (rank 6) and species (rank 7) are both "unclassified
    Flavobacteriaceae" -- the exact internal-repeat shape this fix targets.
    """

    SPOT_SAMPLE = "3300060358"

    GENUS_KEY = "Bacteria;Bacteroidetes;Flavobacteriia;Flavobacteriales;Flavobacteriaceae;unclassified Flavobacteriaceae"
    SPECIES_KEY = GENUS_KEY + ";unclassified Flavobacteriaceae"
    STRAIN_KEY = SPECIES_KEY + ";Flavobacteriaceae bacterium AU392"

    @pytest.fixture(autouse=True)
    def _skip_if_missing(self):
        if not TAXONOMY_JSON_DIR.exists():
            pytest.skip("Taxonomy JSON directory missing")

    def _load_spot(self) -> dict:
        path = TAXONOMY_JSON_DIR / f"{self.SPOT_SAMPLE}.tax.json"
        if not path.exists():
            pytest.skip(f"{path} not found")
        return json.loads(path.read_text())

    def test_internal_repeat_lineages_reach_their_full_raw_depth(self):
        """General ground-truth check, not just the one hardcoded anchor
        below: pulls real lineages with an internal (non-trailing) repeat
        straight from the raw .a.phylodist.txt file -- independent of the
        tree-builder's own logic -- and confirms each one's deepest real
        segment lands in tax_tree at a depth equal to its RAW segment
        count. This is the property the removed collapse used to break
        (it silently produced a shallower depth); confirmed this test
        actually discriminates old vs. new behavior, not just trivially
        true either way -- a naive "depth == len(own key's segments)"
        check turns out to hold under both the buggy and fixed builder
        (they're always self-consistent, built from the same taxpath),
        so it doesn't catch this bug at all. Comparing against the raw
        file's real segment count is what actually catches it."""
        phylodist_path = METAGENOME_SAMPLES_DIR / self.SPOT_SAMPLE / f"{self.SPOT_SAMPLE}.a.phylodist.txt"
        if not phylodist_path.exists():
            pytest.skip(f"{phylodist_path} not found")

        data = self._load_spot()
        checked = 0
        bad = []
        with open(phylodist_path, encoding="utf-8", errors="replace") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 5:
                    continue
                taxpath = [p.strip() for p in parts[-1].split(";") if p.strip()]
                repeat_positions = [i for i in range(1, len(taxpath)) if taxpath[i] == taxpath[i - 1]]
                internal = [p for p in repeat_positions if p != len(taxpath) - 1]
                if not internal:
                    continue

                full_key = ";".join(taxpath)
                checked += 1
                if full_key not in data:
                    bad.append((full_key, "missing from tax_tree entirely"))
                elif data[full_key]["depth"] != len(taxpath):
                    bad.append((full_key, f"depth={data[full_key]['depth']}, raw segments={len(taxpath)}"))

                if checked >= 200:  # real file has millions of rows; 200 real internal-repeat cases is plenty
                    break

        assert checked > 0, "no internal-repeat lineages found in this sample -- anchor assumption may be stale"
        assert not bad, f"internal-repeat lineages not reaching full raw depth: {bad[:5]}"

    def test_genus_and_species_both_unresolved_are_distinct_nodes(self):
        """The real anchor case: genus and species share the identical
        placeholder name -- post-fix, that's two distinct nodes (depths 6
        and 7), not collapsed into one."""
        data = self._load_spot()
        if self.GENUS_KEY not in data or self.SPECIES_KEY not in data:
            pytest.skip("anchor lineage not present in this regeneration")
        assert data[self.GENUS_KEY]["depth"] == 6
        assert data[self.SPECIES_KEY]["depth"] == 7
        assert data[self.GENUS_KEY]["name"] == data[self.SPECIES_KEY]["name"] == "unclassified Flavobacteriaceae"
        assert data[self.SPECIES_KEY]["parent"] == self.GENUS_KEY

    def test_strain_reaches_its_real_depth_of_8_not_7(self):
        """The actual bug: pre-fix, this strain node would have been
        shifted to depth 7 (colliding with the species rank slot) because
        the genus/species repeat ahead of it got collapsed away."""
        data = self._load_spot()
        if self.STRAIN_KEY not in data:
            pytest.skip("anchor lineage not present in this regeneration")
        assert data[self.STRAIN_KEY]["depth"] == 8
        assert data[self.STRAIN_KEY]["parent"] == self.SPECIES_KEY


# ═══════════════════════════════════════════════════════════════════════════════
# 7. BRITE hierarchy correctness (KEGG only)
# ═══════════════════════════════════════════════════════════════════════════════

class TestKEGGBriteHierarchy:
    """
    Verify that .ko.json's single-parent DISPLAY metadata (depth, category,
    parent_id, parent_name -- one canonical parent per node, "last occurrence
    in ko00001.keg wins", same as `brite_dict` below) is internally
    consistent and matches the BRITE file under that same last-occurrence
    convention.

    This class does NOT and CANNOT catch E14 (the multi-parent EGC/scaffold
    rollup bug) -- `brite_dict` deliberately re-implements the same
    single-parent-wins parsing the pre-fix notebook used, so a node's
    metadata will always "match" it regardless of whether the real rollup
    (which needs EVERY parent, not just the last one) is correct. That
    real regression coverage lives in TestKEGGHierarchyRollup, which checks
    real gene/scaffold ground truth instead of re-deriving from the same
    parser being tested. Audit docs/AUDIT.md Part 4/T1 flagged this
    distinction explicitly.

    K00844 (hexokinase) is the canonical spot-check because its chain is in
    the first lines of the .keg file:
      A09100  Metabolism
      B 09101  Carbohydrate metabolism
      C  00010  Glycolysis / Gluconeogenesis [PATH:ko00010]
      D   K00844  HK; hexokinase [EC:2.7.1.1]
    """

    SPOT_SAMPLE = "3300060590"
    SPOT_KO     = "K00844"

    def _load_spot(self) -> dict:
        path = KEGG_JSON_DIR / f"{self.SPOT_SAMPLE}.ko.json"
        if not path.exists():
            pytest.skip(f"{path} not found — run EGC_KEGG_TREE notebook first")
        return json.loads(path.read_text())

    def test_spot_ko_present(self):
        assert self.SPOT_KO in self._load_spot()

    def test_spot_ko_depth_is_4(self):
        data = self._load_spot()
        if self.SPOT_KO not in data:
            pytest.skip()
        assert data[self.SPOT_KO]["depth"] == 4

    def test_spot_ko_category_is_nonempty(self):
        """
        K00844 must have a non-empty category string.

        K00844 appears in both Glycolysis (A09100 Metabolism) and in a BRITE
        database section (A09180 Brite Hierarchies) within ko00001.keg.  The
        notebook processes entries in file order, so the LAST occurrence wins;
        in this file K00844 ends up under "Brite Hierarchies".  The important
        property is that *some* category is assigned, not its specific value.
        """
        data = self._load_spot()
        if self.SPOT_KO not in data:
            pytest.skip()
        assert data[self.SPOT_KO]["category"], "K00844 category is empty"

    def test_spot_ko_parent_id_is_nonnull(self):
        """K00844 is a D-level (depth=4) node and must have a parent_id."""
        data = self._load_spot()
        if self.SPOT_KO not in data:
            pytest.skip()
        assert data[self.SPOT_KO]["parent_id"] is not None, \
            "K00844 depth-4 node has null parent_id"

    def test_spot_ko_parent_exists_in_file(self):
        data = self._load_spot()
        if self.SPOT_KO not in data:
            pytest.skip()
        parent_id = data[self.SPOT_KO]["parent_id"]
        assert parent_id in data, f"parent_id '{parent_id}' not found in same file"

    def test_parent_chain_terminates_at_depth1_no_cycles(self):
        """Walking parent_id from any KO must reach a depth-1 root without cycles."""
        data     = self._load_spot()
        ko_nodes = {k: e for k, e in data.items() if isinstance(e, dict) and e.get("depth") == 4}
        if not ko_nodes:
            pytest.skip("No depth-4 entries found")
        node_id       = next(iter(ko_nodes))
        visited, curr = set(), node_id
        while curr is not None:
            assert curr not in visited, f"Cycle in parent chain at {curr}"
            visited.add(curr)
            entry = data.get(curr)
            assert entry is not None, f"parent_id '{curr}' not found in file"
            if entry["depth"] == 1:
                assert entry["parent_id"] is None
                break
            curr = entry["parent_id"]

    def test_json_matches_brite_file_for_spot_ko(self, brite_dict):
        """K00844's single-parent DISPLAY metadata in .ko.json must exactly
        match brite_dict's same last-occurrence-wins parse. NOT a check of
        the multi-parent EGC rollup -- see TestKEGGHierarchyRollup for that."""
        data = self._load_spot()
        if self.SPOT_KO not in data or self.SPOT_KO not in brite_dict:
            pytest.skip()
        entry = data[self.SPOT_KO]
        brite = brite_dict[self.SPOT_KO]
        for field in ("depth", "category", "parent_id", "parent_name"):
            assert entry[field] == brite[field], \
                f"{self.SPOT_KO}.{field}: json={entry[field]!r} brite={brite[field]!r}"

    def test_all_json_nodes_match_brite_file(self, kegg_by_sample, brite_dict):
        """Every node's single-parent DISPLAY metadata in the spot sample
        must match brite_dict's same last-occurrence-wins parse. NOT a check
        of the multi-parent EGC rollup -- see TestKEGGHierarchyRollup."""
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        data       = kegg_by_sample[sid]
        mismatches: list[str] = []
        for node_id, entry in data.items():
            if not isinstance(entry, dict) or node_id not in brite_dict:
                continue
            b = brite_dict[node_id]
            for field in ("depth", "category", "parent_id", "parent_name"):
                if entry.get(field) != b[field]:
                    mismatches.append(
                        f"  {node_id}.{field}: json={entry.get(field)!r} brite={b[field]!r}"
                    )
            if len(mismatches) >= 10:
                break
        assert not mismatches, "BRITE/JSON mismatches:\n" + "\n".join(mismatches)


# ═══════════════════════════════════════════════════════════════════════════════
# 8. EGC formula — synthetic math verification (no files needed)
# ═══════════════════════════════════════════════════════════════════════════════

class TestEGCMathSynthetic:
    """
    Verify the EGC and norm_egc formulas with hand-computed values.

      egc      = Σ (gene_count × scaffold_coverage)
      norm_egc = Σ (gene_count × (scaffold_coverage / total_sample_depth))

    total_sample_depth is the shared, cross-source denominator computed by
    Notebooks/weighted_totals.py (calculate_denominator_egc): Σ(gene_count
    × AvgFold) across every scaffold with at least one annotated gene in
    the sample, from ANY of the four sources -- not just the scaffolds
    carrying genes for this specific annotation, and not the plain
    Σ(AvgFold) that allfold[sample]['total'] holds (that's the old,
    superseded denominator). This test's own arithmetic below is
    self-contained (TOTAL is a hand-picked stand-in, not read from real
    data), so it stays correct regardless of the formula change -- only
    this docstring's description of what TOTAL represents needed updating.
    """

    SCAFFOLDS = {"scafA": 3, "scafB": 1, "scafC": 2}
    COVS      = {"scafA": 100.0, "scafB": 50.0, "scafC": 20.0}
    # TOTAL represents the whole-sample depth.  It is intentionally larger
    # than sum(COVS.values()) = 170.0 — the sample has many more scaffolds
    # beyond the three that carry genes for this annotation.
    TOTAL     = 500.0

    # Hand-computed: egc = 3*100 + 1*50 + 2*20 = 390
    #                norm = (3*100/500) + (1*50/500) + (2*20/500) = 0.78
    EXPECTED_EGC      = 390.0
    EXPECTED_NORM_EGC = 0.78

    def test_egc_formula(self):
        egc = sum(cnt * self.COVS[s] for s, cnt in self.SCAFFOLDS.items())
        assert abs(egc - self.EXPECTED_EGC) < 1e-9

    def test_norm_egc_expected_value(self):
        norm = sum(cnt * self.COVS[s] / self.TOTAL for s, cnt in self.SCAFFOLDS.items())
        assert abs(norm - self.EXPECTED_NORM_EGC) < 1e-9

    def test_norm_egc_equals_egc_over_total(self):
        egc  = sum(cnt * self.COVS[s]              for s, cnt in self.SCAFFOLDS.items())
        norm = sum(cnt * self.COVS[s] / self.TOTAL for s, cnt in self.SCAFFOLDS.items())
        assert abs(norm - egc / self.TOTAL) < 1e-12

    def test_zero_coverage_contributes_zero(self):
        egc  = sum(cnt * 0.0 for cnt in self.SCAFFOLDS.values())
        norm = sum(cnt * 0.0 / self.TOTAL for cnt in self.SCAFFOLDS.values())
        assert egc  == 0.0
        assert norm == 0.0

    def test_single_scaffold_exact(self):
        assert 1 * 277.0 == 277.0
        assert abs(1 * 277.0 / 10000.0 - 0.0277) < 1e-12

    def test_ancestor_aggregates_more_scaffolds_than_child(self):
        child_s  = {"scafA": 2, "scafB": 1}
        parent_s = {"scafA": 2, "scafB": 1, "scafC": 4}
        covs     = {"scafA": 100.0, "scafB": 50.0, "scafC": 30.0}
        child_egc  = sum(cnt * covs[s] for s, cnt in child_s.items())
        parent_egc = sum(cnt * covs[s] for s, cnt in parent_s.items())
        assert parent_egc >= child_egc


# ═══════════════════════════════════════════════════════════════════════════════
# 9. KEGG EGC vs JGI ground truth
# ═══════════════════════════════════════════════════════════════════════════════

class TestKEGGEGCVsJGI:
    """
    Compare depth-4 KO EGC values from .ko.json against the JGI ground truth.

    JGI uses "KO:K00001"; JSON uses bare "K00001" — strip the prefix for lookup.
    Hierarchy nodes (09100 etc.) have no JGI counterpart and are not compared.
    """

    def _get_egc(self, sample_data: dict, jgi_ann_id: str) -> Optional[float]:
        bare  = jgi_ann_id[3:] if jgi_ann_id.startswith("KO:") else jgi_ann_id
        entry = sample_data.get(bare)
        if entry is None or not isinstance(entry, dict):
            return None
        raw = entry.get("egc") if entry.get("egc") is not None else entry.get("EGC")
        return float(raw) if raw is not None else None

    def test_k00844_spot_check_3300060590(self, kegg_by_sample, kegg_jgi_table):
        sid, jgi_id = "3300060590", "KO:K00844"
        jgi = kegg_jgi_table.get(jgi_id, {}).get(sid)
        if jgi is None:
            pytest.skip(f"{jgi_id} not in JGI table for {sid}")
        if sid not in kegg_by_sample:
            pytest.skip()
        backend = self._get_egc(kegg_by_sample[sid], jgi_id)
        assert backend is not None, "K00844 not found in JSON"
        assert egc_within_tolerance(backend, jgi), \
            f"K00844/{sid}: backend={backend:.1f}, JGI={jgi:.1f}"

    @pytest.mark.parametrize("jgi_ann_id", [
        "KO:K00844", "KO:K00001", "KO:K00002", "KO:K00003", "KO:K00762",
    ])
    def test_spot_kos_spot_sample(self, kegg_by_sample, kegg_jgi_table, jgi_ann_id):
        sid = "3300060590"
        jgi = kegg_jgi_table.get(jgi_ann_id, {}).get(sid)
        if jgi is None:
            pytest.skip(f"{jgi_ann_id} not in JGI table for {sid}")
        if sid not in kegg_by_sample:
            pytest.skip()
        backend = self._get_egc(kegg_by_sample[sid], jgi_ann_id)
        if backend is None:
            pytest.skip(f"{jgi_ann_id} absent from JSON")
        assert egc_within_tolerance(backend, jgi), \
            f"{jgi_ann_id}/{sid}: backend={backend:.1f}, JGI={jgi:.1f}"

    def test_k00001_all_128_samples(self, kegg_by_sample, kegg_jgi_table):
        """K00001 (alcohol dehydrogenase) must match JGI for every sample."""
        jgi_id  = "KO:K00001"
        jgi_row = kegg_jgi_table.get(jgi_id, {})
        if not jgi_row:
            pytest.skip(f"{jgi_id} not in JGI table")
        mismatches: list[str] = []
        for sid, jgi_val in jgi_row.items():
            if sid not in kegg_by_sample:
                continue
            backend = self._get_egc(kegg_by_sample[sid], jgi_id)
            if backend is None:
                continue
            if not egc_within_tolerance(backend, jgi_val):
                tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                mismatches.append(
                    f"  {sid}: backend={backend:.1f}, JGI={jgi_val:.1f}, "
                    f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                )
        assert not mismatches, \
            f"K00001 mismatches ({len(mismatches)}):\n" + "\n".join(mismatches)

    def test_all_jgi_kos_spot_sample(self, kegg_by_sample, kegg_jgi_table):
        """
        For the spot sample, every KO that exists in BOTH the JGI table and the
        JSON must be within tolerance.  Documents the per-annotation pass rate.
        """
        sid = "3300060590"
        if sid not in kegg_by_sample:
            pytest.skip()
        mismatches: list[str] = []
        compared = 0
        for jgi_id, row in kegg_jgi_table.items():
            jgi_val = row.get(sid)
            if jgi_val is None:
                continue
            backend = self._get_egc(kegg_by_sample[sid], jgi_id)
            if backend is None:
                continue
            compared += 1
            if not egc_within_tolerance(backend, jgi_val):
                tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                mismatches.append(
                    f"  {jgi_id}: backend={backend:.1f}, JGI={jgi_val:.1f}, "
                    f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                )
            if len(mismatches) >= 20:
                break
        assert compared > 0, "No KO IDs matched between JGI table and JSON"
        assert not mismatches, \
            f"KEGG EGC mismatches for {sid} ({len(mismatches)}):\n" + "\n".join(mismatches)

    def test_only_depth4_entries_compared_to_jgi(self, kegg_by_sample):
        """K##### IDs in the JSON must all be at depth=4."""
        sid = "3300060590"
        if sid not in kegg_by_sample:
            pytest.skip()
        data       = kegg_by_sample[sid]
        ko_pattern = re.compile(r'^K\d{5}$')
        wrong_depth = [
            (k, e["depth"]) for k, e in data.items()
            if isinstance(e, dict) and ko_pattern.match(k) and e.get("depth") != 4
        ]
        assert not wrong_depth, f"K##### IDs with depth ≠ 4: {wrong_depth[:5]}"


# ═══════════════════════════════════════════════════════════════════════════════
# 10. COG EGC vs JGI ground truth
# ═══════════════════════════════════════════════════════════════════════════════

class TestCOGEGCVsJGI:
    """
    Compare depth-2 COG EGC values from .cog.json against the JGI ground truth.

    JGI uses "COG0001"; JSON also uses "COG0001" — no prefix stripping needed.
    Depth-1 letter categories (C, H …) have no JGI counterpart.
    """

    def _get_egc(self, sample_data: dict, ann_id: str) -> Optional[float]:
        entry = sample_data.get(ann_id)
        if entry is None or not isinstance(entry, dict):
            return None
        raw = entry.get("egc") if entry.get("egc") is not None else entry.get("EGC")
        return float(raw) if raw is not None else None

    def test_cog0001_spot_check_3300060590(self, cog_by_sample, cog_jgi_table):
        sid, ann_id = "3300060590", "COG0001"
        jgi = cog_jgi_table.get(ann_id, {}).get(sid)
        if jgi is None:
            pytest.skip(f"{ann_id} not in JGI table for {sid}")
        if sid not in cog_by_sample:
            pytest.skip()
        backend = self._get_egc(cog_by_sample[sid], ann_id)
        assert backend is not None, f"{ann_id} not found in {sid}.cog.json"
        assert egc_within_tolerance(backend, jgi), \
            f"{ann_id}/{sid}: backend={backend:.1f}, JGI={jgi:.1f}"

    @pytest.mark.parametrize("ann_id", [
        "COG0001", "COG0055", "COG0085", "COG0012", "COG0018",
    ])
    def test_spot_cogs_spot_sample(self, cog_by_sample, cog_jgi_table, ann_id):
        sid = "3300060590"
        jgi = cog_jgi_table.get(ann_id, {}).get(sid)
        if jgi is None:
            pytest.skip(f"{ann_id} not in JGI table for {sid}")
        if sid not in cog_by_sample:
            pytest.skip()
        backend = self._get_egc(cog_by_sample[sid], ann_id)
        if backend is None:
            pytest.skip(f"{ann_id} absent from JSON")
        assert egc_within_tolerance(backend, jgi), \
            f"{ann_id}/{sid}: backend={backend:.1f}, JGI={jgi:.1f}"

    def test_cog0055_all_128_samples(self, cog_by_sample, cog_jgi_table):
        """COG0055 (ATP synthase beta) must match JGI for every sample."""
        ann_id  = "COG0055"
        jgi_row = cog_jgi_table.get(ann_id, {})
        if not jgi_row:
            pytest.skip(f"{ann_id} not in JGI table")
        mismatches: list[str] = []
        for sid, jgi_val in jgi_row.items():
            if sid not in cog_by_sample:
                continue
            backend = self._get_egc(cog_by_sample[sid], ann_id)
            if backend is None:
                continue
            if not egc_within_tolerance(backend, jgi_val):
                tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                mismatches.append(
                    f"  {sid}: backend={backend:.1f}, JGI={jgi_val:.1f}, "
                    f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                )
        assert not mismatches, \
            f"COG0055 mismatches ({len(mismatches)}):\n" + "\n".join(mismatches)

    def test_all_jgi_cogs_spot_sample_pass_rate(self, cog_by_sample, cog_jgi_table):
        """
        Every COG entry in the spot sample must match JGI exactly (within
        egc_within_tolerance's near-zero float/int noise floor).

        Historical note (audit Part 4/T1): this test used to allow a 20%
        divergence tolerance with an 80% pass-rate gate, on the theory that
        paralog-heavy COGs (multiple genes on one scaffold) would legitimately
        diverge from JGI's per-gene coverage due to this pipeline's
        scaffold-level averaging (see conftest.py's EGC methodology note).
        That gate silently tolerated up to 20% of COG values being wrong,
        which could mask a real regression (e.g. a wrong depth denominator)
        as long as it didn't affect more than 20% of entries.

        Re-verified directly against real data before tightening this:
        COG_ABS_FLOOR/PCT_TOLERANCE (conftest.py) already reflect exact-match
        expectations, and checking the spot sample plus 4 others gives 0
        mismatches out of 4,475-4,545 COG entries each (100% match) -- the
        20%-divergence paralog scenario this test's old docstring described
        does not actually occur in the current, regenerated dataset. Zero
        tolerance for failures is therefore the correct gate: any future
        mismatch here is a real regression, not expected paralog noise.
        """
        sid = "3300060590"
        if sid not in cog_by_sample:
            pytest.skip()
        passed = 0
        failed = 0
        failures: list[str] = []
        for ann_id, row in cog_jgi_table.items():
            if not ann_id.startswith("COG"):
                continue
            jgi_val = row.get(sid)
            if jgi_val is None:
                continue
            backend = self._get_egc(cog_by_sample[sid], ann_id)
            if backend is None:
                continue
            if egc_within_tolerance(backend, jgi_val):
                passed += 1
            else:
                failed += 1
                if len(failures) < 5:
                    tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                    failures.append(
                        f"  {ann_id}: backend={backend:.1f}, JGI={jgi_val:.1f}, "
                        f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                    )
        total = passed + failed
        assert total > 0, "No COG IDs matched between JGI table and JSON"
        assert failed == 0, (
            f"{failed}/{total} COG entries mismatch JGI (100% required). "
            f"Sample failures:\n" + "\n".join(failures)
        )

    def test_only_depth2_entries_are_cog_leaves(self, cog_by_sample):
        """All COG#### entries must be at depth=2."""
        sid = "3300060590"
        if sid not in cog_by_sample:
            pytest.skip()
        cog_pat = re.compile(r'^COG\d+$')
        wrong = [
            (k, e.get("depth")) for k, e in cog_by_sample[sid].items()
            if isinstance(e, dict) and cog_pat.match(k) and e.get("depth") != 2
        ]
        assert not wrong, f"COG#### entries with depth ≠ 2: {wrong[:5]}"


# ═══════════════════════════════════════════════════════════════════════════════
# 11. Enzyme EGC vs JGI ground truth
# ═══════════════════════════════════════════════════════════════════════════════

class TestEnzymeEGCVsJGI:
    """
    Compare depth-4 Enzyme EGC values from .enzyme.json against JGI ground truth.

    JGI uses "EC:1.1.1.1"; JSON uses bare "1.1.1.1" — strip "EC:" for lookup.
    Hierarchy nodes (1.1.1, 1.1, 1) have no direct JGI leaf counterpart.
    """

    def _get_egc(self, sample_data: dict, jgi_ann_id: str) -> Optional[float]:
        bare  = jgi_ann_id[3:] if jgi_ann_id.startswith("EC:") else jgi_ann_id
        entry = sample_data.get(bare)
        if entry is None or not isinstance(entry, dict):
            return None
        raw = entry.get("egc") if entry.get("egc") is not None else entry.get("EGC")
        return float(raw) if raw is not None else None

    def test_ec3_6_1_23_spot_check_3300060590(self, enzyme_by_sample, enzyme_jgi_table):
        """dUTP diphosphatase (3.6.1.23) in the spot sample."""
        sid, jgi_id = "3300060590", "EC:3.6.1.23"
        jgi = enzyme_jgi_table.get(jgi_id, {}).get(sid)
        if jgi is None:
            pytest.skip(f"{jgi_id} not in JGI table for {sid}")
        if sid not in enzyme_by_sample:
            pytest.skip()
        backend = self._get_egc(enzyme_by_sample[sid], jgi_id)
        assert backend is not None, f"3.6.1.23 not found in {sid}.enzyme.json"
        assert egc_within_tolerance(backend, jgi), \
            f"EC:3.6.1.23/{sid}: backend={backend:.1f}, JGI={jgi:.1f}"

    @pytest.mark.parametrize("jgi_ann_id", [
        "EC:3.6.1.23",   # dUTP diphosphatase
        "EC:1.1.1.1",    # alcohol dehydrogenase
        "EC:6.1.1.20",   # phenylalanine--tRNA ligase
        "EC:1.1.1.94",   # glycerol-3-phosphate dehydrogenase
        "EC:1.1.1.100",  # 3-oxoacyl-ACP reductase
    ])
    def test_spot_enzymes_spot_sample(self, enzyme_by_sample, enzyme_jgi_table, jgi_ann_id):
        sid = "3300060590"
        jgi = enzyme_jgi_table.get(jgi_ann_id, {}).get(sid)
        if jgi is None:
            pytest.skip(f"{jgi_ann_id} not in JGI table for {sid}")
        if sid not in enzyme_by_sample:
            pytest.skip()
        backend = self._get_egc(enzyme_by_sample[sid], jgi_ann_id)
        if backend is None:
            pytest.skip(f"{jgi_ann_id} absent from JSON")
        assert egc_within_tolerance(backend, jgi), \
            f"{jgi_ann_id}/{sid}: backend={backend:.1f}, JGI={jgi:.1f}"

    def test_ec1_1_1_1_all_128_samples(self, enzyme_by_sample, enzyme_jgi_table):
        """Alcohol dehydrogenase (EC:1.1.1.1) must match JGI for every sample."""
        jgi_id  = "EC:1.1.1.1"
        jgi_row = enzyme_jgi_table.get(jgi_id, {})
        if not jgi_row:
            pytest.skip(f"{jgi_id} not in JGI table")
        mismatches: list[str] = []
        for sid, jgi_val in jgi_row.items():
            if sid not in enzyme_by_sample:
                continue
            backend = self._get_egc(enzyme_by_sample[sid], jgi_id)
            if backend is None:
                continue
            if not egc_within_tolerance(backend, jgi_val):
                tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                mismatches.append(
                    f"  {sid}: backend={backend:.1f}, JGI={jgi_val:.1f}, "
                    f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                )
        assert not mismatches, \
            f"EC:1.1.1.1 mismatches ({len(mismatches)}):\n" + "\n".join(mismatches)

    def test_all_jgi_enzymes_spot_sample(self, enzyme_by_sample, enzyme_jgi_table):
        """Every leaf EC entry in both JGI table and JSON for the spot sample must match."""
        sid     = "3300060590"
        leaf_re = re.compile(r'^EC:\d+\.\d+\.\d+\.\d+$')
        if sid not in enzyme_by_sample:
            pytest.skip()
        mismatches: list[str] = []
        compared = 0
        for jgi_id, row in enzyme_jgi_table.items():
            if not leaf_re.match(jgi_id):
                continue
            jgi_val = row.get(sid)
            if jgi_val is None:
                continue
            backend = self._get_egc(enzyme_by_sample[sid], jgi_id)
            if backend is None:
                continue
            compared += 1
            if not egc_within_tolerance(backend, jgi_val):
                tol = max(EGC_ABS_FLOOR, jgi_val * EGC_PCT_TOLERANCE)
                mismatches.append(
                    f"  {jgi_id}: backend={backend:.1f}, JGI={jgi_val:.1f}, "
                    f"diff={abs(backend-jgi_val):.1f}, tol={tol:.1f}"
                )
            if len(mismatches) >= 20:
                break
        assert compared > 0, "No Enzyme leaf IDs matched between JGI table and JSON"
        assert not mismatches, \
            f"Enzyme EGC mismatches for {sid} ({len(mismatches)}):\n" + "\n".join(mismatches)

    def test_only_depth4_entries_compared_to_jgi(self, enzyme_by_sample):
        """Fully-specified leaf EC numbers (X.X.X.X) must all be at depth=4."""
        sid      = "3300060590"
        leaf_pat = re.compile(r'^\d+\.\d+\.\d+\.\d+$')
        if sid not in enzyme_by_sample:
            pytest.skip()
        wrong = [
            (k, e.get("depth")) for k, e in enzyme_by_sample[sid].items()
            if isinstance(e, dict) and leaf_pat.match(k) and e.get("depth") != 4
        ]
        assert not wrong, f"X.X.X.X Enzyme entries with depth ≠ 4: {wrong[:5]}"


# ═══════════════════════════════════════════════════════════════════════════════
# 12. norm_egc formula correctness (KEGG; same denominator for all types)
# ═══════════════════════════════════════════════════════════════════════════════

class TestNormEgc:
    """
    norm_egc = Σ (gene_count × (scaffold_coverage / total_sample_depth))
             = egc / total_sample_depth

    total_sample_depth is the sum of AvgFold across ALL scaffolds in the
    sample (allfold[sample]['total']), not just the scaffolds for this
    annotation.  These two forms are algebraically identical.

    Verified three ways:
      (a) norm/egc ratio is uniform across all depth-4 entries in a sample
      (b) ratio matches the actual .a.depth file total
      (c) norm_egc is in (0, 1]

    KEGG is used as the reference type.  The same depth denominator is used
    for all annotation sources in the same sample.
    """

    SPOT_SAMPLE = "3300060590"

    def test_norm_egc_ratio_uniform_within_sample(self, kegg_by_sample):
        """norm/egc must be the same constant for every depth-4 KO entry."""
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        ref_k: Optional[float] = None
        bad:   list[str]       = []
        for node_id, entry in kegg_by_sample[sid].items():
            if not isinstance(entry, dict) or entry.get("depth") != 4:
                continue
            egc  = entry.get("egc")
            norm = entry.get("norm_egc")
            if not egc or norm is None or float(egc) == 0:
                continue
            k = float(norm) / float(egc)
            if ref_k is None:
                ref_k = k
            elif abs(k - ref_k) > NORM_TOLERANCE:
                bad.append(f"  {node_id}: k={k:.12f} ≠ ref={ref_k:.12f}")
                if len(bad) >= 5:
                    break
        assert not bad, f"norm_egc/egc not uniform in {sid}:\n" + "\n".join(bad)

    def test_norm_egc_matches_depth_file(self):
        """total_sample_depth is now the shared, cross-source
        weighted_totals[sample] from Notebooks/weighted_totals.py -- NOT
        the plain Σ(AvgFold) that parse_depth_file() returns (that helper
        is explicitly documented in conftest.py as the OLD, superseded
        denominator; it must not be used as ground truth here)."""
        sid = self.SPOT_SAMPLE

        ko_json = KEGG_JSON_DIR / f"{sid}.ko.json"
        if not ko_json.exists():
            pytest.skip()
        data = json.loads(ko_json.read_text())

        notebooks_dir = str(DATA_ROOT / "Notebooks")
        if notebooks_dir not in sys.path:
            sys.path.insert(0, notebooks_dir)
        try:
            from weighted_totals import calculate_denominator_egc
        except ImportError:
            pytest.skip("weighted_totals.py not importable (real data root required)")

        total = calculate_denominator_egc([sid])[sid]
        assert total > 0

        violations: list[str] = []
        for node_id, entry in data.items():
            if not isinstance(entry, dict) or entry.get("depth") != 4:
                continue
            egc  = entry.get("egc")
            norm = entry.get("norm_egc")
            if egc is None or norm is None:
                continue
            expected = float(egc) / total
            if abs(float(norm) - expected) > NORM_TOLERANCE:
                violations.append(
                    f"  {node_id}: norm={norm:.12f}, egc/total={expected:.12f}"
                )
                if len(violations) >= 5:
                    break
        assert not violations, \
            f"norm_egc ≠ egc/total for {sid}:\n" + "\n".join(violations)

    def test_norm_egc_in_valid_range(self, kegg_by_sample):
        """norm_egc must be in (0, 1]."""
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        violations: list[str] = []
        for node_id, entry in kegg_by_sample[sid].items():
            if not isinstance(entry, dict):
                continue
            norm = entry.get("norm_egc")
            if norm is None:
                continue
            v = float(norm)
            if v <= 0 or v > 1.0 + NORM_TOLERANCE:
                violations.append(f"  {node_id}: norm_egc={v}")
                if len(violations) >= 5:
                    break
        assert not violations, \
            f"norm_egc out of (0, 1] in {sid}:\n" + "\n".join(violations)

    def test_cog_and_kegg_share_same_depth_denominator(self, kegg_by_sample, cog_by_sample):
        """COG and KEGG for the same sample must use the same total_depth denominator."""
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample or sid not in cog_by_sample:
            pytest.skip()

        def _first_ratio(data: dict) -> Optional[float]:
            for e in data.values():
                if isinstance(e, dict):
                    egc  = e.get("egc")
                    norm = e.get("norm_egc")
                    if egc and norm and float(egc) > 0:
                        return float(norm) / float(egc)
            return None

        k_kegg = _first_ratio(kegg_by_sample[sid])
        k_cog  = _first_ratio(cog_by_sample[sid])
        if k_kegg is None or k_cog is None:
            pytest.skip("Insufficient data for cross-type check")
        assert abs(k_kegg - k_cog) <= NORM_TOLERANCE, \
            f"KEGG and COG use different denominators: kegg={k_kegg:.12f}, cog={k_cog:.12f}"

    def test_enzyme_and_kegg_share_same_depth_denominator(self, kegg_by_sample, enzyme_by_sample):
        """Enzyme and KEGG for the same sample must use the same total_depth denominator."""
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample or sid not in enzyme_by_sample:
            pytest.skip()

        def _first_ratio(data: dict) -> Optional[float]:
            for e in data.values():
                if isinstance(e, dict):
                    egc  = e.get("egc")
                    norm = e.get("norm_egc")
                    if egc and norm and float(egc) > 0:
                        return float(norm) / float(egc)
            return None

        k_kegg   = _first_ratio(kegg_by_sample[sid])
        k_enzyme = _first_ratio(enzyme_by_sample[sid])
        if k_kegg is None or k_enzyme is None:
            pytest.skip("Insufficient data for cross-type check")
        assert abs(k_kegg - k_enzyme) <= NORM_TOLERANCE, \
            f"KEGG and Enzyme use different denominators: kegg={k_kegg:.12f}, enzyme={k_enzyme:.12f}"


# ═══════════════════════════════════════════════════════════════════════════════
# 13. Ancestor aggregation — EGC of parent ≥ EGC of child
# ═══════════════════════════════════════════════════════════════════════════════

class TestAncestorAggregation:
    """
    Parent nodes accumulate all descendant scaffolds, so parent EGC ≥ child EGC.
    Verified for KEGG, COG, Enzyme, and Taxonomy.
    """

    SPOT_SAMPLE = "3300060590"

    def _check_parent_geq_child(self, data: dict, label: str, parent_key: str = "parent_id") -> list[str]:
        violations: list[str] = []
        for node_id, entry in data.items():
            if not isinstance(entry, dict):
                continue
            parent_id = entry.get(parent_key)
            if parent_id is None or parent_id not in data:
                continue
            child_egc  = float(entry.get("egc", 0))
            parent_egc = float(data[parent_id].get("egc", 0))
            if parent_egc < child_egc - 1e-6:
                violations.append(
                    f"  {node_id} (egc={child_egc:.2f}) > parent {parent_id} (egc={parent_egc:.2f})"
                )
                if len(violations) >= 5:
                    break
        return violations

    def test_kegg_parent_egc_geq_child_egc(self, kegg_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        v = self._check_parent_geq_child(kegg_by_sample[sid], "KEGG")
        assert not v, "KEGG parent EGC < child EGC:\n" + "\n".join(v)

    def test_cog_parent_egc_geq_child_egc(self, cog_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        v = self._check_parent_geq_child(cog_by_sample[sid], "COG")
        assert not v, "COG parent EGC < child EGC:\n" + "\n".join(v)

    def test_enzyme_parent_egc_geq_child_egc(self, enzyme_by_sample):
        sid = self.SPOT_SAMPLE
        if sid not in enzyme_by_sample:
            pytest.skip()
        v = self._check_parent_geq_child(enzyme_by_sample[sid], "Enzyme")
        assert not v, "Enzyme parent EGC < child EGC:\n" + "\n".join(v)

    def test_taxonomy_parent_egc_geq_child_egc(self):
        """
        Same aggregation invariant as KEGG/COG/Enzyme, but taxonomy stores its
        parent link under 'parent' (a taxon lineage-prefix string) rather than
        'parent_id' — see TestTaxonomyFormat.test_entries_use_parent_not_parent_id.

        Previously known-failing: the tree was keyed by bare taxon name only,
        and the same bare name can legitimately be reachable via more than one
        distinct immediate predecessor across different gene rows (confirmed
        649 / 4,475,518 violations, ~0.0145%, across all 128 samples). Fixed
        by re-keying EGC_TAX_TREE.ipynb's tree by full lineage prefix instead
        of bare name (e.g. "Bacteria;Bacteroidetes" instead of just
        "Bacteroidetes") — verified 0 / 4,483,100 violations across all 128
        samples after the fix (2026-09-02).

        This is a distinct check from "child present but its parent missing
        from the file entirely" — that scenario is structurally prevented by
        the tree-building loop (every prefix of every taxonomy path is
        registered as a node for the same sample in the same pass) and
        confirmed absent in all 128 files by test_parent_value_is_a_key_in_same_file
        and test_ancestor_chain_reaches_root_no_cycles below, both of which pass.
        """
        if not TAXONOMY_JSON_DIR.exists():
            pytest.skip("Taxonomy JSON directory missing")
        path = TAXONOMY_JSON_DIR / f"{self.SPOT_SAMPLE}.tax.json"
        if not path.exists():
            pytest.skip(f"{path} not found")
        data = json.loads(path.read_text())
        v = self._check_parent_geq_child(data, "Taxonomy", parent_key="parent")
        assert not v, "Taxonomy parent EGC < child EGC:\n" + "\n".join(v)

    def test_kegg_depth1_root_egc_exceeds_max_depth4(self, kegg_by_sample):
        """A depth-1 KEGG root should have higher EGC than any single KO in its category."""
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        data = kegg_by_sample[sid]

        max_ko_by_cat: dict[str, float] = {}
        for entry in data.values():
            if isinstance(entry, dict) and entry.get("depth") == 4:
                cat = entry.get("category", "")
                max_ko_by_cat[cat] = max(max_ko_by_cat.get(cat, 0), float(entry.get("egc", 0)))

        root_egc_by_cat: dict[str, float] = {}
        for entry in data.values():
            if isinstance(entry, dict) and entry.get("depth") == 1:
                cat = entry.get("category", "")
                root_egc_by_cat[cat] = float(entry.get("egc", 0))

        violations: list[str] = []
        for cat, max_ko in max_ko_by_cat.items():
            root = root_egc_by_cat.get(cat)
            if root is None:
                continue
            if root < max_ko - 1e-6:
                violations.append(f"  '{cat}': root={root:.2f} < max_ko={max_ko:.2f}")
        assert not violations, "Depth-1 KEGG root EGC < descendant KO EGC:\n" + "\n".join(violations)

    def test_scaffold_counts_consistent_with_egc_sign_kegg(self, kegg_by_sample):
        """Any KEGG entry with egc > 0 must have at least one scaffold."""
        sid = self.SPOT_SAMPLE
        if sid not in kegg_by_sample:
            pytest.skip()
        v = []
        for node_id, entry in kegg_by_sample[sid].items():
            if not isinstance(entry, dict):
                continue
            if float(entry.get("egc", 0)) > 0 and not entry.get("scaffolds"):
                v.append(f"  {node_id}: egc={entry['egc']:.2f} but scaffolds empty")
                if len(v) >= 5:
                    break
        assert not v, "KEGG entries with egc>0 but no scaffolds:\n" + "\n".join(v)

    def test_scaffold_counts_consistent_with_egc_sign_cog(self, cog_by_sample):
        """Any COG entry with egc > 0 must have at least one scaffold."""
        sid = self.SPOT_SAMPLE
        if sid not in cog_by_sample:
            pytest.skip()
        v = []
        for node_id, entry in cog_by_sample[sid].items():
            if not isinstance(entry, dict):
                continue
            if float(entry.get("egc", 0)) > 0 and not entry.get("scaffolds"):
                v.append(f"  {node_id}: egc={entry['egc']:.2f} but scaffolds empty")
                if len(v) >= 5:
                    break
        assert not v, "COG entries with egc>0 but no scaffolds:\n" + "\n".join(v)

    def test_scaffold_counts_consistent_with_egc_sign_enzyme(self, enzyme_by_sample):
        """Any Enzyme entry with egc > 0 must have at least one scaffold."""
        sid = self.SPOT_SAMPLE
        if sid not in enzyme_by_sample:
            pytest.skip()
        v = []
        for node_id, entry in enzyme_by_sample[sid].items():
            if not isinstance(entry, dict):
                continue
            if float(entry.get("egc", 0)) > 0 and not entry.get("scaffolds"):
                v.append(f"  {node_id}: egc={entry['egc']:.2f} but scaffolds empty")
                if len(v) >= 5:
                    break
        assert not v, "Enzyme entries with egc>0 but no scaffolds:\n" + "\n".join(v)
