"""Baseline ("before") timings of TODAY's correlation family code on the real
local hab_mappings.db. Opens the real db READ-ONLY; cache writes are timed
against a throwaway copy of the correlations_cache table in a scratch db."""
import os, platform, sqlite3, subprocess, sys, time, warnings
from pathlib import Path
warnings.simplefilter("ignore")

REPO = Path(r"C:\Users\sakoehn\Desktop\JGI")
SCRATCH = Path(__file__).parent
sys.path.insert(0, str(REPO / "FastAPI"))
import numpy, scipy
from api import correlation_sql as cs
from api.correlation_loaders import load_sample_order, load_vector

DB = REPO / "hab_mappings.db"
conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

def ref(source, annotation_id):
    row = conn.execute("SELECT id, name, sample_count FROM annotation_catalog WHERE source=? AND annotation_id=?",
                       (source, annotation_id)).fetchone()
    return {"source": source, "annotation_id": annotation_id, "id": row[0], "name": row[1], "samples": row[2]}

# a sparsely detected kegg reference: detected in 25 samples, highest mean EGC among those
sparse_id = conn.execute("SELECT annotation_id FROM annotation_catalog WHERE source='kegg' AND sample_count=25 "
                         "ORDER BY mean_egc DESC LIMIT 1").fetchone()[0]

CASES = [  # (reference, target source, method)
    (ref("kegg", "K02703"), "kegg", "spearman"),
    (ref("kegg", "K02703"), "kegg", "raw_pearson"),
    (ref("cog", "COG0001"), "cog", "spearman"),
    (ref("kegg", "K02703"), "enzyme", "spearman"),
    (ref("kegg", "K02703"), "taxonomy", "spearman"),
    (ref("kegg", sparse_id), "enzyme", "spearman"),
]

# throwaway cache db with the real table definition (default synchronous=FULL, WAL like live)
scratch_db = SCRATCH / "baseline_cache_scratch.db"
for suffix in ("", "-wal", "-shm"):
    p = Path(str(scratch_db) + suffix)
    if p.exists(): p.unlink()
wconn = sqlite3.connect(scratch_db)
wconn.execute("PRAGMA journal_mode=WAL")
ddl = conn.execute("SELECT sql FROM sqlite_master WHERE name='correlations_cache'").fetchone()[0]
wconn.execute(ddl.replace("REFERENCES annotation_catalog(id)", ""))
wconn.commit()

def git_head():
    try: return subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], text=True).strip()
    except Exception: return "?"

out = []
def say(s=""):
    print(s, flush=True); out.append(s)

say("CORRELATION FINDER BASELINE (today's code, before vectorising)")
say(f"date {time.strftime('%Y-%m-%d %H:%M')}  commit {git_head()}  db {DB.name} ({DB.stat().st_size/1e9:.1f} GB, real data, read-only)")
say(f"machine {platform.processor()} | {os.cpu_count()} logical CPUs | {platform.platform()}")
say(f"python {platform.python_version()}  numpy {numpy.__version__}  scipy {scipy.__version__}")
say("timings: wall clock, single run each; 'read' = load_vector once per candidate (as the endpoint does),")
say("'score' = score_pair per candidate, 'save' = INSERT + commit per scored candidate into a scratch copy of correlations_cache")
say("note: local SSD + Windows file cache; the AWS server's disk is likely slower for 'read' (not measured here)")
say()

t0 = time.perf_counter(); order = load_sample_order(conn); t_order = time.perf_counter() - t0
say(f"load_sample_order: {t_order:.2f} s ({len(order)} samples)")
say()

vec_cache = {}   # same reference/candidates reused across methods, like the endpoint's per-request memo does not
for i, (r, target, method) in enumerate(CASES, 1):
    cands = cs.get_family_candidates(conn, r["id"], target)
    say(f"[{i}] ref {r['source']} {r['annotation_id']} ({(r['name'] or '')[:45]}; detected in {r['samples']} samples)")
    say(f"    vs {target}, {method}: {len(cands):,} candidates")

    key = (r["id"], target)
    if key in vec_cache:
        ref_vec, vecs, t_read, t_reread = vec_cache[key]
        read_note = "(reused from the run above; not re-timed)"
    else:
        t0 = time.perf_counter()
        ref_vec = load_vector(conn, r["source"], r["annotation_id"], order, "egc")
        vecs = [load_vector(conn, target, c["annotation_id"], order, "egc") for c in cands]
        t_read = time.perf_counter() - t0
        t0 = time.perf_counter()
        for c in cands: load_vector(conn, target, c["annotation_id"], order, "egc")
        t_reread = time.perf_counter() - t0
        vec_cache[key] = (ref_vec, vecs, t_read, t_reread)
        read_note = ""

    t0 = time.perf_counter()
    results = [cs.score_pair(ref_vec, v, method) for v in vecs]
    t_score = time.perf_counter() - t0
    scored = [(c, res) for c, res in zip(cands, results) if res is not None]

    t0 = time.perf_counter()
    for c, res in scored:
        lo, hi = sorted((r["id"], c["id"]))
        wconn.execute("INSERT OR IGNORE INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric, method, "
                      "lag_samples, p_value, n_pairs, at_p_floor) VALUES (?,?,?,?,?,?,?,?,?)",
                      (lo, hi, res[0], "egc", method + f"_run{i}", res[2], res[1], res[3], None))
        wconn.commit()
    t_save = time.perf_counter() - t0

    n = max(len(cands), 1)
    total = t_read + t_score + t_save
    say(f"    scored {len(scored):,}, could not score {len(cands) - len(scored):,}")
    say(f"    read  {t_read:7.2f} s  ({1000*t_read/n:.2f} ms/candidate; second read {t_reread:.2f} s) {read_note}")
    say(f"    score {t_score:7.2f} s  ({1000*t_score/n:.2f} ms/candidate)")
    say(f"    save  {t_save:7.2f} s  ({1000*t_save/max(len(scored),1):.2f} ms/row, {len(scored):,} commits)")
    say(f"    TOTAL {total:7.2f} s  {'(over the 60 s nginx limit)' if total > 60 else ''}")
    say()

say("How often would the prototype's sparse-reference crash hit? (references detected in < 30 samples)")
say(f"    {'source':9s} {'total':>7s} {'<10 samples':>12s} {'10-29 samples':>14s} {'>=30':>7s}")
for src, total, lt10, mid, ge30 in conn.execute(
        "SELECT source, COUNT(*), SUM(sample_count < 10), SUM(sample_count BETWEEN 10 AND 29), SUM(sample_count >= 30) "
        "FROM annotation_catalog GROUP BY source ORDER BY source"):
    say(f"    {src:9s} {total:7,d} {lt10:12,d} {mid:14,d} {ge30:7,d}")
say("    (<10: can never be scored at all; 10-29: scorable today, would crash the prototype)")

(SCRATCH / "baseline_real_db_results.txt").write_text("\n".join(out), encoding="utf-8")
wconn.close()
