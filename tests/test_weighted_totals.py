"""
test_weighted_totals.py
========================
Tests for Notebooks/weighted_totals.py -- the shared, cross-source EGC
normalization denominator (the Thing 1 fix: norm_egc must be comparable
across COG/KEGG/Enzyme/Taxonomy on the same plot, which requires one shared
gene-weighted total per sample instead of each source computing its own
scoped total from its own annotation DB).

Covers:
  - get_gene_counts(): tallies gene count PER SCAFFOLD from a mapping TSV's
    scaffold_id column. Explicitly guards against the "isn't this just 1 per
    scaffold" misreading raised during review -- scaffold_id is NOT
    deduplicated in the raw column, it repeats once per gene on that
    scaffold, so the tally must reflect real multi-gene scaffolds.
  - calculate_denominator_egc(): Sigma(gene_count_on_scaffold * AvgFold).
    Tested once in isolation with monkeypatched allfold/get_gene_counts so
    the arithmetic itself is checked against fully controlled inputs, and
    once end-to-end against a real synthetic TSV to prove the two functions
    actually compose correctly together.
  - Regression coverage for the shared-mutable-global-dict bug found and
    fixed during review (calculate_denominator_egc used to mutate a
    module-level dict and hand back the same object every call): two calls
    with different sample sets must not contaminate each other.
  - Real-data smoke tests for the still-open question raised during review:
    does every scaffold_id in a real mapping TSV actually exist in
    allfold[sample]? calculate_denominator_egc uses an unguarded
    allfold[s][scaff] lookup (deliberately -- fail loud, not a silent 0),
    so a missing scaffold would currently crash the real pipeline.

Important limitation: weighted_totals.py imports `allfold` from
All_Coverages at MODULE IMPORT TIME, and All_Coverages.py itself reads all
128 real .a.depth.txt files as a side effect of being imported -- there is
no way to import weighted_totals at all without the real data root present,
even for tests that only care about the isolated arithmetic. Every class
below is therefore gated on the real data root existing; there is no
real-data-free synthetic-only path for this module, unlike
test_mappings_notebook_matches.py's synthetic class.

Run:
    pytest tests/test_weighted_totals.py -v
    pytest tests/test_weighted_totals.py -v -k RealData   # slower, needs
                                                            # all 128 samples
"""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

import pandas as pd
import pytest

from conftest import NORM_TOLERANCE

DATA_ROOT: Path = Path(os.environ.get("HAB_DATA_ROOT", Path(__file__).resolve().parent.parent))
NOTEBOOKS_DIR: Path = DATA_ROOT / "Notebooks"
MAPPINGS_DIR: Path = DATA_ROOT / "DataStructures" / "Mappings_by_Sample"
METAGENOME_DIR: Path = DATA_ROOT / "Metagenome_Samples"
SAMPLE_NAMES_FILE: Path = DATA_ROOT / "sample_names.txt"

_DATA_PRESENT = MAPPINGS_DIR.exists() and METAGENOME_DIR.exists() and SAMPLE_NAMES_FILE.exists()

pytestmark = pytest.mark.skipif(
    not _DATA_PRESENT,
    reason=(
        f"Real data root not found under {DATA_ROOT} -- weighted_totals.py "
        "imports All_Coverages, which reads real .a.depth.txt files as a "
        "module-level side effect of being imported, so there is no way to "
        "even import weighted_totals without the real data tree present."
    ),
)

if _DATA_PRESENT:
    sys.path.insert(0, str(NOTEBOOKS_DIR))
    import weighted_totals

sys.path.insert(0, str(DATA_ROOT / "FastAPI"))
from api.config import SQLITE_DB_PATH

_SQL_DB_PRESENT = os.path.exists(SQLITE_DB_PATH)


def _write_mapping_tsv(path: Path, scaffold_ids: list[str]) -> None:
    """Writes a minimal synthetic mapping TSV with only the scaffold_id
    column populated -- one row per gene, scaffold_ids repeated exactly as
    a real multi-gene scaffold would repeat in the real file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame({
        "gene_id":     [f"g{i}" for i in range(len(scaffold_ids))],
        "scaffold_id": scaffold_ids,
        "taxonomy":    [""] * len(scaffold_ids),
        "kegg":        [""] * len(scaffold_ids),
        "enzyme":      [""] * len(scaffold_ids),
        "cog":         [""] * len(scaffold_ids),
    })
    df.to_csv(path, sep="\t", index=False)


# ═══════════════════════════════════════════════════════════════════════════
# TestGetGeneCounts — synthetic mapping TSVs, real BASE_DIR monkeypatched away
# ═══════════════════════════════════════════════════════════════════════════

class TestGetGeneCounts:

    def test_scaffold_with_multiple_genes_counts_all_of_them(self, tmp_path, monkeypatch):
        """Direct regression test for the concern raised during review:
        scaffold_id is the raw per-row column value, NOT a deduplicated
        list of unique scaffolds -- a scaffold with 3 genes must count as
        3, not collapse to 1."""
        monkeypatch.setattr(weighted_totals, "BASE_DIR", tmp_path / "Notebooks")
        _write_mapping_tsv(
            tmp_path / "DataStructures" / "Mappings_by_Sample" / "s1_mapping.tsv",
            ["scafA", "scafA", "scafA", "scafB", "scafC", "scafC"],
        )

        result = weighted_totals.get_gene_counts(["s1"])

        assert result["s1"]["scafA"] == 3
        assert result["s1"]["scafB"] == 1
        assert result["s1"]["scafC"] == 2

    def test_total_genes_across_scaffolds_equals_row_count(self, tmp_path, monkeypatch):
        """Sum of all per-scaffold counts must equal the TSV's row count --
        no gene silently dropped or double-counted."""
        monkeypatch.setattr(weighted_totals, "BASE_DIR", tmp_path / "Notebooks")
        scaffold_ids = ["scafA"] * 5 + ["scafB"] * 3 + ["scafC"] * 1
        _write_mapping_tsv(
            tmp_path / "DataStructures" / "Mappings_by_Sample" / "s1_mapping.tsv",
            scaffold_ids,
        )

        result = weighted_totals.get_gene_counts(["s1"])

        assert sum(result["s1"].values()) == len(scaffold_ids)

    def test_different_samples_get_independent_counts(self, tmp_path, monkeypatch):
        monkeypatch.setattr(weighted_totals, "BASE_DIR", tmp_path / "Notebooks")
        _write_mapping_tsv(
            tmp_path / "DataStructures" / "Mappings_by_Sample" / "s1_mapping.tsv",
            ["scafA", "scafA"],
        )
        _write_mapping_tsv(
            tmp_path / "DataStructures" / "Mappings_by_Sample" / "s2_mapping.tsv",
            ["scafA"],
        )

        result = weighted_totals.get_gene_counts(["s1", "s2"])

        assert result["s1"]["scafA"] == 2
        assert result["s2"]["scafA"] == 1


# ═══════════════════════════════════════════════════════════════════════════
# TestCalculateDenominatorEgc — arithmetic isolated via monkeypatched inputs
# ═══════════════════════════════════════════════════════════════════════════

class TestCalculateDenominatorEgcIsolated:
    """get_gene_counts and allfold are both monkeypatched to fixed values,
    so these tests check ONLY the multiply-and-sum arithmetic, independent
    of any file parsing."""

    def test_weighted_sum_matches_hand_calculation(self, monkeypatch):
        monkeypatch.setattr(
            weighted_totals, "get_gene_counts",
            lambda samples: {"s1": {"scafA": 3, "scafB": 1, "scafC": 2}},
        )
        monkeypatch.setattr(
            weighted_totals, "allfold",
            {"s1": {"scafA": 10.0, "scafB": 5.0, "scafC": 2.0, "total": 999.0}},
        )

        result = weighted_totals.calculate_denominator_egc(["s1"])

        # 3*10 + 1*5 + 2*2 = 39
        assert result["s1"] == pytest.approx(39.0)

    def test_the_magic_total_key_in_allfold_is_never_used_as_a_scaffold(self, monkeypatch):
        """allfold[sample] always carries a 'total' key alongside real
        scaffold ids (the OLD unweighted sum). calculate_denominator_egc
        must never pick that key up as if it were a scaffold -- iteration
        is driven by gene_counts, not by allfold's own keys."""
        monkeypatch.setattr(
            weighted_totals, "get_gene_counts",
            lambda samples: {"s1": {"scafA": 1}},
        )
        monkeypatch.setattr(
            weighted_totals, "allfold",
            {"s1": {"scafA": 10.0, "total": 999999.0}},
        )

        result = weighted_totals.calculate_denominator_egc(["s1"])

        assert result["s1"] == pytest.approx(10.0)

    def test_missing_scaffold_in_allfold_raises_rather_than_silently_zeroing(self, monkeypatch):
        """Deliberate design choice (see Thing 4 discussion): a scaffold
        present in the mapping TSV but absent from allfold should be a loud
        failure, not silently contribute 0 to the denominator."""
        monkeypatch.setattr(
            weighted_totals, "get_gene_counts",
            lambda samples: {"s1": {"scaf_not_in_allfold": 1}},
        )
        monkeypatch.setattr(weighted_totals, "allfold", {"s1": {}})

        with pytest.raises(KeyError):
            weighted_totals.calculate_denominator_egc(["s1"])

    def test_two_calls_with_different_samples_do_not_contaminate_each_other(self, monkeypatch):
        """Regression test for the shared-mutable-global-dict bug found
        during review: calculate_denominator_egc used to build its result
        in a module-level `weighted_totals = {}` and return that same
        object every call, so a second call with a different sample list
        could leak into / be polluted by the first call's result. It now
        builds a fresh local dict per call."""
        monkeypatch.setattr(
            weighted_totals, "get_gene_counts",
            lambda samples: {s: {"scaf": 1} for s in samples},
        )
        monkeypatch.setattr(
            weighted_totals, "allfold",
            {"s1": {"scaf": 1.0}, "s2": {"scaf": 2.0}},
        )

        first = weighted_totals.calculate_denominator_egc(["s1"])
        second = weighted_totals.calculate_denominator_egc(["s2"])

        assert "s2" not in first
        assert first["s1"] == pytest.approx(1.0)
        assert "s1" not in second
        assert second["s2"] == pytest.approx(2.0)


class TestCalculateDenominatorEgcEndToEnd:
    """No internal mocking of get_gene_counts -- a real synthetic mapping
    TSV is read from disk, proving get_gene_counts and
    calculate_denominator_egc compose correctly together, not just in
    isolation from each other."""

    def test_synthetic_tsv_plus_fixed_allfold_matches_hand_calculation(self, tmp_path, monkeypatch):
        monkeypatch.setattr(weighted_totals, "BASE_DIR", tmp_path / "Notebooks")
        monkeypatch.setattr(
            weighted_totals, "allfold",
            {"s1": {"scafA": 4.0, "scafB": 7.0}},
        )
        _write_mapping_tsv(
            tmp_path / "DataStructures" / "Mappings_by_Sample" / "s1_mapping.tsv",
            ["scafA", "scafA", "scafB"],
        )

        result = weighted_totals.calculate_denominator_egc(["s1"])

        # scafA: 2 genes * 4.0 = 8.0; scafB: 1 gene * 7.0 = 7.0 -> 15.0
        assert result["s1"] == pytest.approx(15.0)


# ═══════════════════════════════════════════════════════════════════════════
# TestRealData — the real 128-sample dataset, no monkeypatching
# ═══════════════════════════════════════════════════════════════════════════

class TestRealData:
    """Checks the still-open question from review: does every scaffold_id
    that appears in a real mapping TSV also exist in the real allfold
    coverage dict? calculate_denominator_egc's allfold[s][scaff] lookup is
    unguarded, so any gap here would currently crash the real pipeline
    rather than silently produce a wrong number -- these tests exist to
    surface that gap explicitly, with named samples, instead of via an
    unexplained KeyError during a full 128-sample run.

    Limited to a handful of samples by default to keep this fast; the
    RealData class in test_mappings_notebook_matches.py documents the
    memory-pressure risk of holding all 128 samples' data at once, which
    applies here too if this were widened to the full set.
    """

    SAMPLE_LIMIT = 5

    @pytest.fixture(scope="class")
    def sample_names(self):
        with open(SAMPLE_NAMES_FILE) as f:
            names = [s.strip() for s in f if s.strip()]
        return names[: self.SAMPLE_LIMIT]

    def test_every_mapping_tsv_scaffold_exists_in_allfold(self, sample_names):
        missing_by_sample = {}
        for s in sample_names:
            df = pd.read_csv(MAPPINGS_DIR / f"{s}_mapping.tsv", sep="\t")
            tsv_scaffolds = set(df["scaffold_id"].unique())
            cov_scaffolds = set(weighted_totals.allfold.get(s, {}).keys())
            missing = tsv_scaffolds - cov_scaffolds
            if missing:
                missing_by_sample[s] = len(missing)

        assert not missing_by_sample, (
            f"Scaffold(s) present in the mapping TSV but absent from allfold "
            f"(would raise KeyError in calculate_denominator_egc): {missing_by_sample}"
        )

    def test_calculate_denominator_egc_runs_clean_on_real_samples(self, sample_names):
        """Smoke test: the real pipeline, on real samples, produces a
        positive float per sample and doesn't raise."""
        result = weighted_totals.calculate_denominator_egc(sample_names)

        for s in sample_names:
            assert s in result
            assert result[s] > 0

    def test_real_weighted_total_exceeds_old_unweighted_total(self, sample_names):
        """Sanity check on the formula itself: the gene-weighted sum should
        be larger than the old plain sum(AvgFold) for any real sample with
        more than one gene per scaffold on average, since every scaffold's
        coverage is being multiplied by a gene count >= 1 rather than
        counted once."""
        result = weighted_totals.calculate_denominator_egc(sample_names)

        for s in sample_names:
            old_total = weighted_totals.allfold[s]["total"]
            assert result[s] >= old_total, (
                f"{s}: new weighted total {result[s]:,.0f} is smaller than the "
                f"old unweighted total {old_total:,.0f} -- unexpected, since "
                f"every gene count is >= 1"
            )


# ═══════════════════════════════════════════════════════════════════════════
# TestNormEgcMatchesSqlDatabase — audit T1 fix: pin norm_egc to an absolute
# expected value instead of only the range/ratio invariants
# test_egc_api_vs_jgi.py already checks (in (0, 1], constant ratio within a
# sample, same ratio across sources) -- those hold true for ANY consistent
# denominator, including the old, wrong, per-source-scoped one, so they
# can't catch a return to that bug or a SQL resync that drifted out of sync
# with calculate_denominator_egc. This recomputes the real shared
# denominator directly and checks it against the persisted `norm_egc`
# column for one real annotation per source.
# ═══════════════════════════════════════════════════════════════════════════

pytestmark_sql_db = pytest.mark.skipif(
    not _SQL_DB_PRESENT,
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)


@pytestmark_sql_db
class TestNormEgcMatchesSqlDatabase:
    """Real annotation IDs already independently verified elsewhere in this
    codebase: COG0055/K02112/EC:7.1.2.2 are the same known example
    tests/sql/test_mappings_sql.py uses; Archaea is the taxonomy
    domain-level equivalent (no single "gene" example applies to a rollup
    source the same way)."""

    SAMPLE_LIMIT = 5

    KNOWN_EXAMPLES = [
        ("cog", "COG0055"),
        ("kegg", "K02112"),
        ("enzyme", "7.1.2.2"),
        ("taxonomy", "Archaea"),
    ]

    @pytest.fixture(scope="class")
    def sample_names(self):
        with open(SAMPLE_NAMES_FILE) as f:
            names = [s.strip() for s in f if s.strip()]
        return names[: self.SAMPLE_LIMIT]

    @pytest.fixture(scope="class")
    def denominators(self, sample_names):
        return weighted_totals.calculate_denominator_egc(sample_names)

    @pytest.fixture(scope="class")
    def conn(self):
        connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        yield connection
        connection.close()

    @pytest.mark.parametrize("source,annotation_id", KNOWN_EXAMPLES)
    def test_norm_egc_matches_calculated_denominator(
        self, sample_names, denominators, conn, source, annotation_id,
    ):
        placeholders = ",".join("?" * len(sample_names))
        rows = conn.execute(
            f"""
            SELECT sample, egc, norm_egc FROM annotation_series
            WHERE source = ? AND annotation_id = ? AND sample IN ({placeholders})
            """,
            [source, annotation_id, *sample_names],
        ).fetchall()

        assert rows, f"No {source}/{annotation_id} rows found for samples {sample_names}"

        mismatches = []
        for row in rows:
            expected = row["egc"] / denominators[row["sample"]]
            if abs(expected - row["norm_egc"]) > NORM_TOLERANCE:
                mismatches.append(
                    f"  {row['sample']}: stored={row['norm_egc']:.12f} "
                    f"expected={expected:.12f}"
                )
        assert not mismatches, (
            f"{source}/{annotation_id} norm_egc doesn't match "
            f"egc / calculate_denominator_egc:\n" + "\n".join(mismatches)
        )