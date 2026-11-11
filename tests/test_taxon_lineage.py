"""
test_taxon_lineage.py
=====================
normalize_lineage (FastAPI/api/taxon_lineage.py): a phylodist lineage has 8
ranks separated by ";". A strain name that itself contains ";" (one real
case: "Drosophila melanogaster y; cn bw sp") would otherwise split into a
fake 9th rank. Everything from the 8th part on is kept as one strain, with
its inner ";" written as ", " -- so a taxon's id (its lineage joined by
";") still has exactly one segment per rank. Every other lineage is left
exactly as it was.

Run:
    pytest tests/test_taxon_lineage.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.taxon_lineage import lineage_segments, normalize_lineage  # pylint: disable=wrong-import-position,import-error

RAW = ("Eukaryota;Arthropoda;Insecta;Diptera;Drosophilidae;Drosophila;"
       "Drosophila melanogaster;Drosophila melanogaster y; cn bw sp")


def test_semicolon_inside_the_strain_becomes_a_comma():
    assert normalize_lineage(RAW) == (
        "Eukaryota;Arthropoda;Insecta;Diptera;Drosophilidae;Drosophila;"
        "Drosophila melanogaster;Drosophila melanogaster y, cn bw sp"
    )
    assert normalize_lineage(RAW).count(";") == 7


def test_ordinary_lineages_are_unchanged_byte_for_byte():
    for raw in [
        "Bacteria",
        "Bacteria;Bacteroidetes;Flavobacteriia",
        "Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Boseaceae;Bosea;Bosea sp.;Bosea sp. 117",
        "Bacteria; odd spacing ;kept",
    ]:
        assert normalize_lineage(raw) == raw


def test_empty_and_none_pass_through():
    assert normalize_lineage("") == ""
    assert normalize_lineage(None) is None


def test_is_idempotent():
    assert normalize_lineage(normalize_lineage(RAW)) == normalize_lineage(RAW)


# lineage_segments: the one way EGC_TAX_TREE.ipynb and taxon_paths split a
# lineage into ranks, so they always agree on every rank's position.

def test_segments_are_stripped_and_trailing_empties_dropped():
    assert lineage_segments("Bacteria; Proteobacteria ;Gammaproteobacteria;;;") == [
        "Bacteria", "Proteobacteria", "Gammaproteobacteria",
    ]


def test_strain_with_a_semicolon_stays_one_segment():
    raw = "Eukaryota;Arthropoda;Insecta;Diptera;Drosophilidae;Drosophila;Drosophila melanogaster;Drosophila melanogaster y;cn bw sp"
    assert lineage_segments(raw)[-1] == "Drosophila melanogaster y, cn bw sp"
    assert len(lineage_segments(raw)) == 8


def test_empty_and_none_give_no_segments():
    assert lineage_segments(None) == []
    assert lineage_segments("") == []
    assert lineage_segments(";;;") == []


@pytest.mark.parametrize("raw", [";Bacteria;Proteobacteria", "Bacteria;;Proteobacteria", "Bacteria; ;Proteobacteria"])
def test_an_empty_rank_before_a_real_one_is_refused(raw):
    with pytest.raises(ValueError, match="empty rank"):
        lineage_segments(raw)
