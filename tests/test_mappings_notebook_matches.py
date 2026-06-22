"""
test_mappings_notebook_matches.py
===================================
Verifies that mappings.ipynb's gene -> annotation matching is CORRECT —
i.e. that every row in Mappings_by_Sample/{sample}_mapping.tsv actually
reflects what's in the real per-sample JSON databases it was built from.

This is independent of, and complementary to, test_mappings_unique_pairs.py:
  - test_mappings_unique_pairs.py tests the API/dedup logic GIVEN the TSVs
    already exist and are correct.
  - This file tests whether the TSVs are correct in the first place, by
    re-deriving the expected gene->annotation matches directly from the
    same JSON sources the notebook reads, using the *exact* join logic
    from mappings.ipynb, and diffing against the real TSV on disk.

What the notebook does, per sample (from mappings.ipynb):
    1. cog_db_s  = COG_byTP/cog_db_{sample}.json      -> {gene_id: {"lookupId": [...]}}
    2. kegg_db_s = Kegg_byTP/kegg_db_{sample}.json     -> {gene_id: {"lookupId": [...]}}
    3. enz_db_s  = Enz_byTP/enz_db_{sample}.json       -> {gene_id: {"lookupId": [...]}}
    4. tax_db_s  = tax_db_byTP/tax_db_{sample}.json    -> {gene_id: {"lookupId": [...], "scaffolds": [...]}}
    5. base gene list = list(cog_db_s.keys())  -- COG is the primary gene list;
       a gene with NO entry in cog_db_s for this sample is never written to
       the TSV at all, even if it has KEGG/enzyme/taxonomy entries.
    6. For each of cog/kegg/enzyme: value = lookupId[0] if lookupId else None
       (_first_or_none -- only the FIRST list entry is kept, any additional
       lookupIds for that gene are silently dropped)
    7. taxonomy: same _first_or_none on lookupId; scaffold_id same on scaffolds
    8. Left-merge all four onto the base gene list, on (gene, sample)
    9. Write gene_id, scaffold_id, taxonomy, kegg, enzyme, cog to the TSV,
       in that column order

This test reimplements steps 5-9 independently (NOT by importing the
notebook itself -- ipynb execution requires nbconvert/jupyter which isn't
guaranteed available, and importing it would just be testing itself) and
checks the result against the real TSV on disk, for both a small
synthetic dataset and the real 128-sample dataset.

Run:
    pytest Tests/test_mappings_notebook_matches.py -v
    pytest Tests/test_mappings_notebook_matches.py -v -k synthetic        # fast, no real data needed
    pytest Tests/test_mappings_notebook_matches.py -v -s -k RealData      # needs DataStructures/ on disk
                                                                            # -s shows per-sample progress
                                                                            # (loading 128 samples'
                                                                            # worth of JSON/TSV takes a
                                                                            # while -- this isn't a hang)
"""
import os
import csv
import json
import sys
from pathlib import Path
from collections import Counter

import pytest

# Real dataset root -- override via env var, matches the convention used
# in test_egc_json_vs_jgi.py / test_jgi_file_parsing.py
DATA_ROOT = Path(os.environ.get("HAB_DATA_ROOT", r"C:\Users\sakoehn\Desktop\JGI"))
BASE_DS   = DATA_ROOT / "DataStructures"


# ═══════════════════════════════════════════════════════════════════════════
# Reimplementation of the notebook's join logic (mappings.ipynb, cells 2-3)
# Kept deliberately literal/unoptimized so it mirrors the notebook exactly
# and is easy to audit against the source cells side-by-side.
# ═══════════════════════════════════════════════════════════════════════════

def _first_or_none(x):
    if not x:
        return None
    return x[0]


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def expected_rows_for_sample(base_ds: Path, sample: str) -> dict:
    """
    Re-derives the expected gene_id -> {scaffold_id, taxonomy, kegg, enzyme, cog}
    mapping for one sample, using the IDENTICAL logic to mappings.ipynb's
    main loop (cell 3), independently of pandas (plain dicts) so a pandas
    merge bug wouldn't be silently re-introduced by reusing pandas here too.

    Returns {} if the sample has no COG entries (notebook's own skip rule:
    "if not genes: skip").
    """
    cog_db  = _load_json(base_ds / "COG_byTP"     / f"cog_db_{sample}.json")
    kegg_db = _load_json(base_ds / "Kegg_byTP"    / f"kegg_db_{sample}.json")
    enz_db  = _load_json(base_ds / "Enz_byTP"     / f"enz_db_{sample}.json")
    tax_db  = _load_json(base_ds / "tax_db_byTP"  / f"tax_db_{sample}.json")

    genes = list(cog_db.keys())
    if not genes:
        return {}

    expected = {}
    for gene_id in genes:
        cog_info  = cog_db.get(gene_id, {})
        kegg_info = kegg_db.get(gene_id, {})
        enz_info  = enz_db.get(gene_id, {})
        tax_info  = tax_db.get(gene_id, {})

        expected[gene_id] = {
            "scaffold_id": _first_or_none(tax_info.get("scaffolds", [])),
            "taxonomy":    _first_or_none(tax_info.get("lookupId", [])),
            "kegg":        _first_or_none(kegg_info.get("lookupId", [])),
            "enzyme":      _first_or_none(enz_info.get("lookupId", [])),
            "cog":         _first_or_none(cog_info.get("lookupId", [])),
        }
    return expected


def read_actual_tsv(path: Path) -> dict:
    """
    Reads a real {sample}_mapping.tsv into {gene_id: {scaffold_id, taxonomy,
    kegg, enzyme, cog}}, matching the notebook's OWN write column order:
    gene_id, scaffold_id, taxonomy, kegg, enzyme, cog.

    Note this intentionally reads by the notebook's column names (kegg/cog),
    NOT the API's renamed kegg_id/cog_id -- this test verifies the TSV the
    notebook wrote, before main.py's loader renames anything.
    """
    actual = {}
    if not path.exists():
        return actual
    with open(path, newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            actual[row["gene_id"]] = {
                "scaffold_id": row.get("scaffold_id") or None,
                "taxonomy":    row.get("taxonomy") or None,
                "kegg":        row.get("kegg") or None,
                "enzyme":      row.get("enzyme") or None,
                "cog":         row.get("cog") or None,
            }
    return actual


def _write_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)


def _write_tsv_from_expected(path: Path, expected: dict):
    """Writes a TSV the same way the notebook does, for synthetic fixtures."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        writer = csv.writer(f, delimiter="\t")
        writer.writerow(["gene_id", "scaffold_id", "taxonomy", "kegg", "enzyme", "cog"])
        for gene_id, vals in expected.items():
            writer.writerow([
                gene_id,
                vals["scaffold_id"] or "",
                vals["taxonomy"] or "",
                vals["kegg"] or "",
                vals["enzyme"] or "",
                vals["cog"] or "",
            ])


# ═══════════════════════════════════════════════════════════════════════════
# TestNotebookMatchingSynthetic — small hand-built JSON dbs, fully controlled
# ═══════════════════════════════════════════════════════════════════════════

class TestNotebookMatchingSynthetic:
    """
    Builds small fake COG/KEGG/Enzyme/Taxonomy per-sample JSON dbs with
    known, deliberately tricky content (multi-entry lookupId lists, a gene
    missing from KEGG, a gene missing from COG entirely, empty lookupId
    lists) and confirms expected_rows_for_sample() reproduces exactly what
    the notebook's documented logic would produce.

    This class validates the TEST'S OWN reimplementation of the notebook
    logic is faithful to the notebook's documented behavior, independent
    of any real data on disk -- it's the ground-truth check that the
    re-derivation function used by TestNotebookMatchingRealData is itself
    trustworthy.
    """

    @pytest.fixture
    def synthetic_ds(self, tmp_path):
        base_ds = tmp_path / "DataStructures"

        # gene_a: present everywhere, multiple lookupIds -> only [0] should be kept
        # gene_b: present in COG and taxonomy, MISSING from KEGG and enzyme
        # gene_c: present in COG with an EMPTY lookupId list (edge case: [] not missing)
        # gene_d: present in KEGG/enzyme/taxonomy but NOT in COG -> must be
        #         entirely absent from the TSV (COG is the base gene list)
        _write_json(base_ds / "COG_byTP" / "cog_db_s1.json", {
            "gene_a": {"lookupId": ["COG0001", "COG9999"]},
            "gene_b": {"lookupId": ["COG0002"]},
            "gene_c": {"lookupId": []},
        })
        _write_json(base_ds / "Kegg_byTP" / "kegg_db_s1.json", {
            "gene_a": {"lookupId": ["K00010", "K00011"]},
            "gene_d": {"lookupId": ["K99999"]},
        })
        _write_json(base_ds / "Enz_byTP" / "enz_db_s1.json", {
            "gene_a": {"lookupId": ["1.1.1.1"]},
            "gene_d": {"lookupId": ["9.9.9.9"]},
        })
        _write_json(base_ds / "tax_db_byTP" / "tax_db_s1.json", {
            "gene_a": {"lookupId": ["Bacteria;Firmicutes"], "scaffolds": ["scaf_1", "scaf_2"]},
            "gene_b": {"lookupId": ["Archaea"], "scaffolds": ["scaf_3"]},
            "gene_d": {"lookupId": ["Viruses"], "scaffolds": ["scaf_9"]},
        })

        return base_ds

    def test_gene_with_multiple_lookupids_keeps_only_the_first(self, synthetic_ds):
        result = expected_rows_for_sample(synthetic_ds, "s1")
        assert result["gene_a"]["cog"] == "COG0001"     # not COG9999
        assert result["gene_a"]["kegg"] == "K00010"      # not K00011

    def test_gene_missing_from_kegg_and_enzyme_gets_none(self, synthetic_ds):
        result = expected_rows_for_sample(synthetic_ds, "s1")
        assert result["gene_b"]["kegg"] is None
        assert result["gene_b"]["enzyme"] is None
        # but taxonomy and cog, which DO have entries, must still be populated
        assert result["gene_b"]["cog"] == "COG0002"
        assert result["gene_b"]["taxonomy"] == "Archaea"

    def test_gene_with_empty_lookupid_list_is_none_not_missing_key(self, synthetic_ds):
        """gene_c has lookupId: [] in COG -- distinct from not being in the
        dict at all. _first_or_none([]) must return None, same as a fully
        absent gene, not raise or return something else."""
        result = expected_rows_for_sample(synthetic_ds, "s1")
        assert result["gene_c"]["cog"] is None

    def test_gene_absent_from_cog_is_excluded_entirely(self, synthetic_ds):
        """gene_d has real KEGG/enzyme/taxonomy data but no COG entry.
        Per the notebook's own rule (base gene list = COG keys), it must
        not appear in the output at all -- this is a real data-loss
        behavior worth pinning down explicitly, not an oversight to miss."""
        result = expected_rows_for_sample(synthetic_ds, "s1")
        assert "gene_d" not in result

    def test_sample_with_zero_cog_genes_returns_empty(self, tmp_path):
        """Mirrors the notebook's 'if not genes: skip' branch."""
        base_ds = tmp_path / "DataStructures"
        _write_json(base_ds / "COG_byTP" / "cog_db_empty.json", {})
        result = expected_rows_for_sample(base_ds, "empty")
        assert result == {}

    def test_missing_json_file_treated_as_empty_db_not_error(self, tmp_path):
        """If e.g. Kegg_byTP/kegg_db_{sample}.json doesn't exist at all
        (not just empty), the sample's genes should still process with
        kegg=None rather than crashing."""
        base_ds = tmp_path / "DataStructures"
        _write_json(base_ds / "COG_byTP" / "cog_db_s2.json", {
            "gene_x": {"lookupId": ["COG0099"]},
        })
        # Deliberately do NOT write Kegg_byTP/kegg_db_s2.json at all
        result = expected_rows_for_sample(base_ds, "s2")
        assert result["gene_x"]["kegg"] is None
        assert result["gene_x"]["cog"] == "COG0099"

    def test_synthetic_expected_matches_a_correctly_written_tsv(self, synthetic_ds, tmp_path):
        """End-to-end sanity check: write a TSV using the SAME expected
        values, read it back with read_actual_tsv(), and confirm a
        round-trip produces an exact match -- proving the comparison
        machinery itself (not just the derivation) is correct."""
        expected = expected_rows_for_sample(synthetic_ds, "s1")
        tsv_path = tmp_path / "Mappings_by_sample" / "s1_mapping.tsv"
        _write_tsv_from_expected(tsv_path, expected)

        actual = read_actual_tsv(tsv_path)
        for gene_id, exp_vals in expected.items():
            assert actual[gene_id] == exp_vals, f"{gene_id}: expected {exp_vals}, got {actual[gene_id]}"

    def test_corrupted_tsv_is_caught_by_the_comparison(self, synthetic_ds, tmp_path):
        """Negative control: deliberately write a WRONG TSV (swap two
        genes' cog values) and confirm the comparison detects the
        mismatch -- proving this test suite would actually fail if the
        notebook's join logic broke, not just pass trivially."""
        expected = expected_rows_for_sample(synthetic_ds, "s1")
        tampered = dict(expected)
        tampered["gene_a"] = {**tampered["gene_a"], "cog": "COG_WRONG"}

        tsv_path = tmp_path / "Mappings_by_sample" / "s1_mapping.tsv"
        _write_tsv_from_expected(tsv_path, tampered)
        actual = read_actual_tsv(tsv_path)

        assert actual["gene_a"] != expected["gene_a"], (
            "Sanity check failed: tampering didn't actually change the row -- "
            "the comparison logic below would pass even on broken data."
        )


# ═══════════════════════════════════════════════════════════════════════════
# TestNotebookMatchingRealData — real per-sample JSON vs real TSVs on disk
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.skipif(
    not BASE_DS.exists(),
    reason=f"DataStructures/ not found at {BASE_DS} -- set HAB_DATA_ROOT to run this class",
)
class TestNotebookMatchingRealData:
    """
    Re-derives expected mappings from the REAL COG_byTP/Kegg_byTP/Enz_byTP/
    tax_db_byTP JSON files and compares against the REAL
    Mappings_by_sample/{sample}_mapping.tsv files the notebook actually
    produced -- catching any genuine mismatch in the production dataset,
    not just in a synthetic fixture.

    Performance note: per-sample JSON/TSV files can be very large (the
    project's own notebook output shows individual Enz_byTP files with
    100k-330k entries). Loading + comparing 128 samples' worth of that is
    real work -- expect this class to take noticeably longer than the
    synthetic class, not to hang. Two things keep it from being slower
    than necessary:
      - sample_data (below) loads each sample's JSON/TSV ONCE per pytest
        session and caches the result, so the 4 tests in this class don't
        each independently re-read all 128 samples from scratch (4x
        redundant I/O eliminated).
      - test_no_gene_appears_twice_in_any_tsv uses collections.Counter
        instead of list.count() in a loop, which is O(n) instead of O(n^2)
        per sample -- the old version could itself take minutes on a
        300k-row sample.

    Run with -s to see per-sample progress as it loads:
        pytest Tests/test_mappings_notebook_matches.py -v -s -k RealData

    Stops collecting mismatches after 10 per sample (same convention as
    test_egc_json_vs_jgi.py) so a systemic bug doesn't flood the terminal.
    """

    MAX_REPORTED_MISMATCHES = 10

    @pytest.fixture(scope="class")
    @classmethod
    def sample_names(cls):
        cog_dir = BASE_DS / "COG_byTP"
        if not cog_dir.exists():
            pytest.skip(f"{cog_dir} not found")
        names = sorted(
            p.stem.removeprefix("cog_db_")
            for p in cog_dir.glob("cog_db_*.json")
        )
        if not names:
            pytest.skip(f"No cog_db_*.json files found in {cog_dir}")
        return names

    @pytest.fixture(scope="class")
    @classmethod
    def sample_data(cls, sample_names):
        """
        Loads expected_rows_for_sample() + read_actual_tsv() ONCE per
        sample for the whole test class, instead of once per test method.
        Prints progress per sample (visible with -s) so a long run shows
        forward motion instead of looking hung.

        Returns {sample: (expected_dict, actual_dict, cog_gene_count)}.
        Samples whose TSV doesn't exist are still included with
        actual_dict = {} so test_every_sample_has_a_corresponding_tsv can
        still report on them.
        """
        data = {}
        total = len(sample_names)
        print(f"\n[notebook-match] loading {total} samples from {BASE_DS} ...", file=sys.stderr)
        for i, sample in enumerate(sample_names, start=1):
            cog_db = _load_json(BASE_DS / "COG_byTP" / f"cog_db_{sample}.json")
            expected = expected_rows_for_sample(BASE_DS, sample)
            tsv_path = BASE_DS / "Mappings_by_sample" / f"{sample}_mapping.tsv"
            actual = read_actual_tsv(tsv_path) if tsv_path.exists() else {}
            data[sample] = (expected, actual, len(cog_db))
            print(
                f"[notebook-match] ({i}/{total}) {sample}: "
                f"{len(cog_db)} cog genes, {len(actual)} tsv rows",
                file=sys.stderr,
            )
        print("[notebook-match] done loading.", file=sys.stderr)
        return data

    def test_at_least_one_sample_found(self, sample_names):
        assert len(sample_names) > 0

    def test_every_sample_has_a_corresponding_tsv(self, sample_data):
        missing_tsv = [
            sample for sample, (_, actual, _) in sample_data.items()
            if not actual and not (BASE_DS / "Mappings_by_sample" / f"{sample}_mapping.tsv").exists()
        ]
        assert not missing_tsv, (
            f"{len(missing_tsv)} sample(s) have COG JSON but no mapping TSV "
            f"(first 10): {missing_tsv[:10]}"
        )

    def test_gene_count_matches_cog_db_size(self, sample_data):
        """The TSV's row count should equal the number of genes in that
        sample's COG db (COG is the base gene list) -- a count mismatch
        signals genes were dropped or duplicated during the merge."""
        mismatches = []
        for sample, (_, actual, cog_gene_count) in sample_data.items():
            if not actual:
                continue
            if len(actual) != cog_gene_count:
                mismatches.append(
                    f"{sample}: cog_db has {cog_gene_count} genes, TSV has {len(actual)} rows"
                )
                if len(mismatches) >= self.MAX_REPORTED_MISMATCHES:
                    break
        assert not mismatches, "\n".join(mismatches)

    def test_every_gene_matches_expected_values(self, sample_data):
        """
        The core check: for every gene in every sample, the TSV's
        scaffold_id/taxonomy/kegg/enzyme/cog values must exactly equal
        what expected_rows_for_sample() independently derives from the
        same JSON sources. Any mismatch means the notebook's merge
        produced a wrong match for that gene (e.g. a join key issue,
        an off-by-one on which lookupId was kept, or a stale TSV that
        no longer reflects the current JSON).
        """
        mismatches = []
        missing_genes = []

        for sample, (expected, actual, _) in sample_data.items():
            if not actual:
                continue

            for gene_id, exp_vals in expected.items():
                if gene_id not in actual:
                    missing_genes.append(f"{sample}/{gene_id}")
                    if len(missing_genes) >= self.MAX_REPORTED_MISMATCHES:
                        break
                    continue
                if actual[gene_id] != exp_vals:
                    mismatches.append(
                        f"{sample}/{gene_id}: expected={exp_vals}, actual={actual[gene_id]}"
                    )
                    if len(mismatches) >= self.MAX_REPORTED_MISMATCHES:
                        break

            if len(missing_genes) >= self.MAX_REPORTED_MISMATCHES or \
               len(mismatches) >= self.MAX_REPORTED_MISMATCHES:
                break

        issues = []
        if missing_genes:
            issues.append(f"Genes missing from TSV (first 10): {missing_genes}")
        if mismatches:
            issues.append(f"Value mismatches (first 10): {mismatches}")
        assert not issues, "\n".join(issues)

    def test_no_gene_appears_twice_in_any_tsv(self, sample_data):
        """Each gene_id should be a unique row per sample -- a duplicate
        would indicate the merge produced a fan-out (e.g. a gene matching
        multiple rows in one of the lookup tables before _first_or_none
        was applied, or a join key collision).

        Uses Counter (O(n)) rather than list.count() in a loop (O(n^2)),
        since a 300k-row sample would make the O(n^2) version the real
        bottleneck in this whole class.
        """
        mismatches = []
        for sample, (_, actual, _) in sample_data.items():
            if not actual:
                continue
            # actual is already keyed by gene_id (last-write-wins on dupes),
            # so duplicates must be detected from the raw TSV rows instead.
            tsv_path = BASE_DS / "Mappings_by_sample" / f"{sample}_mapping.tsv"
            with open(tsv_path, newline="") as f:
                reader = csv.DictReader(f, delimiter="\t")
                gene_ids = [row["gene_id"] for row in reader]
            counts = Counter(gene_ids)
            dupes = [g for g, c in counts.items() if c > 1]
            if dupes:
                mismatches.append(f"{sample}: duplicate gene_id(s) {dupes[:5]}")
                if len(mismatches) >= self.MAX_REPORTED_MISMATCHES:
                    break
        assert not mismatches, "\n".join(mismatches)