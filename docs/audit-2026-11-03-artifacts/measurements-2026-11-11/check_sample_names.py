"""Read-only: how long does listing the 128 sample names take on this
server, and does its SQLite skip ahead through the index? Saves nothing.
Run from ~/HAB/FastAPI: python check_sample_names.py"""
import sqlite3, sys, time
sys.path.insert(0, ".")
from api.config import SQLITE_DB_PATH

conn = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
q = "SELECT DISTINCT sample FROM mappings ORDER BY sample"
print("SQLite version:", sqlite3.sqlite_version)
ops = [r[1] for r in conn.execute("EXPLAIN " + q)]
print("skips ahead (SeekGT step):", "SeekGT" in ops)
t0 = time.perf_counter()
n = len(conn.execute(q).fetchall())
print(f"sample names: {n} in {time.perf_counter() - t0:.2f} s")
