"""End-to-end timing of the proposed path on a cold 13k kegg family:
one-query matrix load + vectorised scoring + executemany cache write,
then the warm path as one OR query vs 13k point lookups."""
import os, sys, time, sqlite3, shutil, warnings
import numpy as np
from bench_common import *
import fast_corr
warnings.simplefilter("ignore")
DB = os.path.join(HERE, "bench_fast.db")
shutil.copy(DB_PATH, DB)
for ext in ("-wal", "-shm"):
    if os.path.exists(DB + ext): os.remove(DB + ext)
conn = sqlite3.connect(DB); conn.execute("PRAGMA busy_timeout=10000")
conn.execute("DELETE FROM correlations_cache"); conn.commit()
metric = "egc"

def load_matrix(conn, source, metric, order, ann_ids):
    rows = conn.execute(f"SELECT annotation_id, sample, {metric} FROM annotation_series WHERE source = ?", (source,)).fetchall()
    ann_index = {a: i for i, a in enumerate(ann_ids)}
    s_index = {s: j for j, s in enumerate(order)}
    M = np.full((len(ann_ids), len(order)), np.nan)
    ai = np.fromiter((ann_index.get(r[0], -1) for r in rows), dtype=np.int64, count=len(rows))
    si = np.fromiter((s_index[r[1]] for r in rows), dtype=np.int64, count=len(rows))
    vals = np.array([r[2] if r[2] is not None else np.nan for r in rows], dtype=float)
    keep = ai >= 0
    M[ai[keep], si[keep]] = vals[keep]
    return M

for method in ("raw_pearson", "log_pearson", "spearman"):
    conn.execute("DELETE FROM correlations_cache"); conn.commit()
    T = {}
    t0 = time.perf_counter()
    ref_id, cands = ref_and_candidates(conn, "cog", "COG0000", "kegg")
    T["candidates"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    cached = conn.execute("SELECT catalog_id_a, catalog_id_b, r, lag_samples, p_value, n_pairs, at_p_floor FROM correlations_cache "
                          "WHERE (catalog_id_a = ? OR catalog_id_b = ?) AND metric = ? AND method = ?", (ref_id, ref_id, metric, method)).fetchall()
    T["cache OR query (cold cache table)"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    order = correlation_loaders.load_sample_order(conn)
    ref = np.array([np.nan if v is None else v for v in correlation_loaders.load_vector(conn, "cog", "COG0000", order, metric)])
    ann_ids = [c["annotation_id"] for c in cands]
    Mx = load_matrix(conn, "kegg", metric, order, ann_ids)
    T["load matrix (1 query + pivot)"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    out = fast_corr.score_family_hybrid(ref, Mx, method, correlation_sql.score_pair)
    T["score_family_hybrid"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    ids = np.array([c["id"] for c in cands])
    ok = out["ok"]
    low = np.minimum(ids, ref_id); high = np.maximum(ids, ref_id)
    lag_store = np.where(ids < ref_id, -out["lag"], out["lag"])  # lag relative to the low id
    rows = [(int(low[i]), int(high[i]), float(out["r"][i]), metric, method, int(lag_store[i]), float(out["p"][i]), int(out["n_pairs"][i]), None)
            for i in np.nonzero(ok)[0]]
    conn.executemany("INSERT OR IGNORE INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs, at_p_floor) VALUES (?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    T["executemany + commit"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    scored = [{"catalog_id": int(ids[i]), "r": float(out["r"][i]), "p": float(out["p"][i]), "lag_samples": int(out["lag"][i]), "n_pairs": int(out["n_pairs"][i])} for i in np.nonzero(ok)[0]]
    scored = correlation_sql._apply_fdr(scored)
    scored.sort(key=lambda e: (not (e["q"] < 0.05), -abs(e["r"])))
    T["FDR + sort"] = time.perf_counter() - t0
    total = sum(T.values())
    print(f"[{method:12s}] COLD total {total:.2f}s  (guarded rows recomputed by score_pair: {out['n_guarded']}, scored {ok.sum()} of {len(cands)})")
    for k, v in T.items(): print(f"    {v*1000:8.1f} ms  {k}")
    # warm path
    t0 = time.perf_counter()
    cached = conn.execute("SELECT catalog_id_a, catalog_id_b, r, lag_samples, p_value, n_pairs, at_p_floor FROM correlations_cache "
                          "WHERE (catalog_id_a = ? OR catalog_id_b = ?) AND metric = ? AND method = ?", (ref_id, ref_id, metric, method)).fetchall()
    t_or = time.perf_counter() - t0
    t0 = time.perf_counter()
    for c in cands:
        lo, hi = min(ref_id, c["id"]), max(ref_id, c["id"])
        conn.execute("SELECT * FROM correlations_cache WHERE catalog_id_a = ? AND catalog_id_b = ? AND metric = ? AND method = ?", (lo, hi, metric, method)).fetchone()
    t_pt = time.perf_counter() - t0
    print(f"    WARM: one OR query {t_or*1000:.1f} ms ({len(cached)} rows) vs 13k point lookups {t_pt*1000:.1f} ms")
print("EXPLAIN OR query:", conn.execute("EXPLAIN QUERY PLAN SELECT * FROM correlations_cache WHERE (catalog_id_a = ? OR catalog_id_b = ?) AND metric = ? AND method = ?", (1,1,'egc','spearman')).fetchall())
conn.close()
os.remove(DB)
for ext in ("-wal", "-shm"):
    if os.path.exists(DB + ext): os.remove(DB + ext)
