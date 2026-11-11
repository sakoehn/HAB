"""After ("vectorised") timings of the real /correlations/family endpoint
on the real local hab_mappings.db, same six cases as baseline_real_db.py.
Writes normal cache rows, like using the app."""
import os, platform, sqlite3, subprocess, sys, time, warnings
from pathlib import Path
warnings.simplefilter("ignore")

REPO = Path(r"C:\Users\sakoehn\Desktop\JGI")
SCRATCH = Path(__file__).parent
sys.path.insert(0, str(REPO / "FastAPI"))
import numpy, scipy
from api import correlation_sql as cs

DB = REPO / "hab_mappings.db"
ro = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
sparse_id = ro.execute("SELECT annotation_id FROM annotation_catalog WHERE source='kegg' AND sample_count=25 "
                       "ORDER BY mean_egc DESC LIMIT 1").fetchone()[0]
CASES = [("kegg", "K02703", "kegg", "spearman"), ("kegg", "K02703", "kegg", "raw_pearson"),
         ("cog", "COG0001", "cog", "spearman"), ("kegg", "K02703", "enzyme", "spearman"),
         ("kegg", "K02703", "taxonomy", "spearman"), ("kegg", sparse_id, "enzyme", "spearman")]
BASELINE = [61.56, 46.17, 28.13, 18.85, 73.98, 13.76]   # TOTAL s from baseline_real_db_results.txt

# Time the pieces by wrapping them where the endpoint looks them up.
timing = {}
def timed(name, fn):
    def wrapper(*args, **kwargs):
        t0 = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            timing[name] = timing.get(name, 0.0) + time.perf_counter() - t0
    return wrapper
cs.load_family_matrix = timed("read", cs.load_family_matrix)
cs.score_family_checked = timed("score", cs.score_family_checked)
cs._save_batch = timed("save", cs._save_batch)
cs._fetch_saved_family = timed("fetch saved", cs._fetch_saved_family)
cs.load_sample_order = timed("sample order", cs.load_sample_order)

out = []
def say(s=""):
    print(s, flush=True); out.append(s)

head = subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], text=True).strip()
say("CORRELATION FINDER AFTER VECTORISING (real /correlations/family endpoint)")
say(f"date {time.strftime('%Y-%m-%d %H:%M')}  commit {head}  db {DB.name} ({DB.stat().st_size/1e9:.1f} GB, real data)")
say(f"machine {platform.processor()} | {os.cpu_count()} logical CPUs | python {platform.python_version()}  numpy {numpy.__version__}  scipy {scipy.__version__}")
say("cold = first request (nothing saved for this family); warm = the same request again")
say("note: this data was already read during earlier runs today, so Windows has much of it in memory;")
say("      the baseline's first reads were partly from disk (e.g. taxonomy 44.9 s cold vs 2.6 s again)")
say()
for i, (src, aid, target, method) in enumerate(CASES, 1):
    timing.clear()
    t0 = time.perf_counter()
    body = cs.correlation_family_endpoint(src, aid, target, "egc", method, limit=50)
    cold = time.perf_counter() - t0
    parts = dict(timing)
    timing.clear()
    t0 = time.perf_counter()
    again = cs.correlation_family_endpoint(src, aid, target, "egc", method, limit=50)
    warm = time.perf_counter() - t0
    same = again == body
    n = body["tested_count"] + body["untested_count"]
    say(f"[{i}] ref {src} {aid} vs {target}, {method}: {n:,} candidates "
        f"(scored {body['tested_count']:,}, could not score {body['untested_count']:,}, significant {body['significant_count']:,})")
    say(f"    cold  {cold:6.2f} s   (before: {BASELINE[i-1]:.2f} s -> {BASELINE[i-1]/cold:.0f}x faster)")
    say("          " + " | ".join(f"{k} {v:.2f} s" for k, v in parts.items()))
    say(f"    warm  {warm:6.2f} s   (second request identical to first: {same})")
    say()

conn = sqlite3.connect(DB)
say(f"saved rows now: correlations_cache {conn.execute('SELECT COUNT(*) FROM correlations_cache').fetchone()[0]:,}, "
    f"correlations_unscored {conn.execute('SELECT COUNT(*) FROM correlations_unscored').fetchone()[0]:,}")
(SCRATCH / "after_real_db_results.txt").write_text("\n".join(out), encoding="utf-8")
