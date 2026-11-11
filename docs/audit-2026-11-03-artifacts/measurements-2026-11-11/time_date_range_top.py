"""Read-only timing on the server of the date-filtered /annotations/top
query: today's form vs. (source, sample) row values. Saves nothing.
Run from ~/HAB/FastAPI: python time_date_range_top.py

Both forms read the same table rows (those in the date range), so whichever
runs first on a range pays for fetching them from disk. Each form therefore
gets its own untouched range first (both cold), then they swap ranges."""
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
    return [(r["annotation_id"], r["mean_egc"], r["sample_count"])
            for r in get_top_annotations_sql(conn, source, names, depths=depths)]


def row_values(source, names, depths):
    pairs = ",".join("(?, ?)" for _ in names)
    depth_sql = f" AND depth IN ({','.join('?' for _ in depths)})" if depths else ""
    q = f"""
        SELECT annotation_id, MIN(name), MIN(parent), MIN(depth), AVG(egc), MAX(egc),
               AVG(norm_egc), MAX(norm_egc), COUNT(DISTINCT sample)
        FROM annotation_series
        WHERE (source, sample) IN (VALUES {pairs}){depth_sql}
        GROUP BY annotation_id
        ORDER BY 5 DESC, annotation_id
    """
    params = [x for s in names for x in (source, s)] + (depths or [])
    return [(r[0], r[4], r[8]) for r in conn.execute(q, params)]


def timed(fn, *args):
    t0 = time.perf_counter(); out = fn(*args); return out, time.perf_counter() - t0


CASES = [  # source, rank, range for today's query, range for the new one (each untouched)
    ("taxonomy", [7], ("2021-05-30", "2021-06-01"), ("2021-06-05", "2021-06-07")),
    ("kegg",     [4], ("2021-06-14", "2021-06-16"), ("2021-06-08", "2021-06-10")),
]
for source, depths, range_old, range_new in CASES:
    names_old, names_new = active(*range_old), active(*range_new)
    a, t_old_cold = timed(todays, source, names_old, depths)
    b, t_new_cold = timed(row_values, source, names_new, depths)
    c, t_old_warm = timed(todays, source, names_new, depths)    # rows of range_new now in memory
    d, t_new_warm = timed(row_values, source, names_old, depths)  # rows of range_old now in memory
    same = sorted(a) == sorted(d) and sorted(b) == sorted(c)
    print(f"{source} (rank {depths[0]})")
    print(f"    cold, own range : today {t_old_cold:7.2f} s ({len(names_old)} samples)   new {t_new_cold:7.2f} s ({len(names_new)} samples)")
    print(f"    swapped (warm)  : today {t_old_warm:7.2f} s                new {t_new_warm:7.2f} s")
    print(f"    same annotations and values on the same range: {same}", flush=True)
