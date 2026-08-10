"""
test_mappings_notebook_matches.py
===================================
Verifies that the gene -> annotation mapping build is CORRECT -- i.e. that
every row in Mappings_by_Sample/{sample}_mapping.tsv actually reflects what's
in the REAL RAW per-gene JGI annotation files it should be built from.

This file was rewritten after two independent reviews of the mapping
pipeline found real, systemic data loss in the previous notebook-based
approach (mappings.ipynb + the COG/Kegg/Enz/tax_db_byTP intermediate JSONs):
  - The old base gene list was COG's gene set only, silently excluding any
    gene with real KEGG/Enzyme/Taxonomy data but no COG hit (measured:
    30-40% of genes per sample, systemic, not an edge case).
  - The old logic kept only the FIRST of a gene's multiple COG/Enzyme hits,
    silently dropping the rest (measured: ~27k genes with multiple COG
    hits, ~13k with multiple Enzyme hits, some genuinely distinct).
  - scaffold_id was sourced from taxonomy data instead of gene_id itself,
    losing the scaffold for any gene with no taxonomy hit.
This test file encodes the CORRECTED rules; test_taxon_paths.py-adjacent
work on the SQL branch also derives from these same raw files.

Corrected rules, verified against real data and JGI's own
Metagenome_Samples/<sample>/README.txt (IMG Pipeline v5.0 documentation):
  1. Base gene list = UNION of gene_ids across ALL FOUR raw per-gene files
     (a gene needs >=1 real hit in >=1 source to get a row -- a gene with
     zero hits anywhere has nothing to map, so it's correctly excluded;
     this is different from the old bug, which excluded genes that DO
     have real data just because that data wasn't in COG specifically).
  2. Per source, per gene: collapse to the SORTED, comma-joined SET of
     unique annotation IDs (not first-only, not raw-with-duplicates).
     Confirmed correct and consistent with how this app's existing
     canonical annotation builders (egc_cog_tree.py etc.) already dedupe.
  3. scaffold_id is parsed directly from gene_id (format
     "{scaffold}_{start}_{end}"), not sourced from taxonomy data.
  4. No evalue/percent_identity/bit_score filtering -- matches every
     existing canonical annotation source in this app; this is a
     deliberate consistency choice, not an oversight.

Raw file columns (Metagenome_Samples/<sample>/<sample>.a.{cog,ko,ec,phylodist}.txt),
tab-delimited, NO header row, verified against JGI's README.txt:
  .cog.txt:       gene_id(0), cog_id(1), percent_identity(2), ... (10 cols)
                  can have MULTIPLE rows per gene_id (multi-domain HMM hits)
  .ko.txt:        gene_id(0), img_ko_flag(1), ko_term(2), ... (11 cols)
                  single best hit (LAST) -- confirmed 0 genes with >1 row
  .ec.txt:        gene_id(0), img_ko_flag(1), EC(2), ... (11 cols)
                  EC derived from the KO hit, but a single KO can map to
                  multiple real EC numbers (bifunctional enzymes) -- can
                  have multiple DISTINCT values per gene, all genuine
  .phylodist.txt: gene_id(0), homolog_gene_oid(1), homolog_taxon_oid(2),
                  percent_identity(3), lineage(4) -- single-valued

Re-derives the intended output without importing the notebook (plain
dicts, no notebook import), and checks the result against the real TSV on
disk, for both a small synthetic dataset and the real 128-sample dataset.

Important limitation, found by a third independent review (2026-07-31):
expected_rows_for_sample() below is NOT a structurally independent
reimplementation -- it uses the same column indices and the same
rsplit/set/dict logic as the notebook itself, just without a notebook
import. A pass here mostly proves "the TSV matches re-running the same
parsing logic," not that the parsing logic's column semantics are
correct -- a shared misunderstanding of the raw file format would pass
here undetected. The actual column semantics were independently verified
against Metagenome_Samples/<sample>/README.txt (JGI's own documentation)
and real raw file content by that review, not by this test suite. If this
ever needs re-verifying, re-derive expected_rows_for_sample() from the
README with genuinely different code (e.g. pandas groupby, or hardcoded
per-file column names) rather than trusting this file's own agreement
with itself.

Run:
    pytest tests/test_mappings_notebook_matches.py -v
    pytest tests/test_mappings_notebook_matches.py -v -k synthetic        # fast, no real data needed
    pytest tests/test_mappings_notebook_matches.py -v -s -k RealData      # needs DataStructures/ and
                                                                            # Metagenome_Samples/ on disk
                                                                            # (-s shows per-sample progress;
                                                                            # loading 128 samples' worth of
                                                                            # raw files takes a while --
                                                                            # this isn't a hang)
"""
import csv
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pytest

# Real dataset root -- override via env var, matches the convention used
# in test_egc_json_vs_jgi.py / test_jgi_file_parsing.py
DATA_ROOT     = Path(os.environ.get("HAB_DATA_ROOT", r"C:\Users\sakoehn\Desktop\JGI"))
BASE_DS       = DATA_ROOT / "DataStructures"
METAGENOME_DIR = DATA_ROOT / "Metagenome_Samples"


# ═══════════════════════════════════════════════════════════════════════════
# Reimplementation of the CORRECTED build logic, straight from the raw
# per-gene JGI files. Kept deliberately literal/unoptimized so it's easy to
# audit against README.txt's documented column layout side-by-side.
# ═══════════════════════════════════════════════════════════════════════════

def _scaffold_from_gene_id(gene_id: str) -> str:
    """gene_id is "{scaffold}_{start}_{end}" -- verified at scale (1.09M
    gene_ids, 0 exceptions) that the last two underscore-separated fields
    are always the numeric coordinates."""
    return gene_id.rsplit("_", 2)[0]


def _parse_multi_value_hits(path: Path, id_column: int) -> dict[str, set[str]]:
    """
    Reads a raw tab-delimited hit file (cog.txt / ko.txt / ec.txt shape,
    no header) and groups it by gene_id, returning
    {gene_id: {unique annotation ids}}.

    Missing file -> empty dict (source simply has no data for this
    sample), not an error.
    """
    hits: dict[str, set[str]] = defaultdict(set)
    if not path.exists():
        return hits
    with open(path, newline="") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            if not row:
                continue
            hits[row[0]].add(row[id_column])
    return hits


def _parse_taxonomy_hits(path: Path) -> dict[str, str]:
    """phylodist.txt is single-valued per gene: gene_id -> lineage string (column 4)."""
    hits: dict[str, str] = {}
    if not path.exists():
        return hits
    with open(path, newline="") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            if not row:
                continue
            hits[row[0]] = row[4]
    return hits


def _joined(values: set[str] | None) -> str | None:
    """Sorted, comma-joined multi-value cell -- deterministic serialization
    so the same gene always produces the same string on every run,
    regardless of set iteration order. None (not "") when there are no hits."""
    if not values:
        return None
    return ",".join(sorted(values))


def expected_rows_for_sample(metagenome_dir: Path, sample: str) -> dict:
    """
    Re-derives the expected gene_id -> {scaffold_id, taxonomy, kegg, enzyme, cog}
    mapping for one sample directly from the four raw JGI per-gene files.
    """
    sample_dir = metagenome_dir / sample

    cog_hits  = _parse_multi_value_hits(sample_dir / f"{sample}.a.cog.txt", id_column=1)
    kegg_hits = _parse_multi_value_hits(sample_dir / f"{sample}.a.ko.txt", id_column=2)
    enz_hits  = _parse_multi_value_hits(sample_dir / f"{sample}.a.ec.txt", id_column=2)
    tax_hits  = _parse_taxonomy_hits(sample_dir / f"{sample}.a.phylodist.txt")

    genes = set(cog_hits) | set(kegg_hits) | set(enz_hits) | set(tax_hits)

    expected = {}
    for gene_id in genes:
        expected[gene_id] = {
            "scaffold_id": _scaffold_from_gene_id(gene_id),
            "taxonomy":    tax_hits.get(gene_id),
            "kegg":        _joined(kegg_hits.get(gene_id)),
            "enzyme":      _joined(enz_hits.get(gene_id)),
            "cog":         _joined(cog_hits.get(gene_id)),
        }
    return expected


def read_actual_tsv(path: Path) -> dict:
    """
    Reads a real {sample}_mapping.tsv into {gene_id: {scaffold_id, taxonomy,
    kegg, enzyme, cog}}, matching the notebook's own write column order:
    gene_id, scaffold_id, taxonomy, kegg, enzyme, cog.

    Note this intentionally reads by the notebook's column names (kegg/cog),
    NOT the API's renamed kegg_id/cog_id -- this test verifies the TSV the
    build produced, before main.py's loader renames anything.
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


def _write_raw_hits(path: Path, rows: list[list[str]]):
    """Writes a raw tab-delimited hit file with no header, matching the real
    cog.txt/ko.txt/ec.txt/phylodist.txt shape for synthetic fixtures."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        writer = csv.writer(f, delimiter="\t")
        for row in rows:
            writer.writerow(row)


def _cog_row(gene_id: str, cog_id: str) -> list[str]:
    return [gene_id, cog_id, "99.0", "100", "1", "100", "1", "100", "1e-50", "200.0"]


def _ko_row(gene_id: str, ko_term: str) -> list[str]:
    return [gene_id, "Yes", ko_term, "99.0", "1", "100", "1", "100", "1e-50", "200", "100"]


def _ec_row(gene_id: str, ec_id: str) -> list[str]:
    return [gene_id, "Yes", ec_id, "99.0", "1", "100", "1", "100", "1e-50", "200", "100"]


def _phylodist_row(gene_id: str, lineage: str) -> list[str]:
    return [gene_id, "1234567", "7654321", "99.0", lineage]


def _write_json(path: Path, data: dict):
    import json
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)


def _write_tsv_from_expected(path: Path, expected: dict):
    """Writes a TSV the same way the build should, for synthetic fixtures."""
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
# TestBuildLogicSynthetic — small hand-built raw hit files, fully controlled
# ═══════════════════════════════════════════════════════════════════════════

class TestBuildLogicSynthetic:
    """
    Builds small fake raw cog.txt/ko.txt/ec.txt/phylodist.txt files with
    known, deliberately tricky content and confirms expected_rows_for_sample()
    reproduces exactly the corrected, intended logic.

    Genes, by design:
      - scafA_100_200 ("gene_a"): present in all 4 sources. COG has a
        duplicate hit (same ID twice -> must dedupe to one). Enzyme has two
        GENUINELY DISTINCT EC values (bifunctional-enzyme case -> both kept).
      - scafA_300_400 ("gene_b"): present in COG + taxonomy only.
      - scafB_10_50 ("gene_d"): present in KEGG + enzyme + taxonomy, but
        NOT in COG at all -- must still be INCLUDED (union rule), with
        cog=None. This is the direct reversal of the old, buggy exclusion.
      - scafC_5_60 ("gene_e"): COG only, with two GENUINELY DISTINCT COG
        hits (multi-domain-protein case -> both kept, sorted). Nothing in
        kegg/enzyme/taxonomy -- must still appear, with those fields None.
    """

    @pytest.fixture
    def synthetic_metagenome_dir(self, tmp_path):
        meta_dir = tmp_path / "Metagenome_Samples" / "s1"

        _write_raw_hits(meta_dir / "s1.a.cog.txt", [
            _cog_row("scafA_100_200", "COG0001"),
            _cog_row("scafA_100_200", "COG0001"),   # duplicate hit, same COG
            _cog_row("scafA_300_400", "COG0002"),
            _cog_row("scafC_5_60", "COG0003"),
            _cog_row("scafC_5_60", "COG0004"),       # genuinely distinct 2nd COG
        ])
        _write_raw_hits(meta_dir / "s1.a.ko.txt", [
            _ko_row("scafA_100_200", "K00010"),
            _ko_row("scafB_10_50", "K99999"),
        ])
        _write_raw_hits(meta_dir / "s1.a.ec.txt", [
            _ec_row("scafA_100_200", "1.1.1.1"),
            _ec_row("scafA_100_200", "1.1.1.2"),     # genuinely distinct 2nd EC
            _ec_row("scafB_10_50", "9.9.9.9"),
        ])
        _write_raw_hits(meta_dir / "s1.a.phylodist.txt", [
            _phylodist_row("scafA_100_200", "Bacteria;Firmicutes"),
            _phylodist_row("scafA_300_400", "Archaea"),
            _phylodist_row("scafB_10_50", "Viruses"),
        ])

        return tmp_path / "Metagenome_Samples"

    def test_duplicate_cog_hit_dedupes_to_one_value(self, synthetic_metagenome_dir):
        result = expected_rows_for_sample(synthetic_metagenome_dir, "s1")
        assert result["scafA_100_200"]["cog"] == "COG0001"

    def test_multiple_distinct_cog_hits_keeps_all_sorted(self, synthetic_metagenome_dir):
        result = expected_rows_for_sample(synthetic_metagenome_dir, "s1")
        assert result["scafC_5_60"]["cog"] == "COG0003,COG0004"

    def test_multiple_distinct_ec_hits_keeps_all_sorted(self, synthetic_metagenome_dir):
        result = expected_rows_for_sample(synthetic_metagenome_dir, "s1")
        assert result["scafA_100_200"]["enzyme"] == "1.1.1.1,1.1.1.2"

    def test_gene_absent_from_cog_is_still_included(self, synthetic_metagenome_dir):
        """Direct reversal of the old (buggy) behavior: a gene with real
        KEGG/enzyme/taxonomy data but no COG hit must appear, with
        cog=None -- not be excluded entirely."""
        result = expected_rows_for_sample(synthetic_metagenome_dir, "s1")
        assert "scafB_10_50" in result
        assert result["scafB_10_50"]["cog"] is None
        assert result["scafB_10_50"]["kegg"] == "K99999"
        assert result["scafB_10_50"]["enzyme"] == "9.9.9.9"
        assert result["scafB_10_50"]["taxonomy"] == "Viruses"

    def test_gene_present_in_only_one_source_gets_nulls_elsewhere(self, synthetic_metagenome_dir):
        result = expected_rows_for_sample(synthetic_metagenome_dir, "s1")
        assert result["scafC_5_60"]["kegg"] is None
        assert result["scafC_5_60"]["enzyme"] is None
        assert result["scafC_5_60"]["taxonomy"] is None

    def test_scaffold_id_parsed_from_gene_id_even_without_taxonomy(self, synthetic_metagenome_dir):
        """scaffold_id must come from gene_id itself, even for a gene with
        NO taxonomy hit at all (scafC_5_60) -- the old bug sourced it from
        taxonomy's scaffolds list and would have left this None."""
        result = expected_rows_for_sample(synthetic_metagenome_dir, "s1")
        assert result["scafA_100_200"]["scaffold_id"] == "scafA"
        assert result["scafA_300_400"]["scaffold_id"] == "scafA"
        assert result["scafB_10_50"]["scaffold_id"] == "scafB"
        assert result["scafC_5_60"]["scaffold_id"] == "scafC"

    def test_missing_raw_file_treated_as_empty_source_not_error(self, tmp_path):
        """If e.g. s2.a.ko.txt doesn't exist at all (not just empty), the
        sample's genes should still process with kegg=None rather than
        crashing."""
        meta_dir = tmp_path / "Metagenome_Samples" / "s2"
        _write_raw_hits(meta_dir / "s2.a.cog.txt", [_cog_row("scafX_1_10", "COG0099")])
        # Deliberately do NOT write s2.a.ko.txt at all
        result = expected_rows_for_sample(tmp_path / "Metagenome_Samples", "s2")
        assert result["scafX_1_10"]["kegg"] is None
        assert result["scafX_1_10"]["cog"] == "COG0099"

    def test_sample_with_no_hits_anywhere_returns_empty(self, tmp_path):
        result = expected_rows_for_sample(tmp_path / "Metagenome_Samples", "nonexistent_sample")
        assert result == {}

    def test_synthetic_expected_matches_a_correctly_written_tsv(self, synthetic_metagenome_dir, tmp_path):
        """End-to-end sanity check: write a TSV using the SAME expected
        values, read it back with read_actual_tsv(), and confirm a
        round-trip produces an exact match -- proving the comparison
        machinery itself (not just the derivation) is correct."""
        expected = expected_rows_for_sample(synthetic_metagenome_dir, "s1")
        tsv_path = tmp_path / "Mappings_by_Sample" / "s1_mapping.tsv"
        _write_tsv_from_expected(tsv_path, expected)

        actual = read_actual_tsv(tsv_path)
        for gene_id, exp_vals in expected.items():
            assert actual[gene_id] == exp_vals, f"{gene_id}: expected {exp_vals}, got {actual[gene_id]}"

    def test_corrupted_tsv_is_caught_by_the_comparison(self, synthetic_metagenome_dir, tmp_path):
        """Negative control: deliberately write a WRONG TSV (swap a gene's
        cog value) and confirm the comparison detects the mismatch --
        proving this test suite would actually fail if the build logic
        broke, not just pass trivially."""
        expected = expected_rows_for_sample(synthetic_metagenome_dir, "s1")
        tampered = dict(expected)
        tampered["scafA_100_200"] = {**tampered["scafA_100_200"], "cog": "COG_WRONG"}

        tsv_path = tmp_path / "Mappings_by_Sample" / "s1_mapping.tsv"
        _write_tsv_from_expected(tsv_path, tampered)
        actual = read_actual_tsv(tsv_path)

        assert actual["scafA_100_200"] != expected["scafA_100_200"], (
            "Sanity check failed: tampering didn't actually change the row -- "
            "the comparison logic below would pass even on broken data."
        )


# ═══════════════════════════════════════════════════════════════════════════
# TestBuildLogicRealData — real raw JGI files vs real TSVs on disk
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.skipif(
    not METAGENOME_DIR.exists(),
    reason=f"Metagenome_Samples/ not found at {METAGENOME_DIR} -- set HAB_DATA_ROOT to run this class",
)
class TestBuildLogicRealData:
    """
    Re-derives expected mappings from the REAL raw cog.txt/ko.txt/ec.txt/
    phylodist.txt files and compares against the REAL
    Mappings_by_Sample/{sample}_mapping.tsv files the build actually
    produced -- catching any genuine mismatch in the production dataset,
    not just in a synthetic fixture.

    Performance note: raw files can be very large (a single sample's
    cog.txt/ko.txt/ec.txt/phylodist.txt together can be 100+ MB), and some
    samples have 500k-900k+ genes. check_results (below) checks and
    DISCARDS each sample's data immediately, one sample at a time, rather
    than accumulating every sample's full gene dict simultaneously --
    confirmed by real crash: an earlier version that held all samples'
    dicts in memory for the whole test class hit a genuine MemoryError
    around sample 90/128 on this machine, even running alone with nothing
    else competing for memory. Only small mismatch lists/counters persist
    across the whole run; the heavy per-sample dicts are garbage collected
    before the next sample loads.

    Run with -s to see per-sample progress:
        pytest tests/test_mappings_notebook_matches.py -v -s -k RealData

    Stops collecting mismatches after 10 total (same convention as
    test_egc_json_vs_jgi.py) so a systemic bug doesn't flood the terminal.
    """

    MAX_REPORTED_MISMATCHES = 10

    @pytest.fixture(scope="class")
    @classmethod
    def sample_names(cls):
        """
        Reads the canonical 128-sample list from sample_names.txt -- the
        SAME file the build itself reads -- rather than listing
        Metagenome_Samples/ subdirectories directly. That directory has at
        least one stray non-sample entry ("faa", confirmed via `diff`
        against sample_names.txt) that isn't a real sample, and using the
        same canonical list the build used ensures this test checks
        exactly what the build actually processed, nothing more.
        """
        if not METAGENOME_DIR.exists():
            pytest.skip(f"{METAGENOME_DIR} not found")
        sample_names_path = DATA_ROOT / "sample_names.txt"
        if not sample_names_path.exists():
            pytest.skip(f"{sample_names_path} not found")
        with open(sample_names_path) as f:
            names = [s.strip() for s in f if s.strip()]
        if not names:
            pytest.skip(f"No sample names found in {sample_names_path}")
        return names

    @pytest.fixture(scope="class")
    @classmethod
    def check_results(cls, sample_names):
        """
        Single streaming pass: for each sample, derive expected + read
        actual, run every check immediately, record only small
        mismatch entries, then let both big dicts go out of scope before
        the next sample loads. Prints progress per sample (visible with -s).
        """
        results = {
            "missing_tsv":         [],
            "count_mismatches":    [],
            "missing_genes":       [],
            "value_mismatches":    [],
            "duplicate_gene_ids":  [],
            "samples_checked":     0,
        }

        total = len(sample_names)
        print(f"\n[mappings-match] checking {total} samples from {METAGENOME_DIR} ...", file=sys.stderr)
        for i, sample in enumerate(sample_names, start=1):
            tsv_path = BASE_DS / "Mappings_by_Sample" / f"{sample}_mapping.tsv"
            if not tsv_path.exists():
                results["missing_tsv"].append(sample)
                print(f"[mappings-match] ({i}/{total}) {sample}: NO TSV", file=sys.stderr)
                continue

            expected = expected_rows_for_sample(METAGENOME_DIR, sample)
            actual = read_actual_tsv(tsv_path)

            if len(actual) != len(expected):
                results["count_mismatches"].append(
                    f"{sample}: union of raw sources has {len(expected)} genes, TSV has {len(actual)} rows"
                )

            with open(tsv_path, newline="") as f:
                reader = csv.DictReader(f, delimiter="\t")
                gene_ids = [row["gene_id"] for row in reader]
            dupes = [g for g, c in Counter(gene_ids).items() if c > 1]
            if dupes:
                results["duplicate_gene_ids"].append(f"{sample}: duplicate gene_id(s) {dupes[:5]}")

            for gene_id, exp_vals in expected.items():
                if gene_id not in actual:
                    if len(results["missing_genes"]) < cls.MAX_REPORTED_MISMATCHES:
                        results["missing_genes"].append(f"{sample}/{gene_id}")
                    continue
                if actual[gene_id] != exp_vals:
                    if len(results["value_mismatches"]) < cls.MAX_REPORTED_MISMATCHES:
                        results["value_mismatches"].append(
                            f"{sample}/{gene_id}: expected={exp_vals}, actual={actual[gene_id]}"
                        )

            results["samples_checked"] += 1
            print(
                f"[mappings-match] ({i}/{total}) {sample}: "
                f"{len(expected)} expected genes, {len(actual)} tsv rows, {len(dupes)} dupes",
                file=sys.stderr,
            )
            # expected/actual/gene_ids go out of scope here -- freed
            # before the next sample loads, keeping peak memory roughly
            # O(one sample) instead of O(all 128 samples).

        print("[mappings-match] done checking.", file=sys.stderr)
        return results

    def test_at_least_one_sample_found(self, sample_names):
        assert len(sample_names) > 0

    def test_every_sample_has_a_corresponding_tsv(self, check_results):
        assert not check_results["missing_tsv"], (
            f"{len(check_results['missing_tsv'])} sample(s) have no mapping TSV "
            f"(first 10): {check_results['missing_tsv'][:10]}"
        )

    def test_gene_count_matches_union_of_raw_sources(self, check_results):
        """The TSV's row count should equal the number of unique genes
        across all four raw sources for that sample (the union IS the new
        base gene list) -- a count mismatch signals genes were dropped or
        duplicated during the build."""
        assert not check_results["count_mismatches"], "\n".join(
            check_results["count_mismatches"][:self.MAX_REPORTED_MISMATCHES]
        )

    def test_every_gene_matches_expected_values(self, check_results):
        """
        The core check: for every gene in every sample, the TSV's
        scaffold_id/taxonomy/kegg/enzyme/cog values must exactly equal
        what expected_rows_for_sample() independently derives from the
        same raw JGI files.
        """
        issues = []
        if check_results["missing_genes"]:
            issues.append(f"Genes missing from TSV (first 10): {check_results['missing_genes']}")
        if check_results["value_mismatches"]:
            issues.append(f"Value mismatches (first 10): {check_results['value_mismatches']}")
        assert not issues, "\n".join(issues)

    def test_no_gene_appears_twice_in_any_tsv(self, check_results):
        """Each gene_id should be a unique row per sample -- a duplicate
        would indicate the build produced a fan-out somewhere."""
        assert not check_results["duplicate_gene_ids"], "\n".join(
            check_results["duplicate_gene_ids"][:self.MAX_REPORTED_MISMATCHES]
        )
