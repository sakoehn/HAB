"""Inspect the candidates whose p differs in RELATIVE terms (p ~ 0 cases) and
check ref/cand orientation symmetry: score_pair(cand, ref) == (r, p, -lag, n)."""
import sys, warnings
import numpy as np
from bench_common import *
import fast_corr
warnings.simplefilter("ignore")
score_pair = correlation_sql.score_pair
conn = correlation_sql._connect()
order = correlation_loaders.load_sample_order(conn)
ref_id, cands = ref_and_candidates(conn, "cog", "COG0000", "kegg")
rng = np.random.default_rng(7)
pick = rng.choice(len(cands), size=2500, replace=False)
ref_list = correlation_loaders.load_vector(conn, "cog", "COG0000", order, "egc")
vecs = [correlation_loaders.load_vector(conn, "kegg", cands[i]["annotation_id"], order, "egc") for i in pick]
labels = [cands[i]["annotation_id"] for i in pick]
to_arr = lambda v: np.array([np.nan if x is None else x for x in v], dtype=float)
ref = to_arr(ref_list); n = len(ref)
sh = np.full(n, np.nan); sh[:-2] = ref[2:]
edge = [("identical", ref.copy()), ("shift2", sh), ("neg", -ref + 2*np.nanmax(ref))]
for name, arr in edge:
    vecs.append([None if not np.isfinite(x) else float(x) for x in arr]); labels.append("edge:"+name)
C = np.array([to_arr(v) for v in vecs])
for method in ("raw_pearson", "log_pearson", "spearman"):
    out = fast_corr.score_family(ref, C, method)
    exp = [score_pair(ref_list, v, method) for v in vecs]
    swapped = [score_pair(v, ref_list, method) for v in vecs]
    print(f"== {method}")
    shown = 0
    for i, e in enumerate(exp):
        if e is None or not out["ok"][i]: continue
        p = e[1]; pv = out["p"][i]
        rel = abs(pv - p) / max(p, 1e-300)
        if rel > 1e-9 and shown < 8:
            shown += 1
            print(f"  {labels[i]}: r={e[0]!r} vs {out['r'][i]!r}  p={p!r} vs {pv!r}  lag {e[2]}/{out['lag'][i]} n={e[3]} guard={out['guard'][i]}")
    # symmetry
    sym_bad = 0; max_dr = 0; max_dp = 0
    for i, (e, s) in enumerate(zip(exp, swapped)):
        if (e is None) != (s is None): sym_bad += 1; continue
        if e is None: continue
        max_dr = max(max_dr, abs(e[0]-s[0])); 
        if e[1] > 0: max_dp = max(max_dp, abs(e[1]-s[1])/e[1])
        if e[2] != -s[2] or e[3] != s[3] or abs(e[0]-s[0]) > 1e-12: sym_bad += 1
    print(f"  swap symmetry score_pair(cand, ref) vs score_pair(ref, cand): mismatches={sym_bad}, max|dr|={max_dr:.1e}, max rel dp={max_dp:.1e}")
conn.close()
