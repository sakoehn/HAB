"""Family-wise realized FDR: one reference vs 2000 null candidates + 20 true
positives, scored by score_pair and passed through _apply_fdr exactly as the
family endpoint does."""
import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, random, json
import numpy as np
from multiprocessing import Pool
from api.correlation_sql import score_pair, _apply_fdr
N = 128; OFF = 30.0

def ar1(n, phi, rng):
    x = [rng.gauss(0, 1)]
    for _ in range(n - 1): x.append(phi * x[-1] + rng.gauss(0, 1))
    return np.array(x)

def drop(v, rng, frac):
    return [None if rng.random() < frac else x for x in v]

def score(args):
    ref, cand, method = args
    return score_pair(ref, cand, method)

def run_family(seed, cond, method, n_null=2000, n_tp=20):
    rng = random.Random(seed)
    phi = 0.85
    ref = ar1(N, phi, rng) + OFF
    tr = np.linspace(0, 8, N) if cond == 'trend' else 0
    ref = ref + tr
    cands = []; truth = []
    for i in range(n_null):
        cands.append(ar1(N, phi, rng) + OFF + tr); truth.append(False)
    for i in range(n_tp):
        k = 0.2 if i < n_tp // 2 else 1.5     # half strong (r~0.9), half moderate (r~0.55)
        cands.append(ref + k * ar1(N, phi, rng)); truth.append(True)
    ref_l = list(ref); cand_l = [list(c) for c in cands]
    if cond == 'mcar':
        ref_l = drop(ref_l, rng, 0.2); cand_l = [drop(c, rng, 0.2) for c in cand_l]
    with Pool(11) as pool:
        res = pool.map(score, [(ref_l, c, method) for c in cand_l], chunksize=40)
    scored = []
    for t, r in zip(truth, res):
        if r is None: continue
        scored.append({'p': r[1], 'true': t, 'r': r[0]})
    scored = _apply_fdr(scored)
    sig = [s for s in scored if s['q'] < 0.05]
    fd = sum(not s['true'] for s in sig)
    tp_found = sum(s['true'] for s in sig)
    n_true = sum(s['true'] for s in scored); n_nulls = len(scored) - n_true
    raw05 = sum((not s['true']) and s['p'] <= 0.05 for s in scored) / n_nulls
    return {'seed': seed, 'cond': cond, 'method': method, 'tested': len(scored), 'discoveries': len(sig),
            'false_discoveries': fd, 'fdp': fd / max(1, len(sig)), 'power': tp_found / n_true,
            'null_rate_p05': raw05, 'min_null_p': min(s['p'] for s in scored if not s['true'])}

if __name__ == '__main__':
    out = []
    for cond in ['full', 'mcar']:
        for seed in range(12):
            r = run_family(500 + seed, cond, 'spearman')
            print(json.dumps(r), flush=True); out.append(r)
    # Pure-null family: no true positives at all -> any discovery is false
    for seed in range(8):
        r = run_family(900 + seed, 'full', 'spearman', n_tp=0)
        print(json.dumps(r), flush=True); out.append(r)
    with open('./sim_fdr.json', 'w') as f:
        json.dump(out, f, indent=1)
