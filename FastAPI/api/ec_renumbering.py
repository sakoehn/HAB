"""
ec_renumbering.py
==================
How a gene's EC label maps onto a real node of the enzyme tree (built from
the EC numbers themselves, named from ExPASy ENZYME -- see expasy_enzyme.py).
Shared by the data pipeline (EGC_ENZYME_TREE.ipynb, via
Notebooks/enzyme_ec_utils.py) and the API's mappings search
(cache_sql.get_mappings_sql), so a node's chart totals and its gene list are
built from the same rule.
"""


# EC numbers that were renumbered ("transferred") after JGI annotated these
# samples. Maps each old id to where its genes are credited in the current
# tree. Source: the IUBMB enzyme list (enzyme-database.org) and KEGG
# ENZYME, which agree on every entry here. ExPASy ENZYME agrees too where it
# has caught up; as of its 04-Nov-2026 release it still lists 1.2.99.7,
# 3.6.4.10, 3.6.4.12, 3.6.4.13 and sub-subclass 3.6.3 as current, so this
# table is applied before the tree is consulted. Checked 2026-11-16 against
# every fully-specified id in the dataset.
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
# Not renumbered, just unknown: 7.2.4.8 is in neither the IUBMB list nor
# ExPASy, so it keeps the ordinary walk-up to 7.2.4.


# Current EC numbers (per the IUBMB list, checked 2026-11-16) that ExPASy
# ENZYME's 04-Nov-2026 release lacks or still lists as retired, with their
# IUBMB accepted names. The enzyme tree adds these as nodes.
CURRENT_EC_NOT_IN_EXPASY = {
    # IUBMB's new number for 3.6.4.10 (2025); ExPASy has no 5.6.1.10 yet.
    "5.6.1.10": "non-chaperonin molecular chaperone ATPase",
    # Transferred to 1.13.12.4 in 1972 and reinstated in 2018; ExPASy still
    # lists it as transferred.
    "1.1.3.2":  "L-lactate oxidase",
}


def resolve_partial_ec(ec_id: str, nodes) -> str | None:
    """For an EC id not directly in `nodes`, find the deepest real ancestor
    by progressively stripping trailing dot-separated components.

    A partial/wildcard EC (e.g. "3.6.1.-") is never a node, but its
    ancestors usually are. A missing middle level means walking up more
    than one step, so this walks as far as needed.

    Args:
        ec_id: A bare EC id (no "EC:" prefix), possibly partial.
        nodes: The enzyme tree's real node ids (a dict or set).

    Returns:
        The deepest ancestor id that IS in `nodes`, or None if nothing
        resolves at any level.
    """
    parts = ec_id.split('.')
    for n in range(len(parts), 0, -1):
        candidate = '.'.join(parts[:n])
        if candidate in nodes:
            return candidate
    return None


def resolve_or_drop_ec(ec_id: str, nodes) -> str | None:
    """Decide which real node a gene's EC id should register under.

    Handles four cases in one place: a renumbered id (see TRANSFERRED_EC),
    credited to its new place in the tree even if the old number is still
    a node; an id that's already a real node; a partial/wildcard EC
    containing a literal "-" (e.g. "1.1.1.-"); and a FULLY-specified EC
    that's simply absent from the tree (e.g. "7.2.4.8"). The last two walk
    up to their nearest real ancestor -- an EC number's position in the
    hierarchy is fixed by its own digits -- instead of being dropped
    outright. A renumbered id whose new number is itself missing walks up
    from the NEW number, so it never falls back under its old branch.

    Args:
        ec_id: A bare EC id (no "EC:" prefix), fully-specified or partial.
        nodes: The enzyme tree's real node ids (a dict or set).

    Returns:
        The node id the gene registers under, or None if nothing resolves
        at any level (the id should be dropped).
    """
    if ec_id in TRANSFERRED_EC:
        return resolve_partial_ec(TRANSFERRED_EC[ec_id], nodes)
    if ec_id in nodes:
        return ec_id
    return resolve_partial_ec(ec_id, nodes)
