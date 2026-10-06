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


def resolve_or_drop_ec(ec_id: str, brite: dict) -> str | None:
    """Decide which real `brite` node a gene's EC id should register under.

    P1 (docs/AUDIT-2026-10-05.md): `resolve_partial_ec` used to only be
    called for ids containing a literal "-" (a partial/wildcard EC like
    "1.1.1.-"). But a FULLY-specified EC that's simply absent from this
    ko01000.keg download (e.g. "3.6.4.99") has a real, structural parent
    too -- an EC number's position in the hierarchy is fixed by its own
    digits, not something to infer -- so it deserves the exact same
    walk-up instead of being dropped outright. This wraps both cases
    (and the "already a real node" case) in one place so the notebook
    doesn't hand-roll the branching inline, where E18's original fix
    nearly missed this exact case.

    Args:
        ec_id: A bare EC id (no "EC:" prefix), fully-specified or partial.
        brite: Flat dict of real ko01000.keg nodes, keyed by id string.

    Returns:
        `ec_id` itself if already a real `brite` key, its deepest real
        ancestor if not, or None if nothing resolves at any level (the id
        should be dropped).
    """
    if ec_id in brite:
        return ec_id
    return resolve_partial_ec(ec_id, brite)
