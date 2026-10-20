"""
test_cog_tax_raw_line_guards.py
=================================
EGC_KEGG_TREE/EGC_ENZYME_TREE assert each raw entry carries exactly one
id; EGC_COG_TREE's read_cog and EGC_TAX_TREE's read_tax likewise guard
their own file's real shape instead of taking parts[1] / parts[-1] on
trust:
  - .a.cog.txt:       exactly 10 columns, id is exactly COG + 4 digits
                      (a ';'-joined list fails the shape check)
  - .a.phylodist.txt: exactly 5 columns, lineage read from column 4 (it
                      legitimately contains ';', so the KEGG/Enzyme ';'
                      rule can't be reused here)
Scanned 2026-10-14 across all 128 real samples: 53.7M cog rows all 10
columns + COGdddd, 71.1M phylodist rows all 5 columns -- neither guard
fires on real data.

Loads the REAL read_cog/read_tax function definitions from the .ipynb
files (via ast, so the cell's own data-loading loop with hardcoded paths
isn't run), not copies.

Run:
    pytest tests/test_cog_tax_raw_line_guards.py -v
"""
import ast
import json

import pytest

from conftest import DATA_ROOT
from test_mappings_notebook_matches import _cog_row, _phylodist_row, _write_raw_hits

NOTEBOOKS = DATA_ROOT / "Notebooks"


def _load_function(notebook: str, func_name: str):
    nb = json.loads((NOTEBOOKS / notebook).read_text(encoding="utf-8"))
    for cell in nb["cells"]:
        if cell["cell_type"] != "code":
            continue
        tree = ast.parse("".join(cell["source"]))
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == func_name:
                namespace = {}
                exec(compile(ast.Module([node], []), notebook, "exec"), namespace)  # pylint: disable=exec-used
                return namespace[func_name]
    raise AssertionError(f"{func_name} not found in {notebook}")


@pytest.fixture(scope="module")
def read_cog():
    return _load_function("EGC_COG_TREE.ipynb", "read_cog")


@pytest.fixture(scope="module")
def read_tax():
    return _load_function("EGC_TAX_TREE.ipynb", "read_tax")


# pylint: disable=redefined-outer-name

# ── COG ────────────────────────────────────────────────────────────────────

def test_cog_normal_rows_load(read_cog, tmp_path):
    _write_raw_hits(tmp_path / "s1.a.cog.txt", [
        _cog_row("scafA_1_10", "COG0001"),
        _cog_row("scafA_1_10", "COG0002"),
    ])
    db = {}
    read_cog(tmp_path, "s1.a.cog.txt", "s1", db)
    assert db == {"scafA_1_10": {
        "lookupId": ["COG0001", "COG0002"], "timepoint": ["s1", "s1"],
        "scaffolds": ["scafA", "scafA"],
    }}


@pytest.mark.parametrize("cog_id", ["COG0001;COG0002", "COG001", "K00001", ""])
def test_cog_malformed_id_is_refused(read_cog, tmp_path, cog_id):
    _write_raw_hits(tmp_path / "s1.a.cog.txt", [_cog_row("scafA_1_10", cog_id)])
    with pytest.raises(AssertionError, match="scafA_1_10"):
        read_cog(tmp_path, "s1.a.cog.txt", "s1", {})


@pytest.mark.parametrize("n_cols", [9, 11])
def test_cog_wrong_column_count_is_refused(read_cog, tmp_path, n_cols):
    row = (_cog_row("scafA_1_10", "COG0001") + ["extra"])[:n_cols]
    _write_raw_hits(tmp_path / "s1.a.cog.txt", [row])
    with pytest.raises(AssertionError, match="scafA_1_10"):
        read_cog(tmp_path, "s1.a.cog.txt", "s1", {})


# ── Taxonomy ───────────────────────────────────────────────────────────────

def test_tax_normal_row_loads_lineage_with_semicolons(read_tax, tmp_path):
    lineage = "Bacteria;Firmicutes;Bacilli;Bacillales"
    _write_raw_hits(tmp_path / "s1.a.phylodist.txt", [_phylodist_row("scafA_1_10", lineage)])
    db = {}
    read_tax(tmp_path, "s1.a.phylodist.txt", "s1", db)
    assert db == {"scafA_1_10": {
        "lookupId": [lineage], "timepoint": ["s1"], "scaffolds": ["scafA"],
    }}


@pytest.mark.parametrize("n_cols", [4, 6])
def test_tax_wrong_column_count_is_refused(read_tax, tmp_path, n_cols):
    row = (_phylodist_row("scafA_1_10", "Bacteria;Firmicutes") + ["extra"])[:n_cols]
    _write_raw_hits(tmp_path / "s1.a.phylodist.txt", [row])
    with pytest.raises(AssertionError, match="scafA_1_10"):
        read_tax(tmp_path, "s1.a.phylodist.txt", "s1", {})
