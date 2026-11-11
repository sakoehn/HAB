import sys, warnings; warnings.simplefilter("ignore")
from pathlib import Path
import numpy as np
R = Path(r"C:\Users\sakoehn\Desktop\JGI")
sys.path.insert(0, str(R/"FastAPI")); sys.path.insert(0, str(R/"docs/audit-2026-11-03-artifacts/correlation-perf"))
from api import correlation_sql as cs
import fast_corr as fc
rng = np.random.default_rng(3)
for present in (25, 29, 30, 35):
    ref = np.full(128, np.nan); ref[:present] = rng.uniform(1, 10, present)   # reference seen in only `present` samples
    cands = rng.uniform(1, 10, (50, 128))                                      # 50 fully-present candidates
    ours = sum(cs.score_pair([None if np.isnan(v) else v for v in ref], list(c), "raw_pearson") is not None for c in cands)
    try:
        out = fc.score_family(ref, cands, "raw_pearson"); fast = f"{out['ok'].sum()} scored"
    except Exception as e:
        fast = f"CRASH ({type(e).__name__})"
    print(f"reference present in {present:3d} samples: ours {ours} scored, fast {fast}")
