"""
test_enzyme_ec_resolution.py
===============================
A partial/wildcard EC id (e.g. "3.6.1.-") is never a key in the
enzyme tree's flat node dict (EGC_ENZYME_TREE.ipynb, built from ExPASy
ENZYME), but its ancestors usually are. resolve_partial_ec() (Notebooks/enzyme_ec_utils.py,
imported by the notebook the same way it imports
weighted_totals.py/All_Coverages.py) progressively strips trailing
components until finding one that IS a node, so the gene registers
under its real ancestors instead of being dropped.

Imports the REAL function, not a hand-copied mirror, so the walk-up
algorithm is tested on the actual implementation the notebook runs. On
the real dataset the notebook resolves 135 distinct partial/wildcard EC
ids; a missing middle level needs more than one strip (see the 3.6.3
gap in the dict below).

Run:
    pytest tests/test_enzyme_ec_resolution.py -v
"""

import os
import sys
from pathlib import Path

DATA_ROOT = Path(os.environ.get("HAB_DATA_ROOT", Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(DATA_ROOT / "Notebooks"))

from enzyme_ec_utils import resolve_partial_ec, resolve_or_drop_ec  # noqa: E402


# A small synthetic BRITE dict -- deliberately includes a gap at "3.6.3"
# (present at depth 1 and 2, but NOT depth 3) to exercise the real
# multi-level-strip case K03924 moxR's EC needs. Also includes "3.6.4"
# with no "3.6.4.*" children, to exercise a FULLY-specified EC absent from brite
# (no dash, not a wildcard) that still has a resolvable real ancestor.
BRITE = {
    "1":       {"depth": 1},
    "1.1":     {"depth": 2},
    "1.1.1":   {"depth": 3},
    "1.1.1.1": {"depth": 4},
    "3":       {"depth": 1},
    "3.6":     {"depth": 2},
    "3.6.1":   {"depth": 3},
    "3.6.1.23": {"depth": 4},
    "3.6.4":   {"depth": 3},
    # "3.6.3" deliberately absent -- a retired sub-subclass, so a partial
    # id under it has to be stripped twice.
}


def test_fully_resolved_id_is_not_touched():
    # Not actually a case resolve_partial_ec is called for in the
    # notebook (only reached when ec_id is NOT already in brite), but
    # confirms it's a no-op / correctly a self-match when it is.
    assert resolve_partial_ec("1.1.1.1", BRITE) == "1.1.1.1"


def test_one_level_partial_resolves_to_its_immediate_parent():
    assert resolve_partial_ec("3.6.1.-", BRITE) == "3.6.1"


def test_two_level_partial_resolves_to_its_grandparent():
    assert resolve_partial_ec("1.1.-.-", BRITE) == "1.1"


def test_class_level_partial_resolves_to_the_class_itself():
    assert resolve_partial_ec("3.-", BRITE) == "3"


def test_needs_two_strips_when_the_immediate_parent_is_itself_missing_from_brite():
    # "3.6.3" is not a node in this dict,
    # so one strip ("3.6.3") still doesn't resolve -- must fall through to
    # two strips ("3.6"), not stop after the first attempt.
    assert resolve_partial_ec("3.6.3.-", BRITE) == "3.6"


def test_returns_none_when_nothing_resolves_at_any_level():
    assert resolve_partial_ec("9.9.9.-", BRITE) is None


# resolve_or_drop_ec wraps all three cases (already real / partial /
# fully-specified-but-missing) in one place, so a FULLY-specified id
# missing from brite walks up to its real ancestor too, instead of only
# ids containing a literal "-".

def test_already_real_node_is_returned_as_is():
    assert resolve_or_drop_ec("1.1.1.1", BRITE) == "1.1.1.1"


def test_partial_id_still_resolves_via_or_drop():
    assert resolve_or_drop_ec("3.6.1.-", BRITE) == "3.6.1"


def test_fully_specified_id_missing_from_brite_resolves_like_a_partial_id():
    # "3.6.4.99" has no "-" in it, but "3.6.4" IS a real ancestor, so it
    # must resolve there rather than be dropped.
    assert resolve_or_drop_ec("3.6.4.99", BRITE) == "3.6.4"


def test_fully_specified_id_with_no_resolvable_ancestor_is_dropped():
    assert resolve_or_drop_ec("9.9.9.9", BRITE) is None


# ── Transferred (renumbered) EC numbers ─────────────────────────────────────
# An EC number that was renumbered is credited to its NEW place in the tree,
# not walked up under its old one -- e.g. DNA helicase 3.6.4.12 now lives in
# Isomerases (5.6.2.3 / 5.6.2.4), not Hydrolases (3.6.4). When one old
# number was split into several new ones, the gene is credited to their
# shared parent only, since the old label can't say which one it was.

BRITE_WITH_NEW_HOMES = {
    **BRITE,
    "5":       {"depth": 1},
    "5.6":     {"depth": 2},
    "5.6.2":   {"depth": 3},
    "5.6.2.3": {"depth": 4},
    "5.6.2.4": {"depth": 4},
    "7":       {"depth": 1},
    "7.1":     {"depth": 2},
    "7.1.1":   {"depth": 3},
    "7.1.1.1": {"depth": 4},
}


def test_renumbered_id_is_credited_to_its_new_number():
    # 1.6.1.2 (NAD(P)+ transhydrogenase) was transferred to 7.1.1.1.
    assert resolve_or_drop_ec("1.6.1.2", BRITE_WITH_NEW_HOMES) == "7.1.1.1"


def test_id_split_into_several_new_numbers_is_credited_to_their_shared_parent():
    # 3.6.4.12 was split into 5.6.2.3 and 5.6.2.4 -- credit 5.6.2 only,
    # not either specific one, and not its old Hydrolases home (3.6.4).
    assert resolve_or_drop_ec("3.6.4.12", BRITE_WITH_NEW_HOMES) == "5.6.2"


def test_retired_partial_subclass_is_credited_to_where_its_members_went():
    # Subclass 3.6.3 was retired; 53 of its 54 renumbered members moved to
    # class 7 (Translocases), so "3.6.3.-" is credited to class 7.
    assert resolve_or_drop_ec("3.6.3.-", BRITE_WITH_NEW_HOMES) == "7"


def test_new_number_missing_from_brite_walks_up_from_the_new_number():
    # If the tree ever lacks the new leaf, the gene still
    # lands in the new branch (7.1.1), never back under the old one (1.6.1).
    brite = {k: v for k, v in BRITE_WITH_NEW_HOMES.items() if k != "7.1.1.1"}
    assert resolve_or_drop_ec("1.6.1.2", brite) == "7.1.1"


def test_unknown_missing_id_still_walks_up_from_its_own_number():
    # 3.6.4.99 isn't a known renumbering, so the original walk-up applies.
    assert resolve_or_drop_ec("3.6.4.99", BRITE_WITH_NEW_HOMES) == "3.6.4"


def test_renumbered_id_is_moved_even_when_the_old_number_is_still_a_node():
    # ExPASy still lists DNA helicase 3.6.4.12 as current, but IUBMB moved
    # it to 5.6.2.3 / 5.6.2.4 in 2021 -- the table wins.
    nodes = {**BRITE_WITH_NEW_HOMES, "3.6.4.12": {"depth": 4}}
    assert resolve_or_drop_ec("3.6.4.12", nodes) == "5.6.2"
