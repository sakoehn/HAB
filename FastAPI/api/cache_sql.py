"""
cache_sql.py
============
SQL (SQLite) query layer for DATA_BACKEND=sql. Each function takes an
open sqlite3.Connection (created by api.db.connect_to_sql, stored on
app.state.sql_conn) and returns plain dicts/lists that routes.py's sql
branches return directly as JSON.

Schema is created by scripts/create_sql_schema.py and populated by the
scripts/migrate_*_sql.py scripts -- see those files for table
definitions and column meanings.
"""

import sqlite3

# annotation_series.depth (taxonomy rows only) -> the taxon_paths column
# it corresponds to. 1=domain .. 8=strain, same order taxon_paths' columns
# were built in (see parse_taxon_path() in migrate_mappings_to_sql.py).
# "class_"/"order" match those columns' real names exactly (class_ to
# avoid the Python keyword; "order" double-quoted since it's a SQL
# reserved word).
RANK_COLUMNS = {
    1: "domain",
    2: "phylum",
    3: "class_",
    4: '"order"',
    5: "family",
    6: "genus",
    7: "species",
    8: "strain",
}

_ALL_SAMPLES_SQL_CACHE = None

def taxon_paths_under(conn: sqlite3.Connection, lineage_prefix: str) -> list[sqlite3.Row]:
    """Return every taxon_paths row that IS `lineage_prefix` or has it as
    an ancestor -- e.g. lineage_prefix="Bacteria;Bacteroidetes" returns
    every full lineage under that phylum, not a single row.

    Args:
        conn: Open SQLite connection.
        lineage_prefix: Lineage-prefix string to match, e.g.
            "Bacteria;Bacteroidetes".

    Returns:
        Matching taxon_paths rows, possibly empty.
    """
    query = "SELECT * FROM taxon_paths WHERE full_path = ? OR substr(full_path, 1, ?) = ?"
    cursor = conn.execute(query, (lineage_prefix, len(lineage_prefix) + 1, lineage_prefix + ';'))
    return cursor.fetchall()


def get_annotation_series_sql(conn: sqlite3.Connection, source: str, annotation_id: str) -> list[dict]:
    """Return one row per sample that has this annotation, for the
    /series/annotations and /annotations/scaffolds/summary routes.

    Args:
        conn: Open SQLite connection.
        source: Annotation source ("cog", "kegg", "enzyme", "taxonomy").
        annotation_id: Annotation ID to look up.

    Returns:
        List of dicts keyed sample_name, name, category, egc, norm_egc,
        scaffold_count, gene_count. scaffold_count/gene_count are
        precomputed at migration time; individual scaffold rows live in
        the separate `scaffolds` table (see get_annotation_scaffolds_sql).
    """
    query = """
        SELECT sample AS sample_name, name, category, egc, norm_egc, scaffold_count, gene_count
        FROM annotation_series
        WHERE source = ? AND annotation_id = ?
    """
    cursor = conn.execute(query, (source, annotation_id))
    rows = cursor.fetchall()
    return [
        {
            "sample_name":    sample_name,
            "name":           name,
            "category":       category,
            "egc":            egc,
            "norm_egc":       norm_egc,
            "scaffold_count": scaffold_count,
            "gene_count":     gene_count,
        }
        for sample_name, name, category, egc, norm_egc, scaffold_count, gene_count in rows
    ]


def get_all_sample_names_sql(conn: sqlite3.Connection) -> list[str]:
    """Return every sample name, sorted lexicographically.

    Cached at module level after the first call -- the underlying query
    scans the full `mappings` table (~74M rows), so repeat calls reuse
    the cached list instead of re-scanning.

    Args:
        conn: Open SQLite connection.

    Returns:
        Sorted list of sample names.
    """
    global _ALL_SAMPLES_SQL_CACHE
    if _ALL_SAMPLES_SQL_CACHE is None:
        query = "SELECT DISTINCT sample FROM mappings ORDER BY sample"
        cursor = conn.execute(query)
        rows = cursor.fetchall()
        _ALL_SAMPLES_SQL_CACHE = [row[0] for row in rows]
    return _ALL_SAMPLES_SQL_CACHE

def get_taxonomy_children_sql(conn: sqlite3.Connection, parent: str | None, depth: int | None = None) -> list[dict]:
    """Return the direct children of a taxon, built from `taxon_paths`.

    Args:
        conn: Open SQLite connection.
        parent: Taxon name to find children of. None returns the four
            domain roots (Archaea, Bacteria, Eukaryota, Viruses).
        depth: Rank of `parent`, if already known (e.g. echoed back from a
            prior response). If None, derived from `parent`'s own lineage
            length.

    Returns:
        List of dicts keyed annotation_id, depth, category, sorted by
        annotation_id. Empty list if `parent` is a leaf rank (depth=8) or
        has no children.
    """
    if parent is None:
        # domain roots, no depth needed
        query = "SELECT DISTINCT domain AS annotation_id, domain AS name, 1 AS depth, domain AS category FROM taxon_paths"
        cursor = conn.execute(query)
        rows = cursor.fetchall()
        return [{"annotation_id": row[0], "name": row[1], "depth": row[2], "category": row[3]} for row in rows]

    if depth is None:
        depth = len(parent.split(';'))
    next_depth = depth + 1
    next_column = RANK_COLUMNS.get(next_depth)
    if next_column is None:
        return []  # strain is a real leaf rank -- no children below it

    rows = taxon_paths_under(conn, parent)
    children_by_id = {}
    for row in rows:
        child_name = row[next_depth]
        if not child_name:
            continue
        child_key = f"{parent};{child_name}"
        if child_key not in children_by_id:
            children_by_id[child_key] = {
                "annotation_id": child_key,
                "name":          child_name,
                "depth":         next_depth,
                "category":      row[1],
            }

    return sorted(children_by_id.values(), key=lambda c: c["annotation_id"])


# Depth (1=A..4=D) -> the (id_column, name_column) pair on kegg_paths that
# holds that level. Verified disjoint against real data: no KEGG id
# appears in more than one level's column, so a bare id unambiguously
# identifies its own depth -- unlike taxonomy, which needs a full
# lineage-prefix string for that (see RANK_COLUMNS above).
KEGG_LEVEL_COLUMNS = {
    1: ("a_id", "a_name"),
    2: ("b_id", "b_name"),
    3: ("c_id", "c_name"),
    4: ("d_id", "d_name"),
}


def _kegg_node_depth(conn: sqlite3.Connection, node_id: str) -> int | None:
    """Return which level (1=A..4=D) a KEGG node id belongs to, by
    checking which kegg_paths column actually contains it.

    Args:
        conn: Open SQLite connection.
        node_id: A KEGG annotation id, e.g. '00010' or 'K00844'.

    Returns:
        The depth (1-4), or None if node_id isn't in kegg_paths at all.
    """
    for depth, (id_col, _name_col) in KEGG_LEVEL_COLUMNS.items():
        row = conn.execute(f"SELECT 1 FROM kegg_paths WHERE {id_col} = ? LIMIT 1", (node_id,)).fetchone()
        if row is not None:
            return depth
    return None


def get_kegg_children_sql(conn: sqlite3.Connection, parent_id: str | None, depth: int | None = None) -> list[dict]:
    """Return the direct children of a KEGG node, built from `kegg_paths`.

    Args:
        conn: Open SQLite connection.
        parent_id: KEGG node id to find children of. None returns the
            A-level roots (Metabolism, Human Diseases, etc.).
        depth: Level of `parent_id` (1=A..4=D), if already known. If None,
            derived via _kegg_node_depth.

    Returns:
        List of dicts keyed annotation_id, name, depth, category, sorted
        by annotation_id. Empty list if `parent_id` is a leaf KO (depth=4),
        an unknown id, or has no children.
    """
    if parent_id is None:
        query = "SELECT DISTINCT a_id AS annotation_id, a_name AS name, 1 AS depth, a_name AS category FROM kegg_paths"
        cursor = conn.execute(query)
        return [
            {"annotation_id": row[0], "name": row[1], "depth": row[2], "category": row[3]}
            for row in cursor.fetchall()
        ]

    if depth is None:
        depth = _kegg_node_depth(conn, parent_id)
        if depth is None:
            return []  # parent_id isn't a real KEGG node at all

    next_depth = depth + 1
    next_columns = KEGG_LEVEL_COLUMNS.get(next_depth)
    if next_columns is None:
        return []  # D is a real leaf level -- no children below it

    id_col, _ = KEGG_LEVEL_COLUMNS[depth]
    next_id_col, next_name_col = next_columns

    query = f"""
        SELECT DISTINCT {next_id_col} AS annotation_id, {next_name_col} AS name, a_name AS category
        FROM kegg_paths
        WHERE {id_col} = ? AND {next_id_col} IS NOT NULL
    """
    cursor = conn.execute(query, (parent_id,))
    return sorted(
        (
            {"annotation_id": row[0], "name": row[1], "depth": next_depth, "category": row[2]}
            for row in cursor.fetchall()
        ),
        key=lambda c: c["annotation_id"],
    )


def get_kegg_path_sql(conn: sqlite3.Connection, annotation_id: str) -> dict | None:
    """Return every real ancestor path (root to node) for a KEGG node, for
    auto-expanding/highlighting a node in the hierarchy popup -- and for
    letting the user switch between real paths when there's more than one.

    A KEGG node can have multiple real parents (E14 -- e.g. K00844/
    hexokinase has 14 real pathway occurrences in ko00001.keg), so
    annotation_catalog.parent alone isn't enough here: it stores one
    last-occurrence-wins "display" parent per node, which for a
    multi-parent KO is often an incidental catch-all (e.g. "Brite
    Hierarchies") rather than a biologically meaningful path. This reads
    kegg_paths directly instead.

    GROUP BY is required, not just ORDER BY id: for a node shallower than
    depth=4 (e.g. a pathway like '00010', or a branch), kegg_paths has one
    RAW ROW per real full 4-level occurrence, so most of those rows share
    the exact same truncated ancestor chain up to this node's own depth
    (confirmed against real data: '00010' has 87 raw rows, one per real
    child KO, but exactly 1 distinct ancestor path) -- without GROUP BY,
    path_count would wildly overcount for anything shallower than a leaf.
    MIN(id) keeps each group's earliest (file-order) row so paths stay
    sorted the same way the single-path version was.

    Args:
        conn: Open SQLite connection.
        annotation_id: A KEGG annotation id, e.g. '00010' or 'K00844'.

    Returns:
        {"annotation_id": ..., "paths": [[{"annotation_id","name","depth"}, ...], ...]
         (each inner list root-to-node order, sorted by first real
         occurrence), "path_count": N}, or None if annotation_id isn't a
         real KEGG node at all. path_count == len(paths); N > 1 only for
         genuinely multi-parent nodes (KEGG only -- COG/Enzyme never have
         this case, see get_cog_path_sql/get_enzyme_path_sql).
    """
    depth = _kegg_node_depth(conn, annotation_id)
    if depth is None:
        return None

    id_col, _ = KEGG_LEVEL_COLUMNS[depth]
    cols = [c for d in range(1, depth + 1) for c in KEGG_LEVEL_COLUMNS[d]]
    col_list = ", ".join(cols)

    rows = conn.execute(
        f"""
        SELECT {col_list}, MIN(id) AS first_id
        FROM kegg_paths WHERE {id_col} = ?
        GROUP BY {col_list}
        ORDER BY first_id ASC
        """,
        (annotation_id,),
    ).fetchall()

    paths = [
        [
            {"annotation_id": row[(d - 1) * 2], "name": row[(d - 1) * 2 + 1], "depth": d}
            for d in range(1, depth + 1)
        ]
        for row in rows
    ]
    return {"annotation_id": annotation_id, "paths": paths, "path_count": len(paths)}


def get_kegg_immediate_parents_bulk_sql(conn: sqlite3.Connection, annotation_ids: list[str]) -> dict[str, list[dict]]:
    """Return every real IMMEDIATE parent (one level up) for each of
    `annotation_ids`, for bucketing a list of KEGG nodes by parent group
    (W30a, docs/AUDIT-2026-09-22.md) -- a single id-at-a-time call to
    get_kegg_path_sql for every row in a 200-row list would be 200 round
    trips; this does it in at most 3 queries total (one per non-root
    depth), regardless of how many ids are passed.

    Resolves each id at the DEEPEST column it's found in across depths
    4->2 (not get_kegg_path_sql's per-id `_kegg_node_depth`, which only
    checks in 1->4 order) -- a real KEGG id only ever appears at one
    consistent depth across all its real occurrences (confirmed directly:
    0 of 547 real C-level nodes and 0 of 55 real B-level nodes are ever
    multi-parent, i.e. a node's OWN depth never varies even when its
    ancestors do), so this is equivalent for real ids, but doesn't rely on
    a separate depth-detection pass per id.

    Args:
        conn: Open SQLite connection.
        annotation_ids: KEGG annotation ids to resolve (any depth, mixed
            depths within the same call are fine).

    Returns:
        {annotation_id: [{"annotation_id", "name"}, ...]} -- one entry
        per id passed in (always present, even if real depth is 1 / a
        root with no parent, or the id isn't a real KEGG node at all --
        both give an empty list, not a missing key). More than one entry
        in a list only for a genuinely multi-parent id.
    """
    result: dict[str, list[dict]] = {aid: [] for aid in annotation_ids}
    remaining = set(annotation_ids)

    for depth in (4, 3, 2):
        if not remaining:
            break
        id_col, _ = KEGG_LEVEL_COLUMNS[depth]
        parent_id_col, parent_name_col = KEGG_LEVEL_COLUMNS[depth - 1]
        ids_to_check = list(remaining)
        placeholders = ", ".join("?" * len(ids_to_check))
        rows = conn.execute(
            f"""
            SELECT DISTINCT {id_col}, {parent_id_col}, {parent_name_col}
            FROM kegg_paths
            WHERE {id_col} IN ({placeholders}) AND {parent_id_col} IS NOT NULL
            """,
            ids_to_check,
        ).fetchall()
        found_at_this_depth = set()
        for node_id, parent_id, parent_name in rows:
            result[node_id].append({"annotation_id": parent_id, "name": parent_name})
            found_at_this_depth.add(node_id)
        remaining -= found_at_this_depth

    return result


# Depth (1=A..4=D) -> the (id_column, name_column) pair on enzyme_paths that
# holds that level -- same column shape as kegg_paths (EC hierarchy is also
# exactly 4 levels: class, subclass, sub-subclass, full EC number).
ENZYME_LEVEL_COLUMNS = {
    1: ("a_id", "a_name"),
    2: ("b_id", "b_name"),
    3: ("c_id", "c_name"),
    4: ("d_id", "d_name"),
}


def _enzyme_node_exists(conn: sqlite3.Connection, node_id: str) -> bool:
    """Return whether `node_id` is a real EC id in enzyme_paths, at the
    depth its own string implies.

    Unlike _kegg_node_depth, this doesn't need to probe every level
    column -- an EC id's depth is already known from its own dot count
    (see get_enzyme_children_sql's docstring), so this goes straight to
    the one column that depth implies.

    Args:
        conn: Open SQLite connection.
        node_id: An EC id, e.g. "1.1.1.1".

    Returns:
        True if real, False otherwise -- including for a malformed id
        whose dot count doesn't correspond to a real level (1-4).
    """
    depth = len(node_id.split('.'))
    id_col, _ = ENZYME_LEVEL_COLUMNS.get(depth, (None, None))
    if id_col is None:
        return False
    row = conn.execute(f"SELECT 1 FROM enzyme_paths WHERE {id_col} = ? LIMIT 1", (node_id,)).fetchone()
    return row is not None


def get_enzyme_children_sql(conn: sqlite3.Connection, parent_id: str | None, depth: int | None = None) -> list[dict]:
    """Return the direct children of an Enzyme (EC) node, built from
    `enzyme_paths`.

    Args:
        conn: Open SQLite connection.
        parent_id: EC id to find children of, e.g. "1.1.1". None returns
            the 7 top-level EC classes (Oxidoreductases, Transferases, etc.).
        depth: Level of `parent_id` (1-4), if already known. If None,
            derived from `parent_id`'s own dot count. Unlike KEGG ids, an
            EC id's depth is readable directly from its own text -- "1.1.1"
            is unambiguously depth 3 -- the same way taxonomy's
            lineage-prefix depth is derived from `len(parent.split(';'))`,
            so no kegg-style column-membership lookup is needed here.

    Returns:
        List of dicts keyed annotation_id, name, depth, category, sorted
        by annotation_id. Empty list if `parent_id` is a leaf EC number
        (depth=4), an unknown id, or has no children.
    """
    if parent_id is None:
        query = "SELECT DISTINCT a_id AS annotation_id, a_name AS name, 1 AS depth, a_name AS category FROM enzyme_paths"
        cursor = conn.execute(query)
        return [
            {"annotation_id": row[0], "name": row[1], "depth": row[2], "category": row[3]}
            for row in cursor.fetchall()
        ]

    if depth is None:
        depth = len(parent_id.split('.'))

    next_depth = depth + 1
    next_columns = ENZYME_LEVEL_COLUMNS.get(next_depth)
    if next_columns is None:
        return []  # a full EC number (depth=4) is a real leaf -- no children below it

    id_col, _ = ENZYME_LEVEL_COLUMNS.get(depth, (None, None))
    if id_col is None:
        return []  # depth outside 1-4 -- not a real EC id at all
    next_id_col, next_name_col = next_columns

    query = f"""
        SELECT DISTINCT {next_id_col} AS annotation_id, {next_name_col} AS name, a_name AS category
        FROM enzyme_paths
        WHERE {id_col} = ? AND {next_id_col} IS NOT NULL
    """
    cursor = conn.execute(query, (parent_id,))
    return sorted(
        (
            {"annotation_id": row[0], "name": row[1], "depth": next_depth, "category": row[2]}
            for row in cursor.fetchall()
        ),
        key=lambda c: c["annotation_id"],
    )


def get_enzyme_path_sql(conn: sqlite3.Connection, annotation_id: str) -> dict | None:
    """Return every real ancestor path (root to node) for an Enzyme (EC)
    node, for auto-expanding/highlighting a node in the hierarchy popup.
    Same GROUP BY-deduplicated shape as get_kegg_path_sql for response
    parity, even though every EC id has exactly one real parent (see
    get_enzyme_children_sql's docstring) -- `paths` will always have
    exactly 1 entry here, never the "N real paths" case KEGG has.

    Args:
        conn: Open SQLite connection.
        annotation_id: An EC id, e.g. "1.1.1.1".

    Returns:
        {"annotation_id": ..., "paths": [[{"annotation_id","name","depth"}, ...]],
         "path_count": 1}, or None if annotation_id isn't a real EC id at all.
    """
    depth = len(annotation_id.split('.'))
    id_col, _ = ENZYME_LEVEL_COLUMNS.get(depth, (None, None))
    if id_col is None or not _enzyme_node_exists(conn, annotation_id):
        return None

    cols = [c for d in range(1, depth + 1) for c in ENZYME_LEVEL_COLUMNS[d]]
    col_list = ", ".join(cols)

    rows = conn.execute(
        f"""
        SELECT {col_list}, MIN(id) AS first_id
        FROM enzyme_paths WHERE {id_col} = ?
        GROUP BY {col_list}
        ORDER BY first_id ASC
        """,
        (annotation_id,),
    ).fetchall()

    paths = [
        [
            {"annotation_id": row[(d - 1) * 2], "name": row[(d - 1) * 2 + 1], "depth": d}
            for d in range(1, depth + 1)
        ]
        for row in rows
    ]
    return {"annotation_id": annotation_id, "paths": paths, "path_count": len(paths)}


# Depth (1=category, 2=specific COG id) -> the (id_column, name_column)
# pair on cog_paths that holds that level. Only 2 levels, unlike KEGG/
# Enzyme's 4 -- a COG category letter has no further real subdivision.
COG_LEVEL_COLUMNS = {
    1: ("a_id", "a_name"),
    2: ("b_id", "b_name"),
}


def _cog_node_depth(conn: sqlite3.Connection, node_id: str) -> int | None:
    """Return which level (1=category, 2=specific COG id) a COG node id
    belongs to, by checking which cog_paths column actually contains it --
    same column-membership approach as _kegg_node_depth, since a bare COG
    id/category letter carries no depth information in its own text.

    Args:
        conn: Open SQLite connection.
        node_id: A COG annotation id, e.g. 'C' or 'COG0055'.

    Returns:
        The depth (1-2), or None if node_id isn't in cog_paths at all.
    """
    for depth, (id_col, _name_col) in COG_LEVEL_COLUMNS.items():
        row = conn.execute(f"SELECT 1 FROM cog_paths WHERE {id_col} = ? LIMIT 1", (node_id,)).fetchone()
        if row is not None:
            return depth
    return None


def get_cog_children_sql(conn: sqlite3.Connection, parent_id: str | None, depth: int | None = None) -> list[dict]:
    """Return the direct children of a COG node, built from `cog_paths`.

    Args:
        conn: Open SQLite connection.
        parent_id: COG node id to find children of. None returns the
            category-letter roots (Energy production and conversion, etc.).
        depth: Level of `parent_id` (1=category, 2=specific COG id), if
            already known. If None, derived via _cog_node_depth.

    Returns:
        List of dicts keyed annotation_id, name, depth, category, sorted
        by annotation_id. Empty list if `parent_id` is a leaf COG id
        (depth=2), an unknown id, or has no children.
    """
    if parent_id is None:
        query = "SELECT DISTINCT a_id AS annotation_id, a_name AS name, 1 AS depth, a_name AS category FROM cog_paths"
        cursor = conn.execute(query)
        return [
            {"annotation_id": row[0], "name": row[1], "depth": row[2], "category": row[3]}
            for row in cursor.fetchall()
        ]

    if depth is None:
        depth = _cog_node_depth(conn, parent_id)
        if depth is None:
            return []  # parent_id isn't a real COG node at all

    next_depth = depth + 1
    next_columns = COG_LEVEL_COLUMNS.get(next_depth)
    if next_columns is None:
        return []  # a specific COG id (depth=2) is a real leaf -- no children below it

    id_col, _ = COG_LEVEL_COLUMNS[depth]
    next_id_col, next_name_col = next_columns

    query = f"""
        SELECT DISTINCT {next_id_col} AS annotation_id, {next_name_col} AS name, a_name AS category
        FROM cog_paths
        WHERE {id_col} = ? AND {next_id_col} IS NOT NULL
    """
    cursor = conn.execute(query, (parent_id,))
    return sorted(
        (
            {"annotation_id": row[0], "name": row[1], "depth": next_depth, "category": row[2]}
            for row in cursor.fetchall()
        ),
        key=lambda c: c["annotation_id"],
    )


def get_cog_path_sql(conn: sqlite3.Connection, annotation_id: str) -> dict | None:
    """Return every real ancestor path (root to node) for a COG node, for
    auto-expanding/highlighting a node in the hierarchy popup. Same
    GROUP BY-deduplicated shape as get_kegg_path_sql for response parity --
    a COG id can have multiple real categories (E17,
    docs/AUDIT-2026-09-22.md; e.g. COG0028 is real under both E and H), so
    `paths` can have more than 1 entry, same as KEGG's multi-parent case.

    Args:
        conn: Open SQLite connection.
        annotation_id: A COG annotation id, e.g. 'H' or 'COG0001'.

    Returns:
        {"annotation_id": ..., "paths": [[{"annotation_id","name","depth"}, ...], ...],
         "path_count": <number of real categories this id has>}, or None if
        annotation_id isn't a real COG node at all.
    """
    depth = _cog_node_depth(conn, annotation_id)
    if depth is None:
        return None

    id_col, _ = COG_LEVEL_COLUMNS[depth]
    cols = [c for d in range(1, depth + 1) for c in COG_LEVEL_COLUMNS[d]]
    col_list = ", ".join(cols)

    rows = conn.execute(
        f"""
        SELECT {col_list}, MIN(id) AS first_id
        FROM cog_paths WHERE {id_col} = ?
        GROUP BY {col_list}
        ORDER BY first_id ASC
        """,
        (annotation_id,),
    ).fetchall()

    paths = [
        [
            {"annotation_id": row[(d - 1) * 2], "name": row[(d - 1) * 2 + 1], "depth": d}
            for d in range(1, depth + 1)
        ]
        for row in rows
    ]
    return {"annotation_id": annotation_id, "paths": paths, "path_count": len(paths)}


def get_annotation_scaffolds_sql(
    conn: sqlite3.Connection, source: str, annotation_id: str, sample: str | None = None,
) -> list[dict]:
    """Return individual scaffold rows for one annotation, for the
    /annotations/scaffolds route (the detail route -- /summary is served
    by get_annotation_series_sql's precomputed counts instead).

    Args:
        conn: Open SQLite connection.
        source: Annotation source ("cog", "kegg", "enzyme", "taxonomy").
        annotation_id: Annotation ID to look up.
        sample: If given, restrict results to this sample (indexed join,
            recommended for interactive use given the row counts involved).

    Returns:
        List of dicts keyed sample_name, scaffold_id, gene_count.
    """
    query = """
        SELECT annotation_series.sample AS sample_name, scaffolds.scaffold_id, scaffolds.gene_count
        FROM scaffolds
        JOIN annotation_series ON scaffolds.annotation_series_id = annotation_series.id
        WHERE annotation_series.source = ? AND annotation_series.annotation_id = ?
    """
    params: list[str] = [source, annotation_id]
    if sample is not None:
        query += " AND annotation_series.sample = ?"
        params.append(sample)

    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    return [
        {"sample_name": row[0], "scaffold_id": row[1], "gene_count": row[2]}
        for row in rows
    ]

def taxon_exists_sql(conn: sqlite3.Connection, lineage_prefix: str) -> bool:
    """Return whether `lineage_prefix` exists in taxon_paths -- either as
    a complete path itself, or as an ancestor of one.

    Args:
        conn: Open SQLite connection.
        lineage_prefix: Lineage-prefix string to check, e.g.
            "Bacteria;Bacteroidetes".

    Returns:
        True if found, False otherwise.
    """
    row = conn.execute(
        "SELECT 1 FROM taxon_paths WHERE full_path = ? OR substr(full_path, 1, ?) = ? LIMIT 1",
        (lineage_prefix, len(lineage_prefix) + 1, lineage_prefix + ';'),
    ).fetchone()
    return row is not None


def count_taxa_under_sql(conn: sqlite3.Connection, lineage_prefix: str) -> int:
    """Count of real leaf taxa (specific full lineages) at or under
    lineage_prefix -- taxonomy's analog of _expand_to_leaf_ids's
    leaf_count for kegg/cog/enzyme, used the same way by
    /mappings/search to decide whether to cap sample_count.

    Found live in production, 2026-09-25: taxonomy was never covered by
    that capping at all, so a broad node like a domain went completely
    uncapped -- source=taxonomy, annotation_id=Bacteria touches
    59,780,871 of the ~74M total mappings rows (81% of the entire
    dataset) and hung indefinitely. The row-volume-estimate approach used
    for kegg/cog/enzyme (summing annotation_series.gene_count) doesn't
    work here: annotation_series.annotation_id is a full lineage string,
    so matching "under this prefix" needs the same un-indexable
    substr(...) scan _expand_to_leaf_ids's IN(...) lookup avoids for the
    other three sources, and annotation_series is 5.15M rows -- too big
    for that scan to be cheap (measured: 13.7s, not a "cheap check"
    anymore). taxon_paths is only 42,099 rows, so the identical
    substr(...) pattern here stays fast (measured: 0.01-0.14s) even
    though it can't use an index either.

    Args:
        conn: Open SQLite connection.
        lineage_prefix: Lineage-prefix string, e.g. "Bacteria" or
            "Bacteria;Bacteroidetes".

    Returns:
        Number of taxon_paths rows at or under lineage_prefix (1 for an
        already-leaf/strain-level lineage with no descendants).
    """
    row = conn.execute(
        "SELECT COUNT(*) FROM taxon_paths WHERE full_path = ? OR substr(full_path, 1, ?) = ?",
        (lineage_prefix, len(lineage_prefix) + 1, lineage_prefix + ';'),
    ).fetchone()
    return row[0] if row else 0


def get_top_annotations_sql(conn: sqlite3.Connection, source: str, sample_names: list[str]) -> list[dict]:
    """Return mean/max EGC and norm_egc per annotation_id, aggregated
    across the given samples, sorted by mean_egc descending.

    Args:
        conn: Open SQLite connection.
        source: Annotation source ("cog", "kegg", "enzyme", "taxonomy").
        sample_names: Samples to include in the aggregation.

    Returns:
        List of dicts keyed annotation_id, name, parent, depth, mean_egc,
        max_egc, mean_norm_egc, max_norm_egc, sample_count.
    """
    placeholders = ",".join("?" for _ in sample_names)
    # MIN() used instead of bare columns: name/parent/depth are constant per
    # (source, annotation_id), but SQLite only guarantees a bare column's
    # value is deterministic in GROUP BY when the query has exactly one
    # MIN()/MAX() -- this one has four (two AVG, two MAX on egc/norm_egc).
    # depth included for the same reason as get_top_annotations_from_catalog_sql
    # (A8, docs/AUDIT-2026-10-05.md) -- this is the date-filtered sibling path.
    query = f"""
        SELECT annotation_id,
               MIN(name) AS name,
               MIN(parent) AS parent,
               MIN(depth) AS depth,
               AVG(egc) AS mean_egc,
               MAX(egc) AS max_egc,
               AVG(norm_egc) AS mean_norm_egc,
               MAX(norm_egc) AS max_norm_egc,
               COUNT(DISTINCT sample) AS sample_count
        FROM annotation_series
        WHERE source = ? AND sample IN ({placeholders})
        GROUP BY annotation_id
        ORDER BY mean_egc DESC
    """
    params = [source] + sample_names
    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    return [
        {
            "annotation_id": row[0],
            "name": row[1],
            "parent": row[2],
            "depth": row[3],
            "mean_egc": row[4],
            "max_egc": row[5],
            "mean_norm_egc": row[6],
            "max_norm_egc": row[7],
            "sample_count": row[8],
        }
        for row in rows
    ]

def get_top_annotations_from_catalog_sql(conn: sqlite3.Connection, source: str) -> list[dict]:
    # A8 (docs/AUDIT-2026-10-05.md): depth must be included -- a parent's
    # EGC is the sum of its descendants, so parents always outrank leaves by
    # mean_egc. Without depth, the frontend has no way to rank-filter down
    # to real leaf annotations for kegg/cog/enzyme (it already does this for
    # taxonomy, where depth is derivable client-side from the lineage-prefix
    # id itself -- see get_search_annotations, which already selects depth
    # for the same reason).
    query = f"""
        SELECT annotation_id,
               name, parent, depth, mean_egc, max_egc,
               mean_norm_egc, max_norm_egc,
               sample_count
        FROM annotation_catalog
        WHERE source = ?
        ORDER BY mean_egc DESC
    """
    cursor = conn.execute(query, (source,))
    rows = cursor.fetchall()
    return [
        {
            "annotation_id": row[0],
            "name": row[1],
            "parent": row[2],
            "depth": row[3],
            "mean_egc": row[4],
            "max_egc": row[5],
            "mean_norm_egc": row[6],
            "max_norm_egc": row[7],
            "sample_count": row[8],
        }
        for row in rows
    ]

def get_search_annotations(conn: sqlite3.Connection, sources: list[str], q: str | None, annotation_id: str | None, name_exact: str | None) -> list[dict]:
    """Return annotation_catalog rows matching the given filters.

    Args:
        conn: Open SQLite connection.
        sources: Annotation sources to search across.
        q: Substring to match against annotation_id or name.
        annotation_id: Exact annotation_id match. Takes precedence over q.
        name_exact: If given, additionally requires an exact name match.

    Returns:
        List of dicts keyed source, annotation_id, name, parent, depth,
        mean_egc, max_egc, mean_norm_egc, max_norm_egc, sample_count.
    """
    clauses = []
    params  = []

    # 1. Source filter -- ALWAYS applied, one placeholder per item in `sources`
    placeholders = ",".join("?" for _ in sources)
    clauses.append(f"source IN ({placeholders})")
    params.extend(sources)

    # 2. The three-way branch (mutually exclusive )
    if annotation_id:
        clauses.append("annotation_id = ?")
        params.append(annotation_id)
    elif q:
        # annotation_id is a meaningful, searchable ID for cog/kegg/enzyme
        # (e.g. "K00001"), but for taxonomy it's now the full lineage
        # string -- matching against it there would hit on any ancestor's
        # name, not just this node's own name, so taxonomy only matches
        # on `name`.
        clauses.append("(name LIKE ? OR (source != 'taxonomy' AND annotation_id LIKE ?))")
        params.append(f"%{q}%")
        params.append(f"%{q}%")
    else:
        pass   # no clause added at all -- matches every annotation for these sources

    # 3. name_exact -- a SEPARATE check, always evaluated regardless of which
    #    branch above ran, appended on top
    if name_exact:
        clauses.append("name = ?")
        params.append(name_exact)

    where_sql = " AND ".join(clauses)

    # category/scaffold_count aren't columns on annotation_catalog (a
    # pre-aggregated table) -- they live per-sample on annotation_series.
    # category is identical across every sample for a given (source,
    # annotation_id) (confirmed live: 0 exceptions across the whole table),
    # so an arbitrary single row is exact, not approximate. scaffold_count
    # genuinely varies sample-to-sample, so this picks whichever sample the
    # index happens to return first (unordered LIMIT 1) -- "a sample this
    # annotation appears in", not a specific one (e.g. not "the earliest").
    # Deliberately unordered: an `ORDER BY sample` inside the correlated
    # subquery forces a per-group sort with no supporting index and was
    # measured at minutes for the full taxonomy catalog vs ~8s unordered,
    # or ~0.7s for a realistic filtered query (idx_annotation_series_source_annotation_id
    # covers (source, annotation_id) but not sample ordering within that).
    query = f"""
    SELECT source, annotation_id,
           name, parent, mean_egc, max_egc,
           mean_norm_egc, max_norm_egc,
           sample_count, depth,
           (SELECT category FROM annotation_series s
              WHERE s.source = ac.source AND s.annotation_id = ac.annotation_id LIMIT 1),
           (SELECT scaffold_count FROM annotation_series s
              WHERE s.source = ac.source AND s.annotation_id = ac.annotation_id LIMIT 1)
        FROM annotation_catalog ac
        WHERE {where_sql}
    """
    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    return [
        {
            "source": row[0],
            "annotation_id": row[1],
            "name": row[2],
            "parent": row[3],
            "mean_egc": row[4],
            "max_egc": row[5],
            "mean_norm_egc": row[6],
            "max_norm_egc": row[7],
            "sample_count": row[8],
            "depth": row[9],
            "category": row[10],
            "scaffold_count": row[11],
        }
        for row in rows
    ]

def _sort_group_concat(value: str | None) -> str | None:
    """Sort a comma-separated GROUP_CONCAT(DISTINCT ...) string's values.

    SQLite's GROUP_CONCAT(DISTINCT ...) does not guarantee a stable element
    order across queries (no ORDER BY is supported inside the aggregate the
    way some other SQL dialects allow) -- two mapping rows with the exact
    same set of cog_ids or enzyme ids could concatenate in a different
    order depending on the query plan. get_mappings_sql's caller
    (search_mappings, FastAPI/api/routes.py) builds a `unique_pairs` dedup
    key directly from these fields, so an order difference on otherwise-
    identical values would make it treat two real duplicates as distinct
    and let them both through (W11). Sorting here, once, at the source,
    makes both the dedup key and the value shown to the user deterministic.
    """
    return ",".join(sorted(value.split(","))) if value else value



# Non-leaf mapping searches (a KEGG pathway, an Enzyme class, a COG
# category) can expand to hundreds of real leaf ids -- see
# _expand_to_leaf_ids. Above this many resolved leaves, get_mappings_sql
# clamps how many samples it will scan regardless of the caller's
# requested sample count, the same way /annotations/top's sample_count
# already reports back the effective count rather than assuming the
# requested one was honored (W24, docs/AUDIT-2026-09-22.md). Sized from
# direct measurement: a single leaf (COG0055) is 29,663 raw rows across
# all 128 samples and already completes in ~0.85-2.3s (see below); a
# 269-member category is 3,015,883 rows at 128 samples but a comparable
# ~115K at 5 samples -- kept in the same ballpark as the proven-OK case.
_MANY_LEAVES_THRESHOLD = 20
_MAX_SAMPLES_FOR_MANY_LEAVES = 5

# The leaf-count cap above only catches breadth (a category with many
# member leaves) -- it does nothing for a SINGLE leaf id that's just
# common. Found live in production (2026-09-25): source=kegg,
# annotation_id=K02014 is one leaf (leaf_count=1, no cap applied) but
# matches 271,284 real mappings rows across all 128 samples and took
# 249.8s to run get_mappings_sql's full query (measured directly against
# the real db -- indexes were fine, EXPLAIN QUERY PLAN showed SEARCH not
# SCAN throughout; the cost is genuine: this instance's storage is
# IOPS-bound, and GROUP_CONCAT(DISTINCT ...) needs a per-group temp
# b-tree for all ~271K groups). A smaller real case, K00001 (3,126 rows),
# took 7.7s -- still slow for an interactive click. This threshold is
# sized to clamp K02014-scale volume while leaving K00001 alone.
_ROW_VOLUME_THRESHOLD = 5000

# Hard backstop, independent of every cap above: found live in
# production, 2026-09-25, this crashed the whole server (kernel
# OOM-killed the process). Two ways to reach it, both real, both
# ordinary user actions, not edge cases:
#   - A domain-level taxonomy node (annotation_id=Bacteria, 39,237 real
#     leaf taxa) still returned 1.7M+ raw rows even after capping to 5
#     samples -- the sample-count cap bounds SAMPLES, not the breadth of
#     a category with an extreme number of members.
#   - A single, specific, real leaf-level taxon -- not a category at
#     all, leaf_count=1, so no cap applies -- can itself be enormous:
#     the single most abundant organism in this dataset
#     ("...Marine gamma proteobacterium sp. HTCC2207") has 2,235,509
#     rows across all 128 samples. Ordinary abundant-species searches
#     hit this, not just domain-level browsing.
# No amount of correct sample-count/leaf-count capping logic can be
# trusted alone to bound memory for every possible category or organism,
# so this LIMIT bounds the raw row count directly, for every source,
# regardless of what capped it or whether it was capped at all. Sized
# well above every real, already-working case measured this session
# (kegg K02014 capped: 7,391; cog COG2801 capped: 2,313; cog COG0055
# uncapped: 29,663) and well below the row count that actually caused
# the OOM crash (~1.7M-2.2M). get_mappings_sql's caller
# (search_mappings) checks len(results) >= this to disclose truncation
# separately from samples_were_capped -- the two are different failure
# modes with different causes.
_MAPPINGS_ROW_LIMIT = 50_000


def estimate_mapping_row_count_sql(
    conn: sqlite3.Connection, source: str, leaf_ids: list[str], samples: list[str],
) -> int:
    """Cheap upper-bound estimate of how many `mappings` rows source/
    leaf_ids will touch across samples -- without querying `mappings`
    (74M rows) at all.

    Uses annotation_series.gene_count, precomputed per (source, sample,
    annotation_id) by the EGC migration scripts. Verified directly
    against the real production db (2026-09-25): SUM(gene_count) for
    kegg/K02014 across all 128 samples is exactly 271,284 -- an exact
    match for a real COUNT(*) against `mappings` for the same filter --
    and the sum itself runs in ~0.1s thanks to
    idx_annotation_series_source_annotation_id, versus 94.6s for the
    equivalent direct COUNT(*) against `mappings`.

    Args:
        conn: Open SQLite connection.
        source: "kegg", "cog", or "enzyme".
        leaf_ids: Real leaf ids from _expand_to_leaf_ids (bare, no
            KO:/EC: prefix -- matches annotation_series.annotation_id's
            storage form for all three sources).
        samples: Sample names the real query would be restricted to.

    Returns:
        Total matching row count (0 if leaf_ids or samples is empty).
    """
    if not leaf_ids or not samples:
        return 0
    id_placeholders = ", ".join("?" * len(leaf_ids))
    sample_placeholders = ", ".join("?" * len(samples))
    query = f"""
        SELECT COALESCE(SUM(gene_count), 0)
        FROM annotation_series
        WHERE source = ? AND annotation_id IN ({id_placeholders})
          AND sample IN ({sample_placeholders})
    """
    row = conn.execute(query, (source, *leaf_ids, *samples)).fetchone()
    return row[0] if row else 0


def strip_source_prefix(source: str, annotation_id: str) -> str:
    """Strip kegg's "KO:" / enzyme's "EC:" prefix, if present, so an id
    resolves the same way regardless of which form a caller passes.

    A1 (docs/AUDIT-2026-10-05.md): this used to live ONLY inside
    get_mappings_sql, called right before ITS OWN _expand_to_leaf_ids
    call -- but routes.py's own cap-check (in search_mappings, before
    get_mappings_sql ever runs) calls _expand_to_leaf_ids directly with
    the UNSTRIPPED id. kegg_paths/enzyme_paths store bare ids at every
    level, so a prefixed id (e.g. "KO:K02014") resolved to zero real
    leaves there -- not because it isn't real, but because the lookup
    never stripped the prefix first. With leaf_count=0, every cap check
    in search_mappings sees nothing to cap, so the uncapped query below
    it runs in full -- reproducing the exact 271,284-row/249.8s
    production incident (K02014, prefixed) the cap exists to prevent,
    for a prefixed form the API explicitly documents/tests as
    supported. Both call sites now share this one function instead of
    routes.py's own copy silently drifting from get_mappings_sql's.

    Args:
        source: "kegg", "cog", "enzyme", or "taxonomy".
        annotation_id: A leaf or non-leaf id, with or without its
            source's prefix.

    Returns:
        annotation_id with its source's prefix stripped, if it had one
        and this source has one at all (cog/taxonomy never do).
    """
    if source == "kegg" and annotation_id.startswith("KO:"):
        return annotation_id[len("KO:"):]
    if source == "enzyme" and annotation_id.startswith("EC:"):
        return annotation_id[len("EC:"):]
    return annotation_id


def _expand_to_leaf_ids(conn: sqlite3.Connection, source: str, annotation_id: str) -> list[str]:
    """Resolve annotation_id to every real leaf id it reaches -- itself,
    if it's already a leaf, or every descendant leaf if it's a pathway/
    class/category node. Unifies the leaf and non-leaf cases: a leaf id
    only ever matches its own leaf column, so this returns exactly [id]
    for a leaf without needing a separate branch (W24,
    docs/AUDIT-2026-09-22.md -- the pre-fix code only ever matched a leaf
    id, so a pathway/class/category id always resolved to zero rows).

    Args:
        conn: Open SQLite connection.
        source: "kegg", "cog", or "enzyme" (taxonomy already does
            prefix matching and doesn't go through this).
        annotation_id: A leaf or non-leaf annotation id for that source.

    Returns:
        Sorted list of real leaf ids (bare, no KO:/EC: prefix). Empty if
        annotation_id isn't a real node at all.
    """
    if source == "cog":
        rows = conn.execute(
            "SELECT DISTINCT b_id FROM cog_paths WHERE a_id = ? OR b_id = ?",
            (annotation_id, annotation_id),
        ).fetchall()
        return sorted(row[0] for row in rows)

    table = "kegg_paths" if source == "kegg" else "enzyme_paths"
    rows = conn.execute(
        f"""
        SELECT DISTINCT d_id FROM {table}
        WHERE (a_id = ? OR b_id = ? OR c_id = ? OR d_id = ?) AND d_id IS NOT NULL
        """,
        (annotation_id, annotation_id, annotation_id, annotation_id),
    ).fetchall()
    return sorted(row[0] for row in rows)


def get_mappings_sql(
    conn: sqlite3.Connection, source: str, annotation_id: str,
    samples: list[str] | None = None, bypass_cap: bool = False,
) -> list[dict]:
    """Return every mapping row (gene/sample/scaffold, plus its
    annotations across all four sources) reachable from `annotation_id`.

    For kegg/enzyme/cog, annotation_id no longer has to be a leaf id --
    a pathway, EC class, or COG category expands to every real leaf id
    beneath it via _expand_to_leaf_ids and matches any of them (W24,
    docs/AUDIT-2026-09-22.md). A leaf id still matches only itself, same
    as before.

    Args:
        conn: Open SQLite connection.
        source: Annotation source to match on ("cog", "kegg", "enzyme",
            "taxonomy").
        annotation_id: Leaf or non-leaf id to match (not a substring
            search).
        samples: If given, restrict to these sample names at the SQL level
            instead of fetching every matching row for every sample and
            filtering in Python afterward. Found via direct measurement
            while investigating /mappings/search's ~0.85-2.3s latency: a
            common annotation like COG0055 has 29,663 raw matching gene
            rows across all 128 samples, and the route only ever wants a
            caller-chosen subset (its sample_count param) -- fetching and
            GROUP_CONCAT-ing all of them regardless, every call, was pure
            wasted work. An empty list returns [] immediately (no matching
            samples requested, not "no filter"). When annotation_id
            expands to more than _MANY_LEAVES_THRESHOLD real leaves, this
            is additionally clamped to at most _MAX_SAMPLES_FOR_MANY_LEAVES
            entries regardless of how many were passed in -- see the
            module-level comment above _MANY_LEAVES_THRESHOLD.
        bypass_cap: A2 (docs/AUDIT-2026-10-05.md): skip the clamp just
            above. Before this flag existed, routes.py already computed an
            uncapped `samples` list when its own bypass_cap query param was
            set, but this function re-clamped it anyway -- the route's
            response metadata (sample_count, samples_were_capped) reflected
            the route's untouched list while the actual query silently used
            only 5 samples, so a "bypass_cap=true" CSV export was quietly
            25x smaller than its own label claimed. Defaults to False so
            every other caller keeps the existing safety net.

    Returns:
        List of dicts keyed sample, gene_id, contig_id, kegg_id, cog_id,
        enzyme, taxonomy.

    Raises:
        ValueError: If source is not one of the four known sources.
    """
    if samples is not None and not samples:
        return []

    if source in ("kegg", "cog", "enzyme"):
        # kegg_paths/enzyme_paths store bare ids at every level (no "KO:"/
        # "EC:" prefix, same as e.g. a bare pathway code) -- strip it here
        # (A1, docs/AUDIT-2026-10-05.md: via the shared strip_source_prefix,
        # not a local copy -- routes.py's own cap-check needs the exact
        # same stripping before ITS OWN _expand_to_leaf_ids call) so a
        # caller passing either form (both are real call patterns, see
        # test_bare_id_normalizes_to_prefixed_storage_form) resolves the
        # same way. The prefix is re-added below when matching against
        # mappings.kegg_id / gene_enzyme.ec_id, which DO store it.
        expand_id = strip_source_prefix(source, annotation_id)

        leaf_ids = _expand_to_leaf_ids(conn, source, expand_id)
        if not leaf_ids:
            return []
        if samples is not None and len(leaf_ids) > _MANY_LEAVES_THRESHOLD and not bypass_cap:
            samples = samples[:_MAX_SAMPLES_FOR_MANY_LEAVES]

    # Pushed into the subquery itself (not just the outer WHERE) so it
    # actually narrows what the subquery's JOIN has to scan, rather than
    # being a residual per-row check applied after the full unfiltered
    # subquery already ran -- confirmed via EXPLAIN QUERY PLAN that the
    # outer-WHERE-only version left the subquery's cost completely
    # unaffected (no SEARCH step referencing the sample column at all).
    # cog/enzyme filter on their OWN denormalized sample column
    # (gene_cog.sample/gene_enzyme.sample, not mappings.sample) so the
    # composite (cog_id, sample)/(ec_id, sample) indexes can be used
    # directly instead of visiting every cog_id/ec_id match regardless of
    # which samples were requested (found live in production, 2026-09-25:
    # COG2801 took 55.0s without this -- see create_sql_indexes.py).
    sample_placeholders = ", ".join("?" * len(samples)) if samples is not None else ""
    sample_filter_params: tuple = tuple(samples) if samples is not None else ()

    def _sample_filter(column: str) -> str:
        return f" AND {column} IN ({sample_placeholders})" if samples is not None else ""

    if source == "kegg":
        kegg_ids = [f"KO:{leaf}" for leaf in leaf_ids]
        placeholders = ", ".join("?" * len(kegg_ids))
        where_sql = f"""
            SELECT id
            FROM mappings
            WHERE kegg_id IN ({placeholders}){_sample_filter('mappings.sample')}
            LIMIT {_MAPPINGS_ROW_LIMIT}
        """
        where_params = tuple(kegg_ids) + sample_filter_params
    elif source == "cog":
        placeholders = ", ".join("?" * len(leaf_ids))
        # A3 (docs/AUDIT-2026-10-05.md): DISTINCT, not a bare SELECT -- a
        # gene matching more than one of several searched cog_ids (a real
        # case for a multi-category search) produces duplicate mapping_ids
        # in this junction-table subquery. Without DISTINCT, LIMIT counts
        # those raw duplicate rows, not real genes, so the subquery can hit
        # the limit while still returning fewer than _MAPPINGS_ROW_LIMIT
        # DISTINCT ids once the outer GROUP BY collapses them -- the exact
        # mechanism that let real truncation go undetected (routes.py's
        # `len(mappings) >= _MAPPINGS_ROW_LIMIT` check reads false). kegg/
        # taxonomy's subqueries select mappings.id directly (already
        # unique per row), so they never had this gap.
        where_sql = f"""
            SELECT DISTINCT gene_cog.mapping_id AS id
            FROM gene_cog
            WHERE gene_cog.cog_id IN ({placeholders}){_sample_filter('gene_cog.sample')}
            LIMIT {_MAPPINGS_ROW_LIMIT}
        """
        where_params = tuple(leaf_ids) + sample_filter_params
    elif source == "enzyme":
        ec_ids = [f"EC:{leaf}" for leaf in leaf_ids]
        placeholders = ", ".join("?" * len(ec_ids))
        # A3: same DISTINCT fix as cog above.
        where_sql = f"""
                SELECT DISTINCT gene_enzyme.mapping_id AS id
                FROM gene_enzyme
                WHERE gene_enzyme.ec_id IN ({placeholders}){_sample_filter('gene_enzyme.sample')}
                LIMIT {_MAPPINGS_ROW_LIMIT}
        """
        where_params = tuple(ec_ids) + sample_filter_params
    elif source == "taxonomy":
        where_sql = f"""
            SELECT id
            FROM mappings
            WHERE taxon_path_id IN (
                SELECT id FROM taxon_paths
                WHERE full_path = ? OR substr(full_path, 1, ?) = ?
            ){_sample_filter('mappings.sample')}
            LIMIT {_MAPPINGS_ROW_LIMIT}
        """
        where_params = (annotation_id, len(annotation_id) + 1, annotation_id + ';') + sample_filter_params

    else:
        raise ValueError(f"Unknown source: {source}")

    main_query = f"""
        SELECT mappings.sample,
            gene_id,
            scaffold_id,
            kegg_id,
            GROUP_CONCAT(DISTINCT gene_cog.cog_id) AS cog_id,
            GROUP_CONCAT(DISTINCT gene_enzyme.ec_id) AS enzyme_id,
            taxon_paths.full_path AS taxonomy_path
        FROM mappings
        LEFT JOIN gene_cog ON gene_cog.mapping_id = mappings.id
        LEFT JOIN gene_enzyme ON gene_enzyme.mapping_id = mappings.id
        LEFT JOIN taxon_paths ON taxon_paths.id = mappings.taxon_path_id
        WHERE mappings.id IN (
            {where_sql}
        )
        GROUP BY mappings.id
    """
    cursor = conn.execute(main_query, where_params)

    rows = cursor.fetchall()
    results = []
    for row in rows:
        results.append({
            "sample": row[0],
            "gene_id": row[1],
            "contig_id": row[2],
            "kegg_id": row[3],
            "cog_id": _sort_group_concat(row[4]),
            "enzyme": _sort_group_concat(row[5]),
            "taxonomy": row[6],
        })
    return results

def get_taxa_at_rank_sql(conn: sqlite3.Connection, depth: int) -> list[str]:
    """Return every distinct taxon name at one rank of taxon_paths (e.g.
    every order, every phylum), sorted ascending.

    Args:
        conn: Open SQLite connection.
        depth: Rank to list, 1 (domain) through 8 (strain).

    Returns:
        Sorted list of distinct taxon names at that rank.

    Raises:
        ValueError: If depth is outside 1-8.
    """
    if depth < 1 or depth > 8:
        raise ValueError(f"depth must be 1-8, got {depth}")
    rank = RANK_COLUMNS.get(depth)
    query = f"""
        SELECT DISTINCT {rank}
        FROM taxon_paths
        WHERE {rank} IS NOT NULL
        ORDER BY {rank}
    """
    cursor = conn.execute(query)
    rows = cursor.fetchall()
    results = []
    for row in rows:
        results.append(row[0])
    return results
