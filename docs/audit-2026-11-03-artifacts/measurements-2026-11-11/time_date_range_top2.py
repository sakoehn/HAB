"""Read-only timing on the server of the date-filtered /annotations/top
query: today's form vs. aggregating from the covering index and taking
name/parent/depth from annotation_catalog (no table-row reads). Saves
nothing. Run from ~/HAB/FastAPI: python time_date_range_top2.py

The new form runs first (it pays for loading the covering index); today's
form then runs on its own untouched date range, with the index already in
memory -- an order that favours today's form."""
import sqlite3, sys, time
sys.path.insert(0, ".")
from api.config import SQLITE_DB_PATH
from api.cache_sql import get_all_sample_names_sql, get_top_annotations_sql
from api import routes

conn = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
samples = get_all_sample_names_sql(conn)


def active(date_from, date_to):
    return [s for s in samples
            if routes.is_within_date_range((routes.get_timepoint(s) or {}).get("datetime"), date_from, date_to)]


def todays(source, names, depths):
    return sorted((r["annotation_id"], r["name"], r["parent"], r["depth"], r["mean_egc"], r["max_egc"],
                   r["mean_norm_egc"], r["max_norm_egc"], r["sample_count"])
                  for r in get_top_annotations_sql(conn, source, names, depths=depths))


def catalog_join(source, names, depths):
    q = f"""
        SELECT s.annotation_id, c.name, c.parent, c.depth, s.mean_egc, s.max_egc,
               s.mean_norm_egc, s.max_norm_egc, s.sample_count
        FROM (SELECT annotation_id, AVG(egc) AS mean_egc, MAX(egc) AS max_egc,
                     AVG(norm_egc) AS mean_norm_egc, MAX(norm_egc) AS max_norm_egc,
                     COUNT(DISTINCT sample) AS sample_count
              FROM annotation_series
              WHERE source = ? AND sample IN ({",".join("?" for _ in names)})
              GROUP BY annotation_id) s
        JOIN annotation_catalog c ON c.source = ? AND c.annotation_id = s.annotation_id
        WHERE c.depth IN ({",".join("?" for _ in depths)})
        ORDER BY s.mean_egc DESC, s.annotation_id
    """
    return sorted(conn.execute(q, [source] + names + [source] + depths).fetchall())


def timed(fn, *args):
    t0 = time.perf_counter(); out = fn(*args); return out, time.perf_counter() - t0


CASES = [  # source, rank, range for the new form, range for today's (neither's table rows read yet)
    ("taxonomy", [7], ("2021-06-02", "2021-06-04"), ("2021-05-27", "2021-05-29")),
    ("kegg",     [4], ("2021-06-02", "2021-06-04"), ("2021-05-27", "2021-05-29")),
]
for source, depths, range_new, range_old in CASES:
    names_new, names_old = active(*range_new), active(*range_old)
    a, t_new_cold = timed(catalog_join, source, names_new, depths)
    b, t_old_cold = timed(todays, source, names_old, depths)
    c, t_new_again = timed(catalog_join, source, names_old, depths)
    d, t_old_again = timed(todays, source, names_new, depths)
    print(f"{source} (rank {depths[0]})")
    print(f"    first, own range : new {t_new_cold:7.2f} s ({len(names_new)} samples)   today {t_old_cold:7.2f} s ({len(names_old)} samples)")
    print(f"    swapped          : new {t_new_again:7.2f} s                today {t_old_again:7.2f} s")
    print(f"    identical rows on the same range: {a == d and b == c}", flush=True)
