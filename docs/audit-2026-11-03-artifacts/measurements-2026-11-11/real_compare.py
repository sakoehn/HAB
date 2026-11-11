import sqlite3, sys, time, warnings; warnings.simplefilter("ignore")
sys.path.insert(0, r"C:\Users\sakoehn\Desktop\JGI\FastAPI")
import numpy as np
from api import correlation_sql as cs
from api.correlation_loaders import load_sample_order, load_vector
from api.correlation_vector import score_family_checked
conn = sqlite3.connect(r"file:C:\Users\sakoehn\Desktop\JGI\hab_mappings.db?mode=ro", uri=True)
order = load_sample_order(conn)
for (src, aid, target, method) in [("kegg","K02703","kegg","spearman"), ("kegg","K02703","kegg","raw_pearson"),
                                   ("kegg","K02703","kegg","log_pearson"), ("kegg","K08105","enzyme","spearman"),
                                   ("kegg","K02703","taxonomy","spearman")]:
    rid = conn.execute("SELECT id FROM annotation_catalog WHERE source=? AND annotation_id=?", (src, aid)).fetchone()[0]
    cands = cs.get_family_candidates(conn, rid, target)
    ref = load_vector(conn, src, aid, order, "egc")
    vecs = [load_vector(conn, target, c["annotation_id"], order, "egc") for c in cands]
    table = np.array([[np.nan if v is None else v for v in row] for row in vecs], dtype=float)
    t0 = time.perf_counter(); fast = score_family_checked(np.array([np.nan if v is None else v for v in ref]), table, method); tf = time.perf_counter()-t0
    t0 = time.perf_counter(); slow = [cs.score_pair(ref, v, method) for v in vecs]; ts = time.perf_counter()-t0
    bad = 0; dr = dp = 0.0
    for i, s in enumerate(slow):
        if s is None:
            bad += bool(fast["ok"][i]); continue
        if not fast["ok"][i] or fast["lag"][i] != s[2] or fast["n_pairs"][i] != s[3]: bad += 1; continue
        dr = max(dr, abs(fast["r"][i]-s[0])); dp = max(dp, abs(fast["p"][i]-s[1])/max(s[1],1e-300))
        if abs(fast["r"][i]-s[0]) > 1e-12 or abs(fast["p"][i]-s[1]) > max(1e-9*s[1], 1e-300): bad += 1
    print(f"{aid} vs {target:8s} {method:11s} {len(cands):6,d} cands | mismatches {bad} | max |dr| {dr:.1e} max rel dp {dp:.1e} | rechecked {fast['rechecked']} | score: old {ts:5.1f} s  new {tf:4.2f} s ({ts/tf:.0f}x)")
