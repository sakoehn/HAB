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


def lineage_segments(raw: str | None) -> list[str]:
    """Split a raw lineage into its rank names, domain first.

    The one split shared by EGC_TAX_TREE.ipynb (whose taxon ids are the
    names joined up to each rank) and taxon_paths (one column per rank), so
    every rank lands at the same position in both. Each name is stripped
    and empty trailing ranks are dropped. An empty rank before a real one
    has no reading both can share -- skipping it would shift every rank
    below up a level -- so it is refused; none occurs in the real data.

    Args:
        raw: A raw lineage string, or None/"".

    Returns:
        The rank names, at most RANK_COUNT; [] when there are none.

    Raises:
        ValueError: if an empty rank comes before a non-empty one.
    """
    if not raw:
        return []
    parts = [p.strip() for p in normalize_lineage(raw).split(";")]
    while parts and not parts[-1]:
        parts.pop()
    if "" in parts:
        raise ValueError(f"lineage has an empty rank before a real one: {raw!r}")
    return parts
