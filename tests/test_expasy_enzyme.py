"""
test_expasy_enzyme.py
======================
The enzyme tree's names come from ExPASy ENZYME (enzclass.txt for the
class levels, enzyme.dat for each EC number), and its shape comes from the
EC numbers themselves: 1.1.1.1 sits under 1.1.1, under 1.1, under 1.

The first group of tests runs on small hand-written snippets in the real
files' layout; the second runs on the real downloaded copies in
DataStructures/Enzyme/ and is skipped when they aren't there.

Run:
    pytest tests/test_expasy_enzyme.py -v
"""
import os
import sys
from pathlib import Path

import pytest

DATA_ROOT = Path(os.environ.get("HAB_DATA_ROOT", Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "FastAPI"))

from api.ec_renumbering import CURRENT_EC_NOT_IN_EXPASY, TRANSFERRED_EC  # noqa: E402
from api.expasy_enzyme import (  # noqa: E402
    build_ec_nodes,
    ec_parent,
    parse_enzclass,
    parse_enzyme_dat,
    unexplained_retired_ids,
)

ENZCLASS = """\
----------------------------------------------------------------------------
        ENZYME nomenclature database
Release:     04-Nov-2026
----------------------------------------------------------------------------

1. -. -.-  Oxidoreductases.
1. 1. -.-   Acting on the CH-OH group of donors.
1. 1. 1.-    With NAD(+) or NADP(+) as acceptor.
1. 1. 3.-    With oxygen as acceptor.
1.13. -.-   Acting on single donors with incorporation of molecular oxygen.
1.13.11.-    With incorporation of two atoms of oxygen.
1.13.12.-    With incorporation of one atom of oxygen.
3. -. -.-  Hydrolases.
3. 6. -.-   Acting on acid anhydrides.
3. 6. 4.-    Acting on ATP; involved in cellular and subcellular movement.
5. -. -.-  Isomerases.
5. 6. -.-   Enzymes altering macromolecular conformation.
5. 6. 1.-    Enzymes altering polypeptide conformation or assembly.
5. 6. 2.-    Enzymes altering nucleic acid conformation.
----------------------------------------------------------------------------
Copyrighted by the SIB Swiss Institute of Bioinformatics and
distributed under the Creative Commons Attribution (CC BY 4.0) License
----------------------------------------------------------------------------
"""

ENZYME_DAT = """\
CC   -----------------------------------------------------------------------
CC   Release of 04-Nov-2026
CC   -----------------------------------------------------------------------
//
ID   1.1.1.1
DE   alcohol dehydrogenase.
AN   aldehyde reductase.
//
ID   1.1.1.170
DE   3beta-hydroxysteroid-4alpha-carboxylate 3-dehydrogenase
DE   (decarboxylating).
//
ID   1.1.1.9
DE   Deleted entry.
//
ID   1.1.3.2
DE   Transferred entry: 1.13.12.4.
//
ID   1.13.11.25
DE   3,4-dihydroxy-9,10-secoandrosta-1,3,5(10)-triene-9,17-dione 4,5-
DE   dioxygenase.
//
ID   1.13.12.4
DE   lactate 2-monooxygenase.
//
ID   3.6.4.12
DE   DNA helicase.
//
ID   3.6.4.99
DE   Transferred entry: 5.6.2.3, 5.6.2.4 and
DE   5.6.2.5.
//
ID   5.6.2.3
DE   DNA 5'-3' helicase.
//
ID   5.6.2.4
DE   DNA 3'-5' helicase.
//
"""


# ── Parsing ────────────────────────────────────────────────────────────────

def test_class_levels_are_keyed_by_their_digits_only():
    classes = parse_enzclass(ENZCLASS)
    assert classes["1"] == "Oxidoreductases"
    assert classes["1.1"] == "Acting on the CH-OH group of donors"
    assert classes["1.1.1"] == "With NAD(+) or NADP(+) as acceptor"
    assert classes["1.13.12"] == "With incorporation of one atom of oxygen"


def test_header_and_footer_lines_are_not_classes():
    assert len(parse_enzclass(ENZCLASS)) == 14


def test_entry_name_drops_the_trailing_full_stop():
    assert parse_enzyme_dat(ENZYME_DAT)["1.1.1.1"]["name"] == "alcohol dehydrogenase"


def test_wrapped_name_is_joined_with_a_space():
    assert parse_enzyme_dat(ENZYME_DAT)["1.1.1.170"]["name"] == (
        "3beta-hydroxysteroid-4alpha-carboxylate 3-dehydrogenase (decarboxylating)"
    )


def test_name_wrapped_after_a_hyphen_is_joined_without_a_space():
    assert parse_enzyme_dat(ENZYME_DAT)["1.13.11.25"]["name"] == (
        "3,4-dihydroxy-9,10-secoandrosta-1,3,5(10)-triene-9,17-dione 4,5-dioxygenase"
    )


def test_status_of_current_deleted_and_transferred_entries():
    entries = parse_enzyme_dat(ENZYME_DAT)
    assert entries["1.1.1.1"]["status"] == "current"
    assert entries["1.1.1.9"]["status"] == "deleted"
    assert entries["1.1.3.2"]["status"] == "transferred"
    assert entries["1.1.3.2"]["transferred_to"] == ["1.13.12.4"]


def test_transfer_to_several_numbers_over_several_lines():
    assert parse_enzyme_dat(ENZYME_DAT)["3.6.4.99"]["transferred_to"] == [
        "5.6.2.3", "5.6.2.4", "5.6.2.5",
    ]


def test_ec_parent_drops_the_last_number():
    assert ec_parent("1.1.1.1") == "1.1.1"
    assert ec_parent("1.1") == "1"
    assert ec_parent("1") is None


# ── Building the tree's nodes ──────────────────────────────────────────────

@pytest.fixture
def nodes():
    return build_ec_nodes(parse_enzclass(ENZCLASS), parse_enzyme_dat(ENZYME_DAT))


def test_every_level_gets_its_depth_parent_and_class(nodes):
    assert nodes["1"] == {
        "name": "Oxidoreductases", "depth": 1, "category": "Oxidoreductases",
        "parent_id": None, "parent_name": None,
    }
    assert nodes["1.1.1.1"] == {
        "name": "alcohol dehydrogenase", "depth": 4, "category": "Oxidoreductases",
        "parent_id": "1.1.1", "parent_name": "With NAD(+) or NADP(+) as acceptor",
    }


def test_deleted_and_transferred_numbers_are_not_nodes(nodes):
    assert "1.1.1.9" not in nodes
    assert "3.6.4.99" not in nodes


def test_current_numbers_expasy_lacks_or_has_out_of_date_are_added(nodes):
    # IUBMB reinstated 1.1.3.2 in 2018; ExPASy still lists it as transferred.
    assert nodes["1.1.3.2"]["name"] == CURRENT_EC_NOT_IN_EXPASY["1.1.3.2"]
    assert nodes["1.1.3.2"]["parent_id"] == "1.1.3"
    # 5.6.1.10 is the new number for 3.6.4.10, which ExPASy doesn't have yet.
    assert nodes["5.6.1.10"]["name"] == "non-chaperonin molecular chaperone ATPase"
    assert nodes["5.6.1.10"]["category"] == "Isomerases"


def test_a_number_whose_class_is_missing_is_refused():
    entries = parse_enzyme_dat("ID   9.9.9.9\nDE   made up.\n//\n")
    with pytest.raises(ValueError, match="9.9.9.9"):
        build_ec_nodes(parse_enzclass(ENZCLASS), entries)


# ── Checking JGI's numbers against ExPASy ───────────────────────────────────

def test_numbers_retired_by_expasy_must_be_explained():
    entries = parse_enzyme_dat(ENZYME_DAT)
    # 1.1.3.2 is explained (reinstated); 1.1.1.9 and 3.6.4.99 are not.
    assert unexplained_retired_ids(
        ["1.1.1.1", "1.1.3.2", "1.1.1.9", "3.6.4.99", "1.1.1.-", "7.2.4.8"], entries,
    ) == ["1.1.1.9", "3.6.4.99"]


def test_a_retired_number_in_the_renumbering_table_is_explained():
    entries = parse_enzyme_dat(
        "ID   1.6.1.2\nDE   Transferred entry: 7.1.1.1.\n//\n"
    )
    assert "1.6.1.2" in TRANSFERRED_EC
    assert unexplained_retired_ids(["1.6.1.2"], entries) == []


# ── The real downloaded files ──────────────────────────────────────────────

ENZYME_DIR = DATA_ROOT / "DataStructures" / "Enzyme"


@pytest.fixture(scope="module")
def real():
    enzclass = ENZYME_DIR / "enzclass.txt"
    enzyme_dat = ENZYME_DIR / "enzyme.dat"
    if not (enzclass.exists() and enzyme_dat.exists()):
        pytest.skip(f"ExPASy files not found in {ENZYME_DIR}")
    classes = parse_enzclass(enzclass.read_text(encoding="latin-1"))
    entries = parse_enzyme_dat(enzyme_dat.read_text(encoding="latin-1"))
    return classes, entries, build_ec_nodes(classes, entries)


def test_real_files_have_the_seven_classes(real):
    classes, _, _ = real
    assert [classes[str(i)] for i in range(1, 8)] == [
        "Oxidoreductases", "Transferases", "Hydrolases", "Lyases",
        "Isomerases", "Ligases", "Translocases",
    ]


def test_real_files_known_names(real):
    _, _, nodes = real
    assert nodes["1.1.1.1"]["name"] == "alcohol dehydrogenase"
    assert nodes["2.7.1.1"]["name"] == "hexokinase"
    assert nodes["3.5.1.5"]["name"] == "urease"
    assert nodes["1.13.11.25"]["name"].endswith("4,5-dioxygenase")


def test_every_renumbering_target_is_a_real_node(real):
    _, _, nodes = real
    assert {old: new for old, new in TRANSFERRED_EC.items() if new not in nodes} == {}


def test_expasy_agrees_wherever_it_has_also_retired_the_old_number(real):
    """Where ExPASy itself has moved an old number, the table must send it
    to the same place (or to the shared parent of a split)."""
    _, entries, _ = real
    disagree = {}
    for old, new in TRANSFERRED_EC.items():
        e = entries.get(old)
        if e and e["status"] == "transferred":
            targets = e["transferred_to"]
            if new not in targets and not all(t.startswith(new + ".") for t in targets):
                disagree[old] = (new, targets)
    assert disagree == {}


def test_reinstated_and_new_numbers_are_still_missing_or_retired_in_expasy(real):
    """CURRENT_EC_NOT_IN_EXPASY is only for numbers ExPASy lacks or still
    lists as retired; once ExPASy catches up, its entry should be removed."""
    _, entries, _ = real
    caught_up = [ec for ec in CURRENT_EC_NOT_IN_EXPASY
                 if ec in entries and entries[ec]["status"] == "current"]
    assert caught_up == []
