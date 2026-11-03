"""Cost of the cache write pattern: one INSERT + commit per candidate (WAL,
synchronous=FULL default) vs synchronous=NORMAL vs executemany + one commit."""
import os, sqlite3, time, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "bench.db"); DB = os.path.join(HERE, "bench_commit.db")
shutil.copy(SRC, DB)
for ext in ("-wal", "-shm"):
    if os.path.exists(DB + ext): os.remove(DB + ext)
N = 2000
rows = [(1, 100000 + i, 0.5, "egc", "spearman", 0, 0.01, 100, None) for i in range(N)]
INS = ("INSERT INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric, method, lag_samples, "
       "p_value, n_pairs, at_p_floor) VALUES (?,?,?,?,?,?,?,?,?)")
def run(label, sync, batched):
    conn = sqlite3.connect(DB); conn.execute("PRAGMA busy_timeout=10000")
    conn.execute(f"PRAGMA synchronous={sync}")
    print("  journal_mode:", conn.execute("PRAGMA journal_mode").fetchone()[0], "synchronous:", conn.execute("PRAGMA synchronous").fetchone()[0])
    conn.execute("DELETE FROM correlations_cache"); conn.commit()
    t0 = time.perf_counter()
    if batched:
        conn.executemany(INS, rows); conn.commit()
    else:
        for r in rows:
            conn.execute(INS, r); conn.commit()
    dt = time.perf_counter() - t0
    print(f"{label}: {N} rows in {dt:.3f}s => {1000*dt/N:.3f} ms/row")
    conn.close()
run("per-row commit, synchronous=FULL (current)", "FULL", False)
run("per-row commit, synchronous=NORMAL", "NORMAL", False)
run("executemany + 1 commit, FULL", "FULL", True)
run("executemany + 1 commit, NORMAL", "NORMAL", True)
os.remove(DB)
for ext in ("-wal", "-shm"):
    if os.path.exists(DB + ext): os.remove(DB + ext)
