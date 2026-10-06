"""
test_enzyme_ec_resolution.py
===============================
E18 (docs/AUDIT-2026-09-22.md): a partial/wildcard EC id (e.g. "3.6.1.-")
is never a key in `brite` (EGC_ENZYME_TREE.ipynb's flat dict of real
ko01000.keg nodes), so it used to be dropped entirely -- the gene it
labels never counted toward ANY of its real ancestor categories, even
though those ancestors ARE real BRITE nodes. resolve_partial_ec()
(Notebooks/enzyme_ec_utils.py, imported by the notebook the same way it
already imports weighted_totals.py/All_Coverages.py -- not defined
inline) fixes this by progressively stripping trailing components until
finding one that IS in brite, then starting the upward-registration walk
there instead of dropping the gene.

Imports the REAL function (not a hand-copied mirror -- an earlier version
of this file did that and it's exactly the kind of drift risk this
project has been burned by before, see test_correlation_output.py's
removal in project memory) so the WALK-UP ALGORITHM has a fast, permanent
regression test on the actual implementation the notebook runs.
Independent of the real-data verification already done when the fix
landed (re-ran the notebook for real: printed "Resolved 135 distinct
partial/wildcard EC ids" and "Dropped 20", exactly matching an
independent investigation against the real dataset; verified specific
real EGC increases in annotation_catalog afterward, including the
audit's own cited K03924 moxR [EC:3.6.3.-] case, which needs TWO levels
of stripping since "3.6.3" itself was never a real ko01000.keg node --
only "3.6" is).

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
# multi-level-strip case the audit's own K03924 moxR example needs.
# Also includes "3.6.4" with no "3.6.4.*" children, to exercise P1
# (docs/AUDIT-2026-10-05.md): a FULLY-specified EC absent from brite
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
    # "3.6.3" deliberately absent -- real gap in ko01000.keg (e.g. an
    # obsoleted/reclassified sub-subclass), confirmed directly against the
    # real file for 3 of the 135 real partial ids seen in the dataset.
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
    # The audit's own cited case: K03924 moxR [EC:3.6.3.-]. "3.6.3" is not
    # a real ko01000.keg node (confirmed directly against the real file),
    # so one strip ("3.6.3") still doesn't resolve -- must fall through to
    # two strips ("3.6"), not stop after the first attempt.
    assert resolve_partial_ec("3.6.3.-", BRITE) == "3.6"


def test_returns_none_when_nothing_resolves_at_any_level():
    assert resolve_partial_ec("9.9.9.-", BRITE) is None


# resolve_or_drop_ec -- P1 (docs/AUDIT-2026-10-05.md): the notebook used
# to only call resolve_partial_ec for ids containing a literal "-",
# dropping any FULLY-specified id missing from brite even when its
# ancestor is a real node. resolve_or_drop_ec wraps all three cases
# (already real / partial / fully-specified-but-missing) in one place
# so the notebook can't re-introduce that dash-only gate by accident.

def test_already_real_node_is_returned_as_is():
    assert resolve_or_drop_ec("1.1.1.1", BRITE) == "1.1.1.1"


def test_partial_id_still_resolves_via_or_drop():
    assert resolve_or_drop_ec("3.6.1.-", BRITE) == "3.6.1"


def test_fully_specified_id_missing_from_brite_resolves_like_a_partial_id():
    # The actual P1 bug: "3.6.4.99" has no "-" in it, so the old notebook
    # gate dropped it outright even though "3.6.4" IS a real ancestor.
    assert resolve_or_drop_ec("3.6.4.99", BRITE) == "3.6.4"


def test_fully_specified_id_with_no_resolvable_ancestor_is_dropped():
    assert resolve_or_drop_ec("9.9.9.9", BRITE) is None
