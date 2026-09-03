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


def get_top_annotations_sql(conn: sqlite3.Connection, source: str, sample_names: list[str]) -> list[dict]:
    """Return mean/max EGC and norm_egc per annotation_id, aggregated
    across the given samples, sorted by mean_egc descending.

    Args:
        conn: Open SQLite connection.
        source: Annotation source ("cog", "kegg", "enzyme", "taxonomy").
        sample_names: Samples to include in the aggregation.

    Returns:
        List of dicts keyed annotation_id, name, parent, mean_egc,
        max_egc, mean_norm_egc, max_norm_egc, sample_count.
    """
    placeholders = ",".join("?" for _ in sample_names)
    # MIN() used instead of bare columns: name/parent are constant per
    # (source, annotation_id), but SQLite only guarantees a bare column's
    # value is deterministic in GROUP BY when the query has exactly one
    # MIN()/MAX() -- this one has four (two AVG, two MAX on egc/norm_egc).
    query = f"""
        SELECT annotation_id,
               MIN(name) AS name,
               MIN(parent) AS parent,
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
            "mean_egc": row[3],
            "max_egc": row[4],
            "mean_norm_egc": row[5],
            "max_norm_egc": row[6],
            "sample_count": row[7],
        }
        for row in rows
    ]

def get_top_annotations_from_catalog_sql(conn: sqlite3.Connection, source: str) -> list[dict]:
    query = f"""
        SELECT annotation_id,
               name, parent, mean_egc, max_egc,
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
            "mean_egc": row[3],
            "max_egc": row[4],
            "mean_norm_egc": row[5],
            "max_norm_egc": row[6],
            "sample_count": row[7],
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

    query = f"""
    SELECT source, annotation_id,
           name, parent, mean_egc, max_egc,
           mean_norm_egc, max_norm_egc,
           sample_count, depth
        FROM annotation_catalog
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
        }
        for row in rows
    ]

def get_mappings_sql(conn: sqlite3.Connection, source: str, annotation_id: str) -> list[dict]:
    """Return every mapping row (gene/sample/scaffold, plus its
    annotations across all four sources) whose `source` annotation
    exactly matches `annotation_id`.

    Args:
        conn: Open SQLite connection.
        source: Annotation source to match on ("cog", "kegg", "enzyme",
            "taxonomy").
        annotation_id: Exact ID to match (not a substring search).

    Returns:
        List of dicts keyed sample, gene_id, contig_id, kegg_id, cog_id,
        enzyme, taxonomy.

    Raises:
        ValueError: If source is not one of the four known sources.
    """
    if source == "kegg":
        kegg_id = annotation_id if annotation_id.startswith("KO:") else f"KO:{annotation_id}"
        where_sql = """
            SELECT id
            FROM mappings
            WHERE kegg_id = ?
        """
        where_params = (kegg_id,)
    elif source == "cog":
        where_sql = """
            SELECT gene_cog.mapping_id AS id
            FROM mappings
            JOIN gene_cog ON gene_cog.mapping_id = mappings.id
            WHERE gene_cog.cog_id = ?
        """
        where_params = (annotation_id,)
    elif source == "enzyme":
        ec_id = annotation_id if annotation_id.startswith("EC:") else f"EC:{annotation_id}"
        where_sql = """
                SELECT gene_enzyme.mapping_id AS id
                FROM mappings
                JOIN gene_enzyme ON gene_enzyme.mapping_id = mappings.id
                WHERE gene_enzyme.ec_id = ?
        """
        where_params = (ec_id,)
    elif source == "taxonomy":
        where_sql = """
            SELECT id
            FROM mappings
            WHERE taxon_path_id IN (
                SELECT id FROM taxon_paths
                WHERE full_path = ? OR substr(full_path, 1, ?) = ?
            )
        """
        where_params = (annotation_id, len(annotation_id) + 1, annotation_id + ';')

    else:
        raise ValueError(f"Unknown source: {source}")

    main_query = f"""
        SELECT sample,
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
            "cog_id": row[4],
            "enzyme": row[5],
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
