import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, random, json
import numpy as np
from multiprocessing import Pool
from api.correlation_sql import score_pair, _apply_fdr
from api.config import CORRELATION_LAGS
N=128; OFF=30.0
def ar1(n, phi, rng):
    x=[rng.gauss(0,1)]
    for _ in range(n-1): x.append(phi*x[-1]+rng.gauss(0,1))
    return np.array(x)
def drop(v, rng, frac): return [None if rng.random()<frac else x for x in v]
def score(args): return score_pair(*args)

# 1. pure-null families: 2000 null candidates, no true positives
def null_family(seed):
    rng = random.Random(seed); ref = list(ar1(N,.85,rng)+OFF)
    cands = [list(ar1(N,.85,rng)+OFF) for _ in range(2000)]
    with Pool(11) as pool: res = pool.map(score, [(ref,c,'spearman') for c in cands], chunksize=40)
    scored = _apply_fdr([{'p': r[1]} for r in res if r is not None])
    sig = sum(s['q'] < 0.05 for s in scored)
    return {'seed': seed, 'tested': len(scored), 'false_discoveries': sig, 'min_p': min(s['p'] for s in scored), 'null_rate_p05': np.mean([s['p']<=0.05 for s in scored])}
out = [null_family(900+s) for s in range(10)]
print('PURE-NULL FAMILIES (2000 candidates each): false discoveries per family', [o['false_discoveries'] for o in out],
      '| families with >=1 FD:', sum(o['false_discoveries']>0 for o in out), '/10 | min p per family', [f"{o['min_p']:.1e}" for o in out],
      '| mean null p<=.05 rate', round(float(np.mean([o['null_rate_p05'] for o in out])),4))

# 2. power for a true lag-3 relationship (candidate leads by 3) with 20% missing
def tp_pair(seed, k, lag3, mcar):
    rng = random.Random(seed); a = ar1(N,.85,rng)+OFF; b = a + k*ar1(N,.85,rng)
    if lag3: b = np.concatenate([b[3:], ar1(3,.85,rng)+OFF])
    a=list(a); b=list(b)
    if mcar: a=drop(a,rng,.2); b=drop(b,rng,.2)
    return a,b
for k,lag3,mcar,label in ((1.0,True,True,'tp10_lag3_mcar'),(2.0,True,True,'tp20_lag3_mcar')):
    pairs = [tp_pair(7000+i,k,lag3,mcar) for i in range(1000)]
    with Pool(11) as pool: res = pool.map(score, [(a,b,'spearman') for a,b in pairs], chunksize=40)
    res=[r for r in res if r]
    print(label, 'power', round(np.mean([r[1]<=0.05 for r in res]),3), 'lag==3 recovered', round(np.mean([r[2]==3 for r in res]),3), 'mean|r|', round(np.mean([abs(r[0]) for r in res]),3), 'n_best mean', round(np.mean([r[3] for r in res]),1))

# 3. null rate by chosen lag (full, spearman) and the |r| each lag reports
pairs = []
for i in range(8000):
    rng = random.Random(20000+i); pairs.append((list(ar1(N,.85,rng)+OFF), list(ar1(N,.85,rng)+OFF)))
with Pool(11) as pool: res = pool.map(score, [(a,b,'spearman') for a,b in pairs], chunksize=50)
by = {}
for r in res:
    by.setdefault(abs(r[2]), []).append(r)
print('NULL (full/spearman, 8000 pairs): by |chosen lag|')
for L in sorted(by):
    rs = by[L]
    print(f'   |lag|={L}: chosen {len(rs)/len(res):5.1%}  p<=.05 rate {np.mean([r[1]<=0.05 for r in rs]):.3f}  mean|r| {np.mean([abs(r[0]) for r in rs]):.3f}')
# what the user would see for null candidates in the top-50 by |r| (the panel's non-significant tail)
top = sorted(res, key=lambda r: -abs(r[0]))[:400]
print('   top 5% of null pairs by |r|: share at |lag|=6:', round(np.mean([abs(r[2])==6 for r in top]),3), ' share at lag 0:', round(np.mean([r[2]==0 for r in top]),3), ' mean|r|', round(np.mean([abs(r[0]) for r in top]),3))
