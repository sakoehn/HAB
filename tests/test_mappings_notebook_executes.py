"""
test_mappings_notebook_executes.py
====================================
P8 (docs/AUDIT-2026-10-05.md): Notebooks/mappings.ipynb has no execution
record, and test_mappings_notebook_matches.py re-derives the build logic
with its own hand-copied functions rather than running the notebook -- so
an edit to the notebook would never be caught by it.

This runs the notebook's REAL main code cell (loaded straight from the
.ipynb, unmodified) against a tiny synthetic Metagenome_Samples/ tree in a
temp dir, and checks the TSVs it writes against expected_rows_for_sample().
Together with TestBuildLogicRealData (real TSVs on disk == that same
logic, all 128 samples) this proves: notebook as written -> correct
output, and output on disk == that logic.

Only the cell's inputs are swapped (samples / base_ds / metagenome_dir,
which cell 1 hardcodes to this machine's real paths); cell 1's own import
lines are executed as-is so the main cell sees the same names it would in
the notebook.

Run:
    pytest tests/test_mappings_notebook_executes.py -v
"""
import json
from pathlib import Path

import pytest

from conftest import DATA_ROOT
from test_mappings_notebook_matches import (
    _cog_row,
    _ec_row,
    _ko_row,
    _phylodist_row,
    _write_raw_hits,
    expected_rows_for_sample,
    read_actual_tsv,
)

NOTEBOOK = DATA_ROOT / "Notebooks" / "mappings.ipynb"


def _code_cells():
    nb = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    return ["".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code"]


def _run_notebook(samples, base_ds: Path, metagenome_dir: Path):
    cells = _code_cells()
    main_cells = [src for src in cells if "for sample in samples" in src]
    assert len(main_cells) == 1, "expected exactly one main per-sample loop cell"

    setup_imports = "\n".join(
        line for line in cells[0].splitlines()
        if line.startswith(("import ", "from "))
    )
    namespace = {}
    exec(setup_imports, namespace)  # pylint: disable=exec-used
    namespace.update(samples=samples, base_ds=base_ds, metagenome_dir=metagenome_dir)
    exec(main_cells[0], namespace)  # pylint: disable=exec-used


@pytest.fixture
def synthetic_run(tmp_path):
    """Same tricky gene set as TestBuildLogicSynthetic (duplicate COG hit,
    two distinct COGs, two distinct ECs, a KEGG-only-no-COG gene, a gene
    with no taxonomy), plus s2 with a missing ko.txt and s3 with no raw
    files at all."""
    meta = tmp_path / "Metagenome_Samples"
    _write_raw_hits(meta / "s1" / "s1.a.cog.txt", [
        _cog_row("scafA_100_200", "COG0001"),
        _cog_row("scafA_100_200", "COG0001"),
        _cog_row("scafA_300_400", "COG0002"),
        _cog_row("scafC_5_60", "COG0004"),
        _cog_row("scafC_5_60", "COG0003"),
    ])
    _write_raw_hits(meta / "s1" / "s1.a.ko.txt", [
        _ko_row("scafA_100_200", "KO:K00010"),
        _ko_row("scafB_10_50", "KO:K99999"),
    ])
    _write_raw_hits(meta / "s1" / "s1.a.ec.txt", [
        _ec_row("scafA_100_200", "EC:1.1.1.2"),
        _ec_row("scafA_100_200", "EC:1.1.1.1"),
        _ec_row("scafB_10_50", "EC:9.9.9.9"),
    ])
    _write_raw_hits(meta / "s1" / "s1.a.phylodist.txt", [
        _phylodist_row("scafA_100_200", "Bacteria;Firmicutes"),
        _phylodist_row("scafA_300_400", "Archaea"),
        _phylodist_row("scafB_10_50", "Viruses"),
    ])
    _write_raw_hits(meta / "s2" / "s2.a.cog.txt", [_cog_row("scafX_1_10", "COG0099")])

    base_ds = tmp_path / "DataStructures"
    _run_notebook(["s1", "s2", "s3"], base_ds, meta)
    return meta, base_ds / "Mappings_by_Sample"


@pytest.mark.skipif(not NOTEBOOK.exists(), reason=f"{NOTEBOOK} not found")
class TestMappingsNotebookExecutes:

    @pytest.mark.parametrize("sample", ["s1", "s2"])
    def test_notebook_output_matches_expected_rows(self, synthetic_run, sample):
        meta, out_dir = synthetic_run
        actual = read_actual_tsv(out_dir / f"{sample}_mapping.tsv")
        expected = expected_rows_for_sample(meta, sample)
        assert expected, "fixture should produce rows"
        assert actual == expected

    def test_tricky_cases_are_really_in_the_notebook_output(self, synthetic_run):
        """Guard against the comparison above passing vacuously -- pin the
        specific behaviors the notebook must get right."""
        _, out_dir = synthetic_run
        actual = read_actual_tsv(out_dir / "s1_mapping.tsv")
        assert actual["scafA_100_200"]["cog"] == "COG0001"                 # dup deduped
        assert actual["scafC_5_60"]["cog"] == "COG0003,COG0004"            # both kept, sorted
        assert actual["scafA_100_200"]["enzyme"] == "EC:1.1.1.1,EC:1.1.1.2"
        assert actual["scafB_10_50"]["cog"] is None                         # union, not COG-anchored
        assert actual["scafB_10_50"]["kegg"] == "KO:K99999"
        assert actual["scafC_5_60"]["scaffold_id"] == "scafC"               # from gene_id, no taxonomy
        assert actual["scafC_5_60"]["taxonomy"] is None

    def test_sample_with_no_raw_files_writes_no_tsv(self, synthetic_run):
        _, out_dir = synthetic_run
        assert not (out_dir / "s3_mapping.tsv").exists()

    def test_tsv_header_is_the_documented_column_order(self, synthetic_run):
        _, out_dir = synthetic_run
        header = (out_dir / "s1_mapping.tsv").read_text().splitlines()[0]
        assert header.split("\t") == ["gene_id", "scaffold_id", "taxonomy", "kegg", "enzyme", "cog"]
