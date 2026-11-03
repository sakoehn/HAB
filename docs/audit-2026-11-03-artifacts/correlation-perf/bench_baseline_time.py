"""Un-profiled per-candidate wall time of the current code for each method
(first N candidates), then a full cold-family run through the real
correlation_family_endpoint for one method."""
import sys, time, sqlite3
from bench_common import *

N = int(sys.argv[1]) if len(sys.argv) > 1 else 400
full_method = sys.argv[2] if len(sys.argv) > 2 else "spearman"
metric = "egc"
for method in ("raw_pearson", "log_pearson", "spearman"):
    clear_cache()
    conn = correlation_sql._connect()
    order = correlation_loaders.load_sample_order(conn)
    ref_id, cands = ref_and_candidates(conn, "cog", "COG0000", "kegg")
    _vc = {}
    def get_vector(source, annotation_id):
        key = (source, annotation_id)
        if key not in _vc:
            _vc[key] = correlation_loaders.load_vector(conn, source, annotation_id, order, metric)
        return _vc[key]
    t0 = time.perf_counter(); n_none = 0
    for cand in cands[:N]:
        res = correlation_sql._get_or_compute_correlation(conn, ref_id, cand["id"], metric, method,
                                                          get_sample_order=lambda: order, get_vector=get_vector)
        n_none += res is None
    wall = time.perf_counter() - t0
    print(f"[{method:12s}] {N} candidates: {wall:.2f}s => {1000*wall/N:.2f} ms/candidate (None={n_none}); "
          f"13k extrapolated {wall/N*13000:.0f}s")
    conn.close()

# full cold family through the real endpoint
clear_cache()
t0 = time.perf_counter()
out = correlation_sql.correlation_family_endpoint("cog", "COG0000", "kegg", metric, full_method, limit=50)
wall = time.perf_counter() - t0
print(f"FULL cold family endpoint [{full_method}] kegg vs cog ref: {wall:.1f}s; tested={out['tested_count']} "
      f"significant={out['significant_count']}")
# warm run
t0 = time.perf_counter()
out = correlation_sql.correlation_family_endpoint("cog", "COG0000", "kegg", metric, full_method, limit=50)
print(f"WARM (all cached) family endpoint [{full_method}]: {time.perf_counter()-t0:.2f}s")
conn = sqlite3.connect(DB_PATH)
print("cache rows:", conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0])
