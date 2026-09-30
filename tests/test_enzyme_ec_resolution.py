"""
test_enzyme_ec_resolution.py
===============================
E18 (docs/AUDIT-2026-09-22.md): a partial/wildcard EC id (e.g. "3.6.1.-")
is never a key in `brite` (EGC_ENZYME_TREE.ipynb's flat dict of real
ko01000.keg nodes), so it used to be dropped entirely -- the gene it
labels never counted toward ANY of its real ancestor categories, even
though those ancestors ARE real BRITE nodes. The notebook's own
`resolve_partial_ec()` (cell id fb768e5f) fixes this by progressively
stripping trailing components until finding one that IS in brite, then
starting the upward-registration walk there instead of dropping the gene.

This mirrors that function's logic (it lives inside the notebook, not an
importable script -- same accepted duplication pattern already used
between EGC_ENZYME_TREE.ipynb's own BRITE-parsing cell and
migrate_enzyme_paths_to_sql.py's iter_enzyme_path_rows, per that script's
own docstring) so the WALK-UP ALGORITHM itself has a fast, permanent,
synthetic regression test -- independent of the real-data verification
already done when the fix landed (re-ran the notebook for real: printed
"Resolved 135 distinct partial/wildcard EC ids" and "Dropped 20", exactly
matching an independent investigation against the real dataset; verified
specific real EGC increases in annotation_catalog afterward, including
the audit's own cited K03924 moxR [EC:3.6.3.-] case, which needs TWO
levels of stripping since "3.6.3" itself was never a real ko01000.keg
node -- only "3.6" is).

Run:
    pytest tests/test_enzyme_ec_resolution.py -v
"""


def resolve_partial_ec(ec_id: str, brite: dict) -> str | None:
    """Mirrors EGC_ENZYME_TREE.ipynb's resolve_partial_ec() exactly."""
    parts = ec_id.split('.')
    for n in range(len(parts), 0, -1):
        candidate = '.'.join(parts[:n])
        if candidate in brite:
            return candidate
    return None


# A small synthetic BRITE dict -- deliberately includes a gap at "3.6.3"
# (present at depth 1 and 2, but NOT depth 3) to exercise the real
# multi-level-strip case the audit's own K03924 moxR example needs.
BRITE = {
    "1":       {"depth": 1},
    "1.1":     {"depth": 2},
    "1.1.1":   {"depth": 3},
    "1.1.1.1": {"depth": 4},
    "3":       {"depth": 1},
    "3.6":     {"depth": 2},
    "3.6.1":   {"depth": 3},
    "3.6.1.23": {"depth": 4},
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
