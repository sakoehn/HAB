"""
fix_semicolon_strains.py
========================
One-off repair for a database built before api/taxon_lineage.py.

A strain name containing ";" (e.g. "Drosophila melanogaster y; cn bw sp")
was split by the taxonomy tree into two fake nodes holding identical data:
a strain-level node named by the text before the ";" and a 9th-level node
under it. This keeps one strain-level node, named by normalize_lineage
("Drosophila melanogaster y, cn bw sp"), deletes the 9th-level copy (its
annotation_series, scaffolds, annotation_catalog, correlations_cache and
correlations_unscored rows), and writes taxon_paths' strain/full_path the same way, so the
strain's id matches taxon_paths and its mappings are found.

Everything runs in one transaction; it stops without changing anything if
a fake strain node has any child besides the one being merged into it.
Running it again finds nothing to do.

Usage (stop the web service first on the server):
    python FastAPI/scripts/fix_semicolon_strains.py
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error
from api.taxon_lineage import RANK_COUNT, normalize_lineage  # pylint: disable=wrong-import-position,import-error


def fix_semicolon_strains(conn: sqlite3.Connection) -> dict:
    """Merge each fake 9th-level taxonomy node into one correctly named
    strain node, and normalize taxon_paths to match.

    Args:
        conn: Open SQLite connection to the app database.

    Returns:
        {"merged": number of strains merged, "taxon_paths": rows updated}.
    """
    deep = [row[0] for row in conn.execute(
        "SELECT annotation_id FROM annotation_catalog WHERE source = 'taxonomy' AND depth > ?",
        (RANK_COUNT,),
    )]
    plans = []
    for fake9 in deep:
        fake8 = ";".join(fake9.split(";")[:RANK_COUNT])
        good = normalize_lineage(fake9)
        others = conn.execute(
            "SELECT COUNT(*) FROM annotation_catalog "
            "WHERE source = 'taxonomy' AND parent = ? AND annotation_id != ?",
            (fake8, fake9),
        ).fetchone()[0]
        if others:
            raise SystemExit(f"{fake8!r} has other children besides {fake9!r}; not merging.")
        plans.append((fake8, fake9, good))

    with conn:
        for fake8, fake9, good in plans:
            good_name = good.split(";")[-1]
            fake9_series = [r[0] for r in conn.execute(
                "SELECT id FROM annotation_series WHERE source = 'taxonomy' AND annotation_id = ?", (fake9,))]
            conn.executemany("DELETE FROM scaffolds WHERE annotation_series_id = ?",
                             [(i,) for i in fake9_series])
            conn.execute("DELETE FROM annotation_series WHERE source = 'taxonomy' AND annotation_id = ?", (fake9,))
            fake9_catalog = [r[0] for r in conn.execute(
                "SELECT id FROM annotation_catalog WHERE source = 'taxonomy' AND annotation_id = ?", (fake9,))]
            for table in ("correlations_cache", "correlations_unscored"):
                conn.executemany(f"DELETE FROM {table} WHERE catalog_id_a = ? OR catalog_id_b = ?",
                                 [(i, i) for i in fake9_catalog])
            conn.execute("DELETE FROM annotation_catalog WHERE source = 'taxonomy' AND annotation_id = ?", (fake9,))
            conn.execute(
                "UPDATE annotation_series SET annotation_id = ?, name = ? WHERE source = 'taxonomy' AND annotation_id = ?",
                (good, good_name, fake8))
            conn.execute(
                "UPDATE annotation_catalog SET annotation_id = ?, name = ? WHERE source = 'taxonomy' AND annotation_id = ?",
                (good, good_name, fake8))

        updated = 0
        for row_id, full_path in conn.execute(
            "SELECT id, full_path FROM taxon_paths WHERE full_path LIKE ?", ("%;%;%;%;%;%;%;%;%",)
        ).fetchall():
            fixed = normalize_lineage(full_path)
            if fixed != full_path:
                conn.execute("UPDATE taxon_paths SET strain = ?, full_path = ? WHERE id = ?",
                             (fixed.split(";")[-1], fixed, row_id))
                updated += 1

    return {"merged": len(plans), "taxon_paths": updated}


if __name__ == "__main__":
    connection = sqlite3.connect(SQLITE_DB_PATH)
    try:
        print(fix_semicolon_strains(connection))
    finally:
        connection.close()
