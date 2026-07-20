"""
test_scaffold_ground_truth.py
==============================
Ground-truth verification for the ``scaffolds`` field baked into each
annotation type's per-sample JSON (DataStructures/{COG,Kegg,Enzyme,Taxonomy}).

Independently rebuilds scaffold -> gene-count tallies straight from the raw
IMG per-sample annotation files (Metagenome_Samples/<sample>/<sample>.a.*.txt)
and asserts the built JSON's ``scaffolds`` dict for a random sample of
annotations matches exactly.

This does NOT re-test aggregation/API logic (see test_main_scaffolds.py) or
EGC values against JGI (see test_egc_api_vs_jgi.py). It tests one specific
thing: does gene_id -> annotation_id -> scaffold parsing, as baked into the
JSON on disk, match the raw per-gene annotation rows exactly.

Raw file layout (columns are tab-separated, gene_id is always column 0):
    .a.ko.txt        col0=gene_id  col2="KO:K#####"
    .a.cog.txt       col0=gene_id  col1="COG####"
    .a.ec.txt        col0=gene_id  col2="EC:#.#.#.#"
    .a.phylodist.txt col0=gene_id  last col=semicolon-joined lineage

scaffold = gene_id.rsplit("_", 2)[0]  (drops the trailing start_end
coordinate pair, e.g. "Ga0590986_0000001_3_974" -> "Ga0590986_0000001")

Only "leaf" annotations -- the ones that map to exactly one raw label -- are
checked. Ancestor/category nodes (KEGG BRITE categories, Enzyme EC prefixes,
Taxonomy higher ranks) aggregate scaffolds across many raw labels and are
intentionally excluded.

Known limitation
-----------------
Taxonomy nodes are keyed by bare rank name, not full lineage path, so two
different lineages that share a leaf name collide in the built JSON (see
memory: taxonomy_egc_homonym_bug). A Taxonomy mismatch here may reflect that
pre-existing, documented issue rather than a new scaffold-parsing bug --
check whether the reconstructed lineage is one of the known homonyms before
treating a failure as new.

Run:
    pytest tests/test_scaffold_ground_truth.py -v
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

import pytest

from conftest import COG_JSON_DIR, DATA_ROOT, KEGG_JSON_DIR, METAGENOME_SAMPLES_DIR

ENZYME_JSON_DIR: Path   = DATA_ROOT / "DataStructures" / "Enzyme"
TAXONOMY_JSON_DIR: Path = DATA_ROOT / "DataStructures" / "Taxonomy"

# Kept small deliberately -- Taxonomy's raw file alone is ~100MB per sample.
# Every leaf annotation in these samples is checked (not a subset) -- once
# the raw file is parsed, comparing every key instead of a sample of them
# costs virtually nothing extra.
SAMPLE_IDS = ["3300060358", "3300060410"]

_KO_LEAF_RE = re.compile(r"^K\d{5}$")


def _scaffold_of(gene_id: str) -> str:
    return gene_id.rsplit("_", 2)[0]


def _raw_path(sample: str, suffix: str) -> Path:
    return METAGENOME_SAMPLES_DIR / sample / f"{sample}.a.{suffix}.txt"


# ── Raw-file tally builders (the ground truth) ───────────────────────────
#
# The pipeline counts each *gene* once per (annotation, sample), even if that
# gene has multiple raw hit-lines against the same annotation (e.g. two HMM
# domain hits on the same gene). See EGC_COG_TREE.ipynb / EGC_*_TREE.ipynb:
#     if gene_id not in tp['genes']: tp['scaffolds'][scaff] += 1
# So these tallies first collect the *set* of distinct gene_ids per
# annotation, then convert to scaffold counts -- counting raw lines directly
# would double-count genes with multiple hits and produce false mismatches.

def _dedup_gene_tally(gene_ids_by_annotation: dict[str, set[str]]) -> dict[str, dict[str, int]]:
    tally: dict[str, dict[str, int]] = {}
    for ann_id, gene_ids in gene_ids_by_annotation.items():
        scaffold_counts: dict[str, int] = defaultdict(int)
        for gene_id in gene_ids:
            scaffold_counts[_scaffold_of(gene_id)] += 1
        tally[ann_id] = dict(scaffold_counts)
    return tally


def _tally_cog(sample: str) -> dict[str, dict[str, int]]:
    genes: dict[str, set[str]] = defaultdict(set)
    with _raw_path(sample, "cog").open(encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            gene_id, cog_id = parts[0], parts[1]
            genes[cog_id].add(gene_id)
    return _dedup_gene_tally(genes)


def _tally_kegg(sample: str) -> dict[str, dict[str, int]]:
    genes: dict[str, set[str]] = defaultdict(set)
    with _raw_path(sample, "ko").open(encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            gene_id, ko_id = parts[0], parts[2]
            if ko_id.startswith("KO:"):
                ko_id = ko_id[3:]
            genes[ko_id].add(gene_id)
    return _dedup_gene_tally(genes)


def _tally_enzyme(sample: str) -> dict[str, dict[str, int]]:
    genes: dict[str, set[str]] = defaultdict(set)
    with _raw_path(sample, "ec").open(encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            gene_id, ec_id = parts[0], parts[2]
            if ec_id.startswith("EC:"):
                ec_id = ec_id[3:]
            genes[ec_id].add(gene_id)
    return _dedup_gene_tally(genes)


def _tally_taxonomy(sample: str) -> dict[str, dict[str, int]]:
    """Keyed by the FULL semicolon-joined lineage path, not the bare leaf name."""
    genes: dict[str, set[str]] = defaultdict(set)
    with _raw_path(sample, "phylodist").open(encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            gene_id, full_path = parts[0], parts[-1].strip()
            genes[full_path].add(gene_id)
    return _dedup_gene_tally(genes)


_TALLY_FUNCS = {
    "cog": _tally_cog,
    "kegg": _tally_kegg,
    "enzyme": _tally_enzyme,
    "taxonomy": _tally_taxonomy,
}


@pytest.fixture(scope="module")
def raw_tally():
    """Cache raw-file tallies per (source, sample) -- these files are large."""
    cache: dict[tuple[str, str], dict[str, dict[str, int]]] = {}

    def _get(source: str, sample: str) -> dict[str, dict[str, int]]:
        key = (source, sample)
        if key not in cache:
            cache[key] = _TALLY_FUNCS[source](sample)
        return cache[key]

    return _get


# ── Built-JSON loading ────────────────────────────────────────────────────

def _load_json(directory: Path, sample: str, suffix: str) -> dict:
    with (directory / f"{sample}.{suffix}.json").open(encoding="utf-8") as fh:
        return json.load(fh)


def _reconstruct_taxonomy_path(tree: dict, leaf_key: str) -> str:
    """Walk a Taxonomy node's `parent` chain back to the root."""
    chain: list[str] = []
    node_id: str | None = leaf_key
    seen: set[str] = set()
    while node_id is not None and node_id not in seen:
        seen.add(node_id)
        chain.append(node_id)
        node_id = tree.get(node_id, {}).get("parent")
    return ";".join(reversed(chain))


# ── Tests ─────────────────────────────────────────────────────────────────

class TestCOGScaffoldsMatchRawFile:
    """COG is a flat annotation set -- every key is directly comparable."""

    @pytest.mark.parametrize("sample", SAMPLE_IDS)
    def test_all_cogs_match_raw_file(self, raw_tally, sample):
        tree  = _load_json(COG_JSON_DIR, sample, "cog")
        truth = raw_tally("cog", sample)

        candidates = [k for k in tree if k in truth]
        assert candidates, f"No comparable COG ids for {sample}"

        mismatches = []
        for cog_id in candidates:
            built    = tree[cog_id].get("scaffolds", {})
            expected = truth[cog_id]
            if built != expected:
                mismatches.append((cog_id, built, expected))

        assert not mismatches, (
            f"COG scaffold mismatches in {sample} "
            f"({len(mismatches)}/{len(candidates)}): {mismatches[:10]}"
        )


class TestKEGGScaffoldsMatchRawFile:
    """Only bare 'K#####' keys are leaves -- BRITE category nodes aggregate."""

    @pytest.mark.parametrize("sample", SAMPLE_IDS)
    def test_all_kos_match_raw_file(self, raw_tally, sample):
        tree  = _load_json(KEGG_JSON_DIR, sample, "ko")
        truth = raw_tally("kegg", sample)

        leaf_ids = [k for k in tree if _KO_LEAF_RE.match(k) and k in truth]
        assert leaf_ids, f"No comparable KO leaf ids for {sample}"

        mismatches = []
        for ko_id in leaf_ids:
            built    = tree[ko_id].get("scaffolds", {})
            expected = truth[ko_id]
            if built != expected:
                mismatches.append((ko_id, built, expected))

        assert not mismatches, (
            f"KEGG scaffold mismatches in {sample} "
            f"({len(mismatches)}/{len(leaf_ids)}): {mismatches[:10]}"
        )


class TestEnzymeScaffoldsMatchRawFile:
    """Only depth-4 nodes are full EC numbers -- depth 1-3 are ancestor prefixes."""

    @pytest.mark.parametrize("sample", SAMPLE_IDS)
    def test_all_ecs_match_raw_file(self, raw_tally, sample):
        tree  = _load_json(ENZYME_JSON_DIR, sample, "enzyme")
        truth = raw_tally("enzyme", sample)

        leaf_ids = [k for k, v in tree.items() if v.get("depth") == 4 and k in truth]
        assert leaf_ids, f"No comparable Enzyme leaf ids for {sample}"

        mismatches = []
        for ec_id in leaf_ids:
            built    = tree[ec_id].get("scaffolds", {})
            expected = truth[ec_id]
            if built != expected:
                mismatches.append((ec_id, built, expected))

        assert not mismatches, (
            f"Enzyme scaffold mismatches in {sample} "
            f"({len(mismatches)}/{len(leaf_ids)}): {mismatches[:10]}"
        )


class TestTaxonomyScaffoldsMatchRawFile:
    """
    Leaves are keys that never appear as another node's `parent`. Full lineage
    is reconstructed from the parent chain since built keys are bare names.

    See module docstring: failures here can be the pre-existing homonym bug,
    not a new scaffold-parsing bug.
    """

    @pytest.mark.xfail(
        reason=(
            "Known homonym bug (see memory: taxonomy_egc_homonym_bug): bare-name "
            "tree keying collides distinct lineages that share a leaf name (e.g. "
            "'Bacteroides sp. AR20' picking up scaffolds from a second, different "
            "lineage). Affects ~0.0145% of leaf taxa across all 128 samples. "
            "Remove this xfail once the tree is keyed by full lineage path instead "
            "of bare name."
        ),
        strict=True,
    )
    @pytest.mark.parametrize("sample", SAMPLE_IDS)
    def test_all_leaf_taxa_match_raw_file(self, raw_tally, sample):
        tree  = _load_json(TAXONOMY_JSON_DIR, sample, "tax")
        truth = raw_tally("taxonomy", sample)

        parent_keys = {v.get("parent") for v in tree.values() if v.get("parent")}
        leaf_keys   = [k for k in tree if k not in parent_keys]
        assert leaf_keys, f"No leaf taxa found for {sample}"

        mismatches = []
        skipped    = 0
        for leaf in leaf_keys:
            full_path = _reconstruct_taxonomy_path(tree, leaf)
            if full_path not in truth:
                skipped += 1
                continue
            built    = tree[leaf].get("scaffolds", {})
            expected = truth[full_path]
            if built != expected:
                mismatches.append((leaf, full_path, built, expected))

        assert skipped < len(leaf_keys), (
            f"Could not reconstruct any raw lineage path for {sample} -- "
            "check parent-chain logic"
        )
        assert not mismatches, (
            f"Taxonomy scaffold mismatches in {sample} "
            f"({len(mismatches)}/{len(leaf_keys) - skipped}, check for "
            f"homonym-bug lineages first): {mismatches[:10]}"
        )
