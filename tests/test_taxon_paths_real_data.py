"""
test_taxon_paths_real_data.py
================================
E16 remaining issue (docs/AUDIT-2026-09-22.md): EGC_TAX_TREE.ipynb's
lineage-parsing cell (`taxpath = [p.strip() for p in raw_parts if p.strip()]`)
DROPS every empty segment, shifting every rank after it left by one
position. `parse_taxon_path()` (FastAPI/scripts/migrate_mappings_to_sql.py),
which builds the separate `taxon_paths` table, is POSITIONAL instead -- an
empty segment becomes None at its own rank, without shifting anything.

If a real phylodist lineage ever had an EMPTY MIDDLE segment (not counting
a trailing one, which both sides handle the same way -- they just stop),
these two systems would compute different depths for the same real
organism: the notebook's tax_tree/annotation_series/annotation_catalog
data on one side, taxon_paths on the other.

Investigated directly against the real dataset before writing any fix:
scanned all 128 real .a.phylodist.txt files, 71,121,876 total lineage
observations, 0 with an empty middle segment. The two systems currently
agree on every real lineage in this dataset -- there is no live bug to
fix today, only a theoretical one. This test is the regression guard: if
a future data release ever introduces an empty-middle-segment lineage,
this fails loudly instead of silently producing a depth mismatch between
annotation_catalog and taxon_paths.

Data-dependent: needs the real Metagenome_Samples/ tree (not in git, not
in CI -- see test_mappings_notebook_matches.py's HAB_DATA_ROOT convention,
reused here). Skipped automatically when that data isn't present.

has_empty_middle_segment()'s own logic (trailing-blank vs. middle-blank)
is pure and has independent, always-run synthetic tests below -- the slow
real-data scan only needs to prove no real lineage trips it, not that the
predicate itself is correct.

Run:
    pytest tests/test_taxon_paths_real_data.py -v
"""

import os
from pathlib import Path

import pytest

# Matches the convention used in test_mappings_notebook_matches.py /
# test_egc_json_vs_jgi.py / test_jgi_file_parsing.py.
DATA_ROOT      = Path(os.environ.get("HAB_DATA_ROOT", r"C:\Users\sakoehn\Desktop\JGI"))
METAGENOME_DIR = DATA_ROOT / "Metagenome_Samples"


def has_empty_middle_segment(full_path: str) -> bool:
    """True if `full_path` (a raw ';'-separated phylodist lineage) has a
    blank segment with a real (non-blank) segment somewhere after it.

    A trailing RUN of empty segments -- one or more -- doesn't cause a
    depth mismatch: both the notebook's drop-and-shift and taxon_paths'
    positional-None agree the lineage just ends there once every
    remaining segment is blank. Only a blank segment that's followed by
    another real segment makes the notebook's depth differ from
    taxon_paths'. (Caught by this function's own synthetic tests below:
    an earlier version only excluded the single last element, so it
    wrongly flagged "Bacteria;Proteobacteria;;" -- two trailing blanks --
    as a middle blank, even though both systems agree that lineage is
    just 2 ranks deep.)
    """
    raw_parts = full_path.split(";")
    trimmed = raw_parts
    while trimmed and trimmed[-1].strip() == "":
        trimmed = trimmed[:-1]
    return any(p.strip() == "" for p in trimmed)


# pylint: disable=redefined-outer-name -- see test_annotation_catalog.py's
# own note on this same pytest fixture-injection pattern.

@pytest.mark.parametrize("full_path,expected", [
    ("Bacteria;Proteobacteria;Gammaproteobacteria", False),   # no blanks at all
    ("Bacteria;Proteobacteria;", False),                      # trailing blank only
    ("Bacteria;Proteobacteria;;", False),                     # multiple trailing blanks
    ("Bacteria;;Gammaproteobacteria", True),                  # blank in the middle
    ("Bacteria; ;Gammaproteobacteria", True),                 # whitespace-only middle segment
    (";Bacteria;Proteobacteria", True),                       # leading blank (not the last segment)
])
def test_has_empty_middle_segment(full_path, expected):
    assert has_empty_middle_segment(full_path) is expected


@pytest.mark.skipif(
    not METAGENOME_DIR.exists(),
    reason=f"Metagenome_Samples/ not found at {METAGENOME_DIR} -- set HAB_DATA_ROOT to run this test",
)
def test_no_real_phylodist_lineage_has_an_empty_middle_segment():
    sample_dirs = sorted(d for d in METAGENOME_DIR.iterdir() if d.is_dir())
    assert sample_dirs, f"no sample directories found under {METAGENOME_DIR}"

    total_observations = 0
    bad_examples: list[str] = []

    for sample_dir in sample_dirs:
        phylodist_path = sample_dir / f"{sample_dir.name}.a.phylodist.txt"
        if not phylodist_path.exists():
            continue
        with open(phylodist_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 5:
                    continue
                full_path = parts[-1]
                total_observations += 1
                if has_empty_middle_segment(full_path):
                    if len(bad_examples) < 10:
                        bad_examples.append(full_path)

    assert total_observations > 0, "no phylodist lineage observations were read at all"
    assert not bad_examples, (
        f"found {len(bad_examples)}+ real lineages with an empty MIDDLE segment -- "
        f"the notebook (drops empty segments) and taxon_paths (keeps them as "
        f"positional None) will now compute different depths for these. "
        f"Examples: {bad_examples}"
    )
