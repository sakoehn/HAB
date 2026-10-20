"""
enzyme_ec_utils.py
====================
Shared helper for EGC_ENZYME_TREE.ipynb's partial/wildcard EC resolution.

Extracted out of the notebook (same pattern as weighted_totals.py /
All_Coverages.py -- imported via sys.path.append, not copy-pasted) so
tests/test_enzyme_ec_resolution.py exercises the REAL implementation, not
a hand-maintained mirror that could silently drift from it.
"""


# EC numbers that were renumbered ("transferred") after JGI annotated these
# samples, so they're absent from the current ko01000.keg. Maps each old id
# to where its genes are credited in the current tree. Source: KEGG ENZYME
# entries ("Obsolete Enzyme -- Transferred to ..."), checked 2026-10-20 for
# every fully-specified id in the dataset that's missing from ko01000.keg.
#
# When an old id was split into several new ones, it maps to their shared
# parent only -- the old label can't say which new enzyme a gene is, and
# crediting all of them would count the gene several times.
TRANSFERRED_EC = {
    "1.2.99.7":  "1.2.8.2",
    "1.3.5.4":   "1.3.5.1",
    "1.4.3.24":  "1.4.2.3",
    "1.6.1.2":   "7.1.1.1",
    "1.8.99.5":  "1.8.1.22",
    "2.1.1.86":  "7.2.1.4",
    "2.3.1.182": "2.3.3.21",
    "2.4.1.129": "2.4.99.28",
    "2.4.99.4":  "2.4.3.4",
    "2.7.7.58":  "6.2.1.71",
    "3.1.22.4":  "3.1.21.10",
    "3.1.3.81":  "3.6.1.75",
    "3.13.1.8":  "3.13.2.3",
    "3.3.1.1":   "3.13.2.1",
    "3.6.4.10":  "5.6.1.10",
    "3.6.4.12":  "5.6.2",      # split: 5.6.2.3, 5.6.2.4 (DNA helicases)
    "3.6.4.13":  "5.6.2",      # split: 5.6.2.5, 5.6.2.6, 5.6.2.7 (RNA helicases)
    "4.3.3.2":   "3.5.99.13",
    "4.99.1.1":  "4.98.1.1",
    # Partial id for retired subclass 3.6.3 (transmembrane ATPases): 53 of
    # its 54 renumbered members moved into class 7 (Translocases), across
    # 7.2/7.4/7.5/7.6 -- so only the class is certain. The one exception,
    # 3.6.3.49 -> 5.6.1.6, is accepted as a known small misattribution.
    "3.6.3.-":   "7",
}
# Not renumbered, just unknown to KEGG: 7.2.4.8 has no ENZYME entry at all,
# so it keeps the ordinary walk-up to 7.2.4.


def resolve_partial_ec(ec_id: str, brite: dict) -> str | None:
    """For an EC id not directly in `brite` (KEGG's ko01000.keg flat node
    dict), find the deepest real ancestor by progressively stripping
    trailing dot-separated components.

    A partial/wildcard EC (e.g. "3.6.1.-") is never a key in `brite`,
    which only contains fully-named nodes parsed from ko01000.keg's
    A/B/C/D lines -- but its ancestors often are. Checked directly
    against all 135 real partial ids seen across the full dataset: 132
    resolve one level up, but 3 (e.g. "3.6.3.-", K03924 moxR's EC) need
    two levels, because even the immediate
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

    Handles four cases in one place: an id that's already a real node; a
    renumbered id (see TRANSFERRED_EC), credited to its new place in the
    tree; a partial/wildcard EC containing a literal "-" (e.g. "1.1.1.-");
    and a FULLY-specified EC that's simply absent from this ko01000.keg
    download (e.g. "3.6.4.99"). The last two walk up to their nearest real
    ancestor -- an EC number's position in the hierarchy is fixed by its
    own digits -- instead of being dropped outright. A renumbered id whose
    new number is itself missing from `brite` walks up from the NEW number,
    so it never falls back under its old branch.

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
    if ec_id in TRANSFERRED_EC:
        return resolve_partial_ec(TRANSFERRED_EC[ec_id], brite)
    return resolve_partial_ec(ec_id, brite)
