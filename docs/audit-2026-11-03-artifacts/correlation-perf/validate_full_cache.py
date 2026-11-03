"""Population-level validation: run the REAL endpoint (current code) for a
cold 13k family, then compare every cached row (written by the current code,
with its own low/high orientation) against fast_corr.score_family."""
import sys, time, warnings, sqlite3
import numpy as np
from bench_common import *
import fast_corr
warnings.simplefilter("ignore")
methods = sys.argv[1:] or ["raw_pearson", "log_pearson", "spearman"]
metric = "egc"
for method in methods:
    clear_cache()
    t0 = time.perf_counter()
    out_ep = correlation_sql.correlation_family_endpoint("cog", "COG0000", "kegg", metric, method, limit=500)
    t_ep = time.perf_counter() - t0
    conn = correlation_sql._connect()
    order = correlation_loaders.load_sample_order(conn)
    ref_id, cands = ref_and_candidates(conn, "cog", "COG0000", "kegg")
    rows = conn.execute("SELECT catalog_id_a, catalog_id_b, r, lag_samples, p_value, n_pairs FROM correlations_cache WHERE metric=? AND method=?", (metric, method)).fetchall()
    cache = {}
    for a, b, r, lag, p, npairs in rows:
        other = b if a == ref_id else a
        lag_ref = lag if a == ref_id else -lag   # lag relative to the reference (the endpoint negates when ref is the high id)
        cache[other] = (r, p, lag_ref, npairs)
    ref = np.array([np.nan if v is None else v for v in correlation_loaders.load_vector(conn, "cog", "COG0000", order, metric)])
    allrows = conn.execute("SELECT annotation_id, sample, egc FROM annotation_series WHERE source='kegg'").fetchall()
    ann_ids = [c["annotation_id"] for c in cands]; ai = {a: i for i, a in enumerate(ann_ids)}; si = {s: j for j, s in enumerate(order)}
    M = np.full((len(ann_ids), len(order)), np.nan)
    for a, s, v in allrows:
        if a in ai: M[ai[a], si[s]] = np.nan if v is None else v
    t0 = time.perf_counter()
    out = fast_corr.score_family_hybrid(ref, M, method, correlation_sql.score_pair)
    t_vec = time.perf_counter() - t0
    bad = 0; max_dr = 0; max_dp = 0; max_rel = 0; n_zero_p = 0; missing = 0
    for i, c in enumerate(cands):
        e = cache.get(c["id"])
        if e is None:
            if out["ok"][i]: bad += 1
            missing += 1
            continue
        if not out["ok"][i]: bad += 1; continue
        r, p, lag, npairs = e
        dr = abs(out["r"][i]-r); dp = abs(out["p"][i]-p)
        max_dr = max(max_dr, dr); max_dp = max(max_dp, dp)
        if p > 1e-290: max_rel = max(max_rel, dp/p)
        else: n_zero_p += 1
        if dr > 1e-12 or out["lag"][i] != lag or out["n_pairs"][i] != npairs or (dp > 1e-12 and dp/max(p,1e-300) > 1e-9):
            bad += 1
            if bad <= 5: print("   MISMATCH", c["annotation_id"], e, (out["r"][i], out["p"][i], out["lag"][i], out["n_pairs"][i]), "guard", out["guard"][i])
    print(f"[{method:12s}] endpoint cold {t_ep:.1f}s vs vectorised {t_vec:.2f}s | cached rows {len(rows)} (uncached/None {missing}) | mismatches={bad} | max|dr|={max_dr:.1e} max|dp|={max_dp:.1e} max rel dp (p>1e-290)={max_rel:.1e} | p<1e-290 rows={n_zero_p} | guarded={out['n_guarded']}")
    # top-50 ordering identical?
    ids_ep = [e["catalog_id"] for e in out_ep["results"]]
    sc = [{"catalog_id": c["id"], "r": float(out["r"][i]), "p": float(out["p"][i])} for i, c in enumerate(cands) if out["ok"][i]]
    sc = correlation_sql._apply_fdr(sc)
    for e in sc: e["significant"] = bool(e["q"] < 0.05)
    sc.sort(key=lambda e: (not e["significant"], -abs(e["r"])))
    print(f"    top-{len(ids_ep)} order identical: {ids_ep == [e['catalog_id'] for e in sc[:len(ids_ep)]]}; significant_count endpoint={out_ep['significant_count']} vec={sum(e['significant'] for e in sc)}")
    conn.close()
