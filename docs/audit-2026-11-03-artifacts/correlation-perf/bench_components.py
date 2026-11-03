"""Un-profiled per-candidate cost of each primitive in the current scalar
path, on a typical candidate (~100 co-observed points), repeated."""
import time, math, warnings
import numpy as np
from scipy import stats
from bench_common import *
warnings.simplefilter("ignore")
cs = correlation_sql
conn = correlation_sql._connect()
order = correlation_loaders.load_sample_order(conn)
ref_id, cands = ref_and_candidates(conn, "cog", "COG0000", "kegg")
ref = correlation_loaders.load_vector(conn, "cog", "COG0000", order, "egc")
# pick a typical (non-sparse) candidate
for c in cands:
    v = correlation_loaders.load_vector(conn, "kegg", c["annotation_id"], order, "egc")
    if sum(1 for a, b in zip(ref, v) if a and b and a > 0 and b > 0) >= 70: break
cand = v; cand_id = c["id"]; cand_ann = c["annotation_id"]
REP = 300
def tm(fn, reps=REP):
    t0 = time.perf_counter()
    for _ in range(reps): fn()
    return 1000 * (time.perf_counter() - t0) / reps
print(f"typical candidate {cand_ann}: {sum(1 for a,b in zip(ref,cand) if a and b and a>0 and b>0)} co-observed")
rows = {}
rows["load_vector (1 SQL + 128-iter python)"] = tm(lambda: correlation_loaders.load_vector(conn, "kegg", cand_ann, order, "egc"))
rows["cache lookup SELECT (miss)"] = tm(lambda: conn.execute("SELECT * FROM correlations_cache WHERE catalog_id_a=? AND catalog_id_b=? AND metric=? AND method=?", (ref_id, cand_id, "egc", "spearman")).fetchone())
rows["catalog lookups x2"] = tm(lambda: (conn.execute("SELECT source, annotation_id FROM annotation_catalog WHERE id = ?", (ref_id,)).fetchone(), conn.execute("SELECT source, annotation_id FROM annotation_catalog WHERE id = ?", (cand_id,)).fetchone()))
for method in ("raw_pearson", "log_pearson", "spearman"):
    rows[f"_transformed_pair x14 [{method}]"] = 14 * tm(lambda: cs._transformed_pair(ref, cand, method))
pair = cs._transformed_pair(ref, cand, "raw_pearson"); x, y = pair
rows["  of which python filter loop x14"] = 14 * tm(lambda: [i for i in range(len(ref)) if not ((ref[i] is None or ref[i] <= 0) or (cand[i] is None or cand[i] <= 0))])
rows["  rankdata x2 (spearman only) x13"] = 13 * tm(lambda: (stats.rankdata(x), stats.rankdata(y)))
rows["  math.log x2 (log_pearson only) x14"] = 14 * tm(lambda: ([math.log(v) for v in x], [math.log(v) for v in y]))
rows["pearsonr x13"] = 13 * tm(lambda: stats.pearsonr(x, y))
xa, ya = np.asarray(x, float), np.asarray(y, float)
rows["_effective_n x13 (np.correlate x2 each)"] = 13 * tm(lambda: cs._effective_n(xa, ya))
r = stats.pearsonr(x, y)[0]; ne = cs._effective_n(xa, ya)
rows["_effective_n_pvalue (stats.t.sf) x13"] = 13 * tm(lambda: cs._effective_n_pvalue(r, ne))
rows["core_scoring x13 (sum of the above per lag)"] = 13 * tm(lambda: cs.core_scoring(x, y, "raw_pearson"))
rows["_lag_tests_m_eff x1 (incl. one _transformed_pair, 169 dots, eigvalsh)"] = tm(lambda: cs._lag_tests_m_eff(ref, cand, "spearman"))
rows["  np.linalg.eigvalsh 13x13 x1"] = tm(lambda: np.linalg.eigvalsh(np.eye(13)))
for method in ("raw_pearson", "log_pearson", "spearman"):
    rows[f"score_pair total [{method}]"] = tm(lambda: cs.score_pair(ref, cand, method), 100)
rows["INSERT + commit (WAL, synchronous=FULL) [from bench_commit]"] = 0.839
for k, v in rows.items():
    print(f"{v:8.3f} ms  {k}")
conn.close()
