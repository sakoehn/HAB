"""(a) Load all candidate vectors for a source in one query and pivot to a
dense (n_candidates x 128) matrix, vs. 13k load_vector calls. Warm page cache."""
import os, sqlite3, time, shutil, sys
import numpy as np
from bench_common import *
DB = os.path.join(HERE, "bench_load.db")
shutil.copy(DB_PATH, DB)
conn = sqlite3.connect(DB)
order = correlation_loaders.load_sample_order(conn)
ref_id, cands = ref_and_candidates(conn, "cog", "COG0000", "kegg")
# per-candidate load_vector (current path)
t0 = time.perf_counter()
vecs = [correlation_loaders.load_vector(conn, "kegg", c["annotation_id"], order, "egc") for c in cands]
print(f"load_vector x {len(cands)}: {time.perf_counter()-t0:.2f}s")

def load_matrix(conn, source, metric, order, ann_ids):
    col = {"egc": "egc", "norm_egc": "norm_egc"}[metric]
    t0 = time.perf_counter()
    rows = conn.execute(f"SELECT annotation_id, sample, {col} FROM annotation_series WHERE source = ?", (source,)).fetchall()
    t1 = time.perf_counter()
    ann_index = {a: i for i, a in enumerate(ann_ids)}
    s_index = {s: j for j, s in enumerate(order)}
    M = np.full((len(ann_ids), len(order)), np.nan)
    ai = np.fromiter((ann_index.get(r[0], -1) for r in rows), dtype=np.int64, count=len(rows))
    si = np.fromiter((s_index[r[1]] for r in rows), dtype=np.int64, count=len(rows))
    vals = np.array([r[2] if r[2] is not None else np.nan for r in rows], dtype=float)
    keep = ai >= 0
    M[ai[keep], si[keep]] = vals[keep]
    t2 = time.perf_counter()
    print(f"one-query load source={source}: SQL {t1-t0:.2f}s ({len(rows):,} rows), pivot {t2-t1:.2f}s, total {t2-t0:.2f}s")
    return M
ann_ids = [c["annotation_id"] for c in cands]
M = load_matrix(conn, "kegg", "egc", order, ann_ids)
# verify equal to load_vector output
V = np.array([[np.nan if v is None else v for v in vec] for vec in vecs])
assert np.array_equal(np.isnan(M), np.isnan(V)) and np.array_equal(M[~np.isnan(M)], V[~np.isnan(V)])
print("dense matrix equals load_vector output: OK; matrix MB:", M.nbytes/1e6)
# pandas alternative
import pandas as pd
t0 = time.perf_counter()
df = pd.read_sql_query("SELECT annotation_id, sample, egc FROM annotation_series WHERE source = ?", conn, params=("kegg",))
P = df.pivot(index="annotation_id", columns="sample", values="egc").reindex(index=ann_ids, columns=order)
print(f"pandas read_sql + pivot: {time.perf_counter()-t0:.2f}s")
print("EXPLAIN:", conn.execute("EXPLAIN QUERY PLAN SELECT annotation_id, sample, egc FROM annotation_series WHERE source = ?", ("kegg",)).fetchall())
# covering index variant
t0 = time.perf_counter()
conn.execute("CREATE INDEX idx_cov ON annotation_series(source, annotation_id, sample, egc, norm_egc)"); conn.commit()
print(f"covering index build: {time.perf_counter()-t0:.1f}s")
print("EXPLAIN w/ covering:", conn.execute("EXPLAIN QUERY PLAN SELECT annotation_id, sample, egc FROM annotation_series WHERE source = ?", ("kegg",)).fetchall())
M2 = load_matrix(conn, "kegg", "egc", order, ann_ids)
conn.close()
# cold page cache measurement using posix_fadvise DONTNEED (unprivileged)
def drop(path):
    fd = os.open(path, os.O_RDONLY); os.fsync(fd) if False else None
    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED); os.close(fd)
def read_bytes():
    with open("/proc/self/io") as f:
        for line in f:
            if line.startswith("read_bytes"): return int(line.split()[1])
for label, sql_fn in [("per-candidate load_vector (cold cache)", None), ("one query, table scan via (source,annotation_id) index (cold)", "noidx"), ("one query, covering index (cold)", "cov")]:
    drop(DB)
    conn = sqlite3.connect(DB)
    if sql_fn == "noidx":
        conn.execute("DROP INDEX IF EXISTS idx_cov"); conn.commit(); drop(DB)
    rb0 = read_bytes(); t0 = time.perf_counter()
    if sql_fn is None:
        for c in cands: correlation_loaders.load_vector(conn, "kegg", c["annotation_id"], order, "egc")
    else:
        conn.execute("SELECT annotation_id, sample, egc FROM annotation_series WHERE source = ?", ("kegg",)).fetchall()
    print(f"{label}: {time.perf_counter()-t0:.2f}s, disk read {(read_bytes()-rb0)/1e6:.0f} MB")
    conn.close()
os.remove(DB)
