"""
migrate_kegg_paths_to_sql.py
=============================
Populates `kegg_paths` (see create_sql_schema.py) -- one row per unique
KEGG BRITE occurrence path (A/B/C/D level id+name), parsed directly from
DataStructures/Kegg/ko00001.keg.

Only includes paths for nodes that are actually real in this dataset --
i.e. the occurrence's own node id must exist in `annotation_catalog`
(source='kegg'), not just anywhere in KEGG's global reference file. That
table already reflects every node (leaf KO or rolled-up pathway/category)
that a real gene's rollup actually reached, so filtering against it is
enough -- no need to separately check kegg_db.json.

IMPORTANT: annotation_catalog must be current before running this --
if it still reflects a stale/pre-fix regeneration, this script will
silently filter out real nodes (or keep since-removed ones). Run
migrate_annotations_to_sql.py + migrate_annotation_catalog_sql.py first
if there's any doubt.

Safe to re-run: DELETE-then-reinsert on every run (see populate_kegg_paths),
not an incremental INSERT OR IGNORE -- this table isn't scoped per-sample,
so there's no partial-update case worth optimizing for.

Usage (from FastAPI/):
    python scripts/migrate_kegg_paths_to_sql.py
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import KEGG_DIR, SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error

BRITE_FILE = os.path.join(KEGG_DIR, "ko00001.keg")

# Depth (1=A..4=D) -> the (id_column, name_column) pair on kegg_paths that
# holds that level. Mirrors cache_sql.py's RANK_COLUMNS for taxon_paths --
# used both when building a row here and later when querying "children of
# node X at depth N" for the tree-popup feature.
KEGG_LEVEL_COLUMNS = {
    1: ("a_id", "a_name"),
    2: ("b_id", "b_name"),
    3: ("c_id", "c_name"),
    4: ("d_id", "d_name"),
}


def load_real_kegg_annotation_ids(conn: sqlite3.Connection) -> set[str]:
    """Return every KEGG annotation id that's actually real in this
    dataset -- i.e. present in annotation_catalog, meaning at least one
    real gene's rollup reached it in at least one sample.

    Args:
        conn: Open SQLite connection.

    Returns:
        Set of annotation_id strings (leaf KOs and rolled-up
        pathway/category nodes alike -- annotation_catalog doesn't
        distinguish).
    """
    cursor = conn.execute("SELECT annotation_id FROM annotation_catalog WHERE source='kegg'")
    return {row[0] for row in cursor.fetchall()}


def iter_kegg_path_rows(keg_file_path: str, valid_ids: set[str]):
    """Parse ko00001.keg and yield one row dict per occurrence whose own
    node id is in `valid_ids`.

    This is a variant of the parsing loop in EGC_KEGG_TREE.ipynb's cell 5
    (current_at_depth tracks the currently-open A/B/C/D context line by
    line) -- but where that loop only needed to capture a node's
    *immediate* parent per occurrence (for the rollup walk), this one
    needs the FULL A/B/C/D chain per occurrence, since that's what a
    kegg_paths row actually stores.

    Args:
        keg_file_path: Path to ko00001.keg.
        valid_ids: Real KEGG annotation ids from
            load_real_kegg_annotation_ids() -- an occurrence is only
            yielded if the id of the node THAT LINE DESCRIBES (not its
            parent) is in this set.

    Yields:
        Dicts with keys a_id, a_name, b_id, b_name, c_id, c_name, d_id,
        d_name (None for levels the path doesn't reach), and full_path
        (levels joined by some separator, for the UNIQUE constraint --
        pick one that can't appear inside a real KEGG name/id).
    """
    with open(keg_file_path, encoding="utf-8") as f:
        keg_lines = f.readlines()

    current_at_depth: dict[int, dict] = {}

    for line in keg_lines:
        if not any(line.startswith(c) for c in "ABCD"):
            continue
        level_char = line[0]
        depth = ord(level_char) - ord("A") + 1
        rest = line[1:].strip()
        if not rest:
            continue
        parts = rest.split(None, 1)
        if len(parts) < 2:
            continue
        node_id, name = parts[0], parts[1]

        current_at_depth[depth] = {"id": node_id, "name": name}
        for d in list(current_at_depth):
            if d > depth:
                del current_at_depth[d]

        if node_id not in valid_ids:
            continue

        row = {}
        path_ids = []
        for d, (id_col, name_col) in KEGG_LEVEL_COLUMNS.items():
            if d <= depth:
                row[id_col] = current_at_depth[d]["id"]
                row[name_col] = current_at_depth[d]["name"]
                path_ids.append(current_at_depth[d]["id"])
            else:
                row[id_col] = None
                row[name_col] = None
        row["full_path"] = "|".join(path_ids)

        yield row


def populate_kegg_paths(conn: sqlite3.Connection) -> int:
    """Rebuild kegg_paths from ko00001.keg, filtered to real annotations.

    Full rebuild every run (DELETE then reinsert), not an incremental
    INSERT OR IGNORE -- unlike annotation_series/taxon_paths, this table
    isn't scoped per-sample, so there's no cheaper partial-update case to
    optimize for; a fresh KEGG release or a rollup fix can change which
    occurrences are valid, and a full rebuild is the simplest way to
    guarantee stale rows never linger.

    Args:
        conn: Open SQLite connection.

    Returns:
        Number of rows inserted.
    """
    valid_ids = load_real_kegg_annotation_ids(conn)
    rows = list(iter_kegg_path_rows(BRITE_FILE, valid_ids))

    cursor = conn.cursor()
    cursor.execute("DELETE FROM kegg_paths")
    cursor.executemany(
        """
        INSERT INTO kegg_paths
            (a_id, a_name, b_id, b_name, c_id, c_name, d_id, d_name, full_path)
        VALUES
            (:a_id, :a_name, :b_id, :b_name, :c_id, :c_name, :d_id, :d_name, :full_path)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def main():
    """Rebuild kegg_paths and print the resulting row count."""
    conn = sqlite3.connect(SQLITE_DB_PATH)
    try:
        count = populate_kegg_paths(conn)
        print(f"Done. {count} rows in kegg_paths.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
