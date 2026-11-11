"""Read-only X4 timings on the server. Saves nothing.
Run from ~/HAB/FastAPI: python check_x4.py"""
import sqlite3, sys, time
sys.path.insert(0, ".")
from api.config import SQLITE_DB_PATH
from api.cache_sql import get_top_annotations_from_catalog_sql, get_search_annotations

c = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
print("1. Top EGC, no date filter (whole catalog list, then keep 200):")
for src, d in [("taxonomy", [7]), ("taxonomy", None), ("kegg", [4])]:
    t0 = time.perf_counter(); rows = get_top_annotations_from_catalog_sql(c, src, depths=d)
    print(f"   {src:8s} depth {str(d):6s} {len(rows):6,d} rows: {time.perf_counter() - t0:.2f} s", flush=True)
print("2. Search across all four sources:")
srcs = ["cog", "kegg", "enzyme", "taxonomy"]
for q in ("kinase", "protein", "Vibrio", "a"):
    lit = f"%{q}%"
    t1 = time.perf_counter()
    n = len(c.execute("SELECT source, annotation_id FROM annotation_catalog WHERE source IN (?,?,?,?) "
                      "AND (name LIKE ? OR (source != 'taxonomy' AND annotation_id LIKE ?))", srcs + [lit, lit]).fetchall())
    t_bare = time.perf_counter() - t1
    t0 = time.perf_counter(); rows = get_search_annotations(c, srcs, q, None, None); t = time.perf_counter() - t0
    print(f"   q={q!r:9s} {len(rows):6,d} matches: {t:6.2f} s as today, {t_bare:5.2f} s without the per-row lookups", flush=True)
