"""
taxon_lineage.py
================
How a raw phylodist lineage string becomes a taxon id. A lineage has 8
ranks (domain .. strain) separated by ";", and a taxon's id is its lineage
up to its own rank, joined by ";" -- so the app reads a taxon's rank and
name straight from the id's segments.

A strain name can itself contain ";" (e.g. "Drosophila melanogaster y; cn
bw sp"), which would split into a fake 9th rank. normalize_lineage keeps
everything from the 8th part on as one strain and writes its inner ";" as
", ". Every other lineage is returned unchanged.

Shared by the data pipeline (EGC_TAX_TREE.ipynb, migrate_mappings_to_sql.py)
and the one-off fix_semicolon_strains.py, so they can't disagree.
"""

RANK_COUNT = 8


def normalize_lineage(raw: str | None) -> str | None:
    """Return `raw` with at most RANK_COUNT ";"-separated parts.

    Args:
        raw: A raw lineage string, or None/"".

    Returns:
        `raw` itself if it has RANK_COUNT parts or fewer; otherwise the first
        RANK_COUNT - 1 parts unchanged, followed by the rest joined with
        ", " (each part stripped) as the strain.
    """
    if not raw:
        return raw
    parts = raw.split(";")
    if len(parts) <= RANK_COUNT:
        return raw
    strain = ", ".join(p.strip() for p in parts[RANK_COUNT - 1:])
    return ";".join(parts[:RANK_COUNT - 1] + [strain])
