"""
enzyme_ec_utils.py
====================
Shared helper for EGC_ENZYME_TREE.ipynb's partial/wildcard EC resolution
(E18, docs/AUDIT-2026-09-22.md).

Extracted out of the notebook (same pattern as weighted_totals.py /
All_Coverages.py -- imported via sys.path.append, not copy-pasted) so
tests/test_enzyme_ec_resolution.py exercises the REAL implementation, not
a hand-maintained mirror that could silently drift from it.
"""


def resolve_partial_ec(ec_id: str, brite: dict) -> str | None:
    """For an EC id not directly in `brite` (KEGG's ko01000.keg flat node
    dict), find the deepest real ancestor by progressively stripping
    trailing dot-separated components.

    A partial/wildcard EC (e.g. "3.6.1.-") is never a key in `brite`,
    which only contains fully-named nodes parsed from ko01000.keg's
    A/B/C/D lines -- but its ancestors often are. Checked directly
    against all 135 real partial ids seen across the full dataset: 132
    resolve one level up, but 3 (e.g. "3.6.3.-", the audit's own cited
    K03924 moxR example) need two levels, because even the immediate
    parent isn't its own separate BRITE entry -- so this always walks up
    as far as needed, not just one fixed step.

    Args:
        ec_id: A bare EC id (no "EC:" prefix), possibly partial.
        brite: Flat dict of real ko01000.keg nodes, keyed by id string.

    Returns:
        The deepest ancestor id that IS a real key in `brite`, or None if
        nothing resolves at any level.
    """
    parts = ec_id.split('.')
    for n in range(len(parts), 0, -1):
        candidate = '.'.join(parts[:n])
        if candidate in brite:
            return candidate
    return None
