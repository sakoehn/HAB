"""Validate fast_corr.score_family against correlation_sql.score_pair on
random real-looking candidates from bench.db plus constructed edge cases."""
import sys, time, warnings
import numpy as np
from bench_common import *
import fast_corr
warnings.simplefilter("ignore")
score_pair = correlation_sql.score_pair

conn = correlation_sql._connect()
order = correlation_loaders.load_sample_order(conn)
ref_id, cands = ref_and_candidates(conn, "cog", "COG0000", "kegg")
rng = np.random.default_rng(7)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 2500
pick = rng.choice(len(cands), size=N, replace=False)
ref_list = correlation_loaders.load_vector(conn, "cog", "COG0000", order, "egc")
vecs = [correlation_loaders.load_vector(conn, "kegg", cands[i]["annotation_id"], order, "egc") for i in pick]
labels = [f"kegg:{cands[i]['annotation_id']}" for i in pick]

def to_arr(v):
    return np.array([np.nan if x is None else x for x in v], dtype=float)
ref = to_arr(ref_list)
n = len(ref)
# constructed edge cases
edge = []
refv = ref.copy()
edge.append(("identical to ref", refv.copy()))
sh = np.full(n, np.nan); sh[:-2] = refv[2:]; edge.append(("ref shifted by 2", sh))
sh = np.full(n, np.nan); sh[3:] = refv[:-3]; edge.append(("ref shifted by -3", sh))
edge.append(("negated ref", -refv + 2 * np.nanmax(refv)))
edge.append(("constant 7", np.full(n, 7.0)))
c = np.full(n, 7.0); c[5] = 8.0; edge.append(("constant but one", c))
c = np.full(n, np.nan); c[:10] = refv[:10] * 1.5 + 1; edge.append(("exactly 10 co-observed", c))
c = np.full(n, np.nan); c[:9] = refv[:9]; edge.append(("9 co-observed (None)", c))
c = refv.copy(); c[rng.random(n) < 0.5] = -1.0; edge.append(("half negative (missing)", c))
c = np.round(refv / np.nanmax(refv) * 5); c[c <= 0] = np.nan; edge.append(("heavy ties (6 levels)", c))
c = np.exp(rng.normal(0, 1, n)); edge.append(("pure noise", c))
c = np.exp(np.sin(np.arange(n) / 4.0)); edge.append(("periodic", c))
c = np.exp(np.arange(n) * 0.05); edge.append(("exponential trend", c))
c = refv.copy(); c[::2] = np.nan; edge.append(("every other missing", c))
c = refv.copy(); c[:64] = np.nan; edge.append(("first half missing", c))
c = refv.copy(); c[c > np.nanmedian(c)] = np.nan; edge.append(("top half missing", c))
z = refv.copy(); z[np.isnan(z)] = 0.0; edge.append(("zeros instead of NaN", z))
c = np.where(np.isnan(refv), 1.0, np.nan); edge.append(("complement of ref support", c))
c = np.full(n, np.nan); c[:12] = [1,2,3,4,5,6,7,8,9,10,11,12]; edge.append(("12 points linear", c))
c = np.full(n, np.nan); c[:12] = np.array([1,2,3,4,5,6,7,8,9,10,11,12])**2; edge.append(("12 points quadratic", c))
for name, arr in edge:
    vecs.append([None if not np.isfinite(x) else float(x) for x in arr]); labels.append("edge:" + name)
# also some random sparse rows from other sources
C = np.array([to_arr(v) for v in vecs])
print(f"validating {C.shape[0]} candidates x {C.shape[1]} samples; ref missing={np.isnan(ref).sum()}")

tot_bad = 0
for method in ("raw_pearson", "log_pearson", "spearman"):
    t0 = time.perf_counter()
    exp = [score_pair(ref_list, v, method) for v in vecs]
    t_scalar = time.perf_counter() - t0
    t0 = time.perf_counter()
    out = fast_corr.score_family(ref, C, method)
    t_vec = time.perf_counter() - t0
    hyb = fast_corr.score_family_hybrid(ref, C, method, score_pair)
    bad = []; max_dr = 0.0; max_dp_rel = 0.0; max_dp_abs = 0.0
    n_none = 0
    for i, e in enumerate(exp):
        if e is None:
            n_none += 1
            if out["ok"][i]: bad.append((labels[i], "vector ok but scalar None", None)); continue
            continue
        if not out["ok"][i]: bad.append((labels[i], "scalar ok but vector None", e)); continue
        r, p, lag, npairs = e[0], e[1], e[2], e[3]
        dr = abs(out["r"][i] - r); max_dr = max(max_dr, dr)
        dp = abs(out["p"][i] - p); max_dp_abs = max(max_dp_abs, dp)
        rel = dp / max(p, 1e-300); max_dp_rel = max(max_dp_rel, rel)
        if dr > 1e-12 or out["lag"][i] != lag or out["n_pairs"][i] != npairs or (dp > 1e-12 and rel > 1e-9):
            bad.append((labels[i], f"r {r} vs {out['r'][i]} | p {p} vs {out['p'][i]} | lag {lag} vs {out['lag'][i]} | n {npairs} vs {out['n_pairs'][i]} | guard={out['guard'][i]}", None))
    # hybrid check (after scalar fallback on guarded rows)
    hbad = 0
    for i, e in enumerate(exp):
        if e is None:
            hbad += bool(hyb["ok"][i]); continue
        if not hyb["ok"][i]: hbad += 1; continue
        if abs(hyb["r"][i]-e[0])>1e-12 or hyb["lag"][i]!=e[2] or hyb["n_pairs"][i]!=e[3] or abs(hyb["p"][i]-e[1])/max(e[1],1e-300)>1e-9 and abs(hyb["p"][i]-e[1])>1e-12: hbad += 1
    print(f"[{method:12s}] scalar {t_scalar:.2f}s  vector {t_vec:.2f}s  ({t_scalar/t_vec:.0f}x) | None={n_none} | max|dr|={max_dr:.2e} max|dp|={max_dp_abs:.2e} max rel dp={max_dp_rel:.2e} | mismatches={len(bad)} guarded={hyb['n_guarded']} hybrid mismatches={hbad}")
    for b in bad[:12]:
        print("    MISMATCH", b)
    tot_bad += len(bad)
    # distribution of lags and m_eff for info
    ok = out["ok"]
    print(f"    lags found: {dict(zip(*np.unique(out['lag'][ok], return_counts=True)))}; m_eff median {np.median(out['m_eff'][ok]):.2f}; n_pairs min {out['n_pairs'][ok].min()}")
print("TOTAL mismatches:", tot_bad)
conn.close()
