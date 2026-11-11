"""Read-only timing of each piece of a cold /correlations/family request,
run on the server: python time_family_pieces.py <ref_source> <ref_id> <target_source>
Opens the database read-only; saves nothing."""
import sqlite3, sys, time, warnings
warnings.simplefilter("ignore")
sys.path.insert(0, ".")
import numpy as np
from api.config import SQLITE_DB_PATH
from api import correlation_sql as cs
from api.correlation_loaders import load_family_matrix, load_sample_order, load_vector
from api.correlation_vector import score_family_checked

ref_source, ref_id, target = sys.argv[1], sys.argv[2], sys.argv[3]
conn = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)

def step(label, fn):
    t0 = time.perf_counter(); out = fn(); print(f"{label:28s} {time.perf_counter() - t0:7.2f} s", flush=True); return out

ref_cat = conn.execute("SELECT id FROM annotation_catalog WHERE source=? AND annotation_id=?", (ref_source, ref_id)).fetchone()[0]
order = step("sample order", lambda: load_sample_order(conn))
cands = step("candidate list", lambda: cs.get_family_candidates(conn, ref_cat, target))
ref = step("reference values", lambda: np.array(load_vector(conn, ref_source, ref_id, order, "egc"), dtype=float))
ids = [c["annotation_id"] for c in cands]
table = step(f"read {len(ids):,} candidates", lambda: load_family_matrix(conn, target, ids, order, "egc"))
print(f"{'':28s} ({int(np.isfinite(table).sum()):,} values)")
step("score (spearman)", lambda: score_family_checked(ref, table, "spearman"))
table = step("read again (now cached)", lambda: load_family_matrix(conn, target, ids, order, "egc"))
