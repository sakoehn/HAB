import cProfile, pstats, io, warnings, sys, time
import numpy as np
from bench_common import *
import fast_corr
warnings.simplefilter("ignore")
conn = correlation_sql._connect(); order = correlation_loaders.load_sample_order(conn)
ref_id, cands = ref_and_candidates(conn, "cog", "COG0000", "kegg")
ref = np.array([np.nan if v is None else v for v in correlation_loaders.load_vector(conn, "cog", "COG0000", order, "egc")])
rows = conn.execute("SELECT annotation_id, sample, egc FROM annotation_series WHERE source='kegg'").fetchall()
ai = {c["annotation_id"]: i for i, c in enumerate(cands)}; si = {s: j for j, s in enumerate(order)}
M = np.full((len(cands), 128), np.nan)
for a, s, v in rows: M[ai[a], si[s]] = v
for method in ("raw_pearson", "spearman"):
    fast_corr.score_family(ref, M, method)  # warm
    t0 = time.perf_counter(); fast_corr.score_family(ref, M, method); t = time.perf_counter() - t0
    pr = cProfile.Profile(); pr.enable(); fast_corr.score_family(ref, M, method); pr.disable()
    s = io.StringIO(); pstats.Stats(pr, stream=s).sort_stats("tottime").print_stats(14)
    print(f"=== score_family [{method}] 13k x 128: {t:.2f}s un-profiled = {1000*t/len(cands):.3f} ms/candidate")
    print("\n".join(l for l in s.getvalue().splitlines() if "fast_corr.py" in l or "{" in l or "ncalls" in l)[:3000])
