"""
migrate_enzyme_paths_to_sql.py
================================
Populates `enzyme_paths` (see create_sql_schema.py) -- one row per real EC
classification node (A/B/C/D level id+name), parsed directly from
DataStructures/Enzyme/ko01000.keg (saved locally by
scripts/download_enzyme_brite.py -- see that script for why this isn't a
live fetch).

Only includes nodes that are actually real in this dataset -- i.e. the
node's own id must exist in `annotation_catalog` (source='enzyme'), not
just anywhere in KEGG's global EC reference file. Same filtering principle
as migrate_kegg_paths_to_sql.py.

Unlike KEGG, every EC node has exactly one real parent (verified: 0 of
7,333 A/B/C/D nodes in ko01000.keg appear more than once, since the EC
numbering system itself is a strict single-parent hierarchy) -- so this
table ends up one row per real EC id, not the ~2.4 rows-per-id kegg_paths
averages. Still built the same way for consistency, not because the
multi-occurrence case can actually happen here.

Safe to re-run: DELETE-then-reinsert on every run, same reasoning as
migrate_kegg_paths_to_sql.py -- this table isn't scoped per-sample, so
there's no partial-update case worth optimizing for.

Usage (from FastAPI/):
    python scripts/migrate_enzyme_paths_to_sql.py
"""

import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import ENZYME_DIR, SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error

BRITE_FILE = os.path.join(ENZYME_DIR, "ko01000.keg")

# Depth (1=A..4=D) -> the (id_column, name_column) pair on enzyme_paths
# that holds that level. Same shape as KEGG_LEVEL_COLUMNS in cache_sql.py.
ENZYME_LEVEL_COLUMNS = {
    1: ("a_id", "a_name"),
    2: ("b_id", "b_name"),
    3: ("c_id", "c_name"),
    4: ("d_id", "d_name"),
}


def load_real_enzyme_annotation_ids(conn: sqlite3.Connection) -> set[str]:
    """Return every Enzyme (EC) annotation id that's actually real in this
    dataset -- i.e. present in annotation_catalog.

    Args:
        conn: Open SQLite connection.

    Returns:
        Set of annotation_id strings.
    """
    cursor = conn.execute("SELECT annotation_id FROM annotation_catalog WHERE source='enzyme'")
    return {row[0] for row in cursor.fetchall()}


def iter_enzyme_path_rows(keg_file_path: str, valid_ids: set[str]):
    """Parse ko01000.keg and yield one row dict per real EC node.

    Same current_at_depth tracking approach as
    migrate_kegg_paths_to_sql.py's iter_kegg_path_rows and
    EGC_ENZYME_TREE.ipynb's own BRITE-parsing cell -- HTML tags stripped
    from A-level lines ("A<b>1. Oxidoreductases</b>"), node ids matched
    with the same digit-dot regex that skips E-level KO cross-reference
    lines entirely (they don't match a digit-based id, so they're never
    even candidates here).

    Args:
        keg_file_path: Path to ko01000.keg.
        valid_ids: Real Enzyme annotation ids from
            load_real_enzyme_annotation_ids() -- a node is only yielded
            if its own id is in this set.

    Yields:
        Dicts with keys a_id, a_name, b_id, b_name, c_id, c_name, d_id,
        d_name (None for levels the node doesn't reach), and full_path
        (the ids actually present, joined by '|').
    """
    with open(keg_file_path, encoding="utf-8") as f:
        keg_lines = f.readlines()

    current_at_depth: dict[int, dict] = {}

    for raw_line in keg_lines:
        line = raw_line.strip()
        if not line or line[0] not in "ABCD":
            continue

        depth = ord(line[0]) - ord("A") + 1

        rest = re.sub(r"<[^>]+>", "", line[1:]).strip()
        if not rest:
            continue

        m = re.match(r"^(\d+(?:\.\d+){0,3})\.?\s+(.+)$", rest)
        if not m:
            continue

        node_id, name = m.group(1), m.group(2).strip()

        current_at_depth[depth] = {"id": node_id, "name": name}
        for d in list(current_at_depth):
            if d > depth:
                del current_at_depth[d]

        if node_id not in valid_ids:
            continue

        row = {}
        path_ids = []
        for d, (id_col, name_col) in ENZYME_LEVEL_COLUMNS.items():
            if d <= depth:
                row[id_col] = current_at_depth[d]["id"]
                row[name_col] = current_at_depth[d]["name"]
                path_ids.append(current_at_depth[d]["id"])
            else:
                row[id_col] = None
                row[name_col] = None
        row["full_path"] = "|".join(path_ids)

        yield row


def populate_enzyme_paths(conn: sqlite3.Connection) -> int:
    """Rebuild enzyme_paths from ko01000.keg, filtered to real annotations.

    Args:
        conn: Open SQLite connection.

    Returns:
        Number of rows inserted.
    """
    valid_ids = load_real_enzyme_annotation_ids(conn)
    rows = list(iter_enzyme_path_rows(BRITE_FILE, valid_ids))

    cursor = conn.cursor()
    cursor.execute("DELETE FROM enzyme_paths")
    cursor.executemany(
        """
        INSERT INTO enzyme_paths
            (a_id, a_name, b_id, b_name, c_id, c_name, d_id, d_name, full_path)
        VALUES
            (:a_id, :a_name, :b_id, :b_name, :c_id, :c_name, :d_id, :d_name, :full_path)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def main():
    """Rebuild enzyme_paths and print the resulting row count."""
    conn = sqlite3.connect(SQLITE_DB_PATH)
    try:
        count = populate_enzyme_paths(conn)
        print(f"Done. {count} rows in enzyme_paths.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
