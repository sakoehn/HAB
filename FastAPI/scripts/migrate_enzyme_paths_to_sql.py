"""
migrate_enzyme_paths_to_sql.py
================================
Populates `enzyme_paths` (see create_sql_schema.py) -- one row per real EC
classification node (class / subclass / sub-subclass / EC number, id +
name at each level), from the same tree nodes EGC_ENZYME_TREE.ipynb uses:
the EC numbers' own digits for the shape, ExPASy ENZYME for the names
(DataStructures/Enzyme/enzclass.txt and enzyme.dat, saved by
scripts/download_expasy_enzyme.py; see api/expasy_enzyme.py).

Only includes nodes that are actually real in this dataset -- the node's
own id must exist in `annotation_catalog` (source='enzyme'), not just
anywhere in ExPASy's full list.

Every EC node has exactly one parent (fixed by its own digits), so this
table has one row per real EC id.

Safe to re-run: DELETE-then-reinsert on every run -- this table isn't
scoped per-sample, so there's no partial-update case worth optimizing for.

Usage (from FastAPI/):
    python scripts/migrate_enzyme_paths_to_sql.py
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import ENZYME_DIR, SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error
from api.expasy_enzyme import (  # pylint: disable=wrong-import-position,import-error
    build_ec_nodes,
    ec_parent,
    parse_enzclass,
    parse_enzyme_dat,
)

ENZCLASS_FILE = os.path.join(ENZYME_DIR, "enzclass.txt")
ENZYME_DAT_FILE = os.path.join(ENZYME_DIR, "enzyme.dat")

# Depth (1=class .. 4=EC number) -> the (id_column, name_column) pair on
# enzyme_paths that holds that level. Same shape as ENZYME_LEVEL_COLUMNS in
# cache_sql.py.
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


def _ec_sort_key(ec_id: str) -> tuple[int, ...]:
    return tuple(int(part) for part in ec_id.split(".") if part.isdigit())


def iter_enzyme_path_rows(nodes: dict[str, dict], valid_ids: set[str]):
    """Yield one row dict per id in `valid_ids`, in EC-number order.

    Args:
        nodes: The enzyme tree's nodes, from api.expasy_enzyme.build_ec_nodes.
        valid_ids: Real Enzyme annotation ids from
            load_real_enzyme_annotation_ids().

    Yields:
        Dicts with keys a_id, a_name, b_id, b_name, c_id, c_name, d_id,
        d_name (None for levels the node doesn't reach), and full_path
        (the ids actually present, joined by '|').

    Raises:
        ValueError: if a valid id isn't one of `nodes` -- the catalog and
            the ExPASy files would then be out of step.
    """
    missing = sorted(valid_ids - nodes.keys())
    if missing:
        raise ValueError(f"enzyme ids in annotation_catalog that aren't tree nodes: {missing[:10]}")

    for ec_id in sorted(valid_ids, key=_ec_sort_key):
        chain = []
        cur = ec_id
        while cur is not None:
            chain.append(cur)
            cur = ec_parent(cur)
        chain.reverse()

        row = {}
        for d, (id_col, name_col) in ENZYME_LEVEL_COLUMNS.items():
            level_id = chain[d - 1] if d <= len(chain) else None
            row[id_col] = level_id
            row[name_col] = nodes[level_id]["name"] if level_id else None
        row["full_path"] = "|".join(chain)
        yield row


def populate_enzyme_paths(conn: sqlite3.Connection) -> int:
    """Rebuild enzyme_paths from the ExPASy files, filtered to real
    annotations.

    Args:
        conn: Open SQLite connection.

    Returns:
        Number of rows inserted.
    """
    with open(ENZCLASS_FILE, encoding="latin-1") as f:
        classes = parse_enzclass(f.read())
    with open(ENZYME_DAT_FILE, encoding="latin-1") as f:
        entries = parse_enzyme_dat(f.read())
    nodes = build_ec_nodes(classes, entries)

    valid_ids = load_real_enzyme_annotation_ids(conn)
    rows = list(iter_enzyme_path_rows(nodes, valid_ids))

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
