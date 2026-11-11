"""Old vs new date-filtered top query on the real local db: identical rows?"""
import sqlite3, sys, time
sys.path.insert(0, r"C:\Users\sakoehn\Desktop\JGI\FastAPI")
from api.cache_sql import get_all_sample_names_sql, get_top_annotations_sql
from api import routes

conn = sqlite3.connect(r"file:C:\Users\sakoehn\Desktop\JGI\hab_mappings.db?mode=ro", uri=True)
S = get_all_sample_names_sql(conn)


def old_query(source, names, ids=None, depths=None):
    ph = ",".join("?" for _ in names)
    ids_sql = f" AND annotation_id IN ({','.join('?' for _ in ids)})" if ids else ""
    depth_sql = f" AND depth IN ({','.join('?' for _ in depths)})" if depths else ""
    q = f"""SELECT annotation_id, MIN(name), MIN(parent), MIN(depth), AVG(egc), MAX(egc), AVG(norm_egc),
                   MAX(norm_egc), COUNT(DISTINCT sample)
            FROM annotation_series WHERE source = ? AND sample IN ({ph}){ids_sql}{depth_sql}
            GROUP BY annotation_id"""
    return sorted(conn.execute(q, [source] + names + (ids or []) + (depths or [])).fetchall())


def new_query(source, names, ids=None, depths=None):
    rows = get_top_annotations_sql(conn, source, names, annotation_ids=ids, depths=depths)
    return sorted(tuple(r[k] for k in ("annotation_id", "name", "parent", "depth", "mean_egc", "max_egc",
                                       "mean_norm_egc", "max_norm_egc", "sample_count")) for r in rows)


RANGES = [("2021-05-27", "2021-05-29"), ("2021-06-02", "2021-06-04"), ("2021-06-14", "2021-06-18"), ("2021-05-27", "2021-06-18")]
DEFAULT_DEPTH = {"kegg": 4, "cog": 2, "enzyme": 4, "taxonomy": 7}
bad = total = 0
for source in ("kegg", "cog", "enzyme", "taxonomy"):
    some_ids = [r[0] for r in conn.execute("SELECT annotation_id FROM annotation_catalog WHERE source=? ORDER BY mean_egc DESC LIMIT 30", (source,))]
    for d0, d1 in RANGES:
        names = [s for s in S if routes.is_within_date_range((routes.get_timepoint(s) or {}).get("datetime"), d0, d1)]
        for label, kw in [("all ranks", {}), ("default rank", {"depths": [DEFAULT_DEPTH[source]]}), ("30 ids", {"ids": some_ids})]:
            a, b = old_query(source, names, **kw), new_query(source, names, **kw)
            total += 1
            ok = a == b
            bad += not ok
            if not ok or label == "default rank":
                print(f"{source:8s} {d0}..{d1} ({len(names):3d} samples) {label:12s} rows {len(b):6,d}  identical: {ok}")
print(f"\n{total - bad} of {total} combinations identical")
