import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, random
import numpy as np
from api.correlation_sql import score_pair, core_scoring
rng = random.Random(77)
def ar1(n, phi):
    x=[rng.gauss(0,1)]
    for _ in range(n-1): x.append(phi*x[-1]+rng.gauss(0,1))
    return np.array(x)+30
# Two ways a pair ends up with a short overlap: (a) both series only exist for n samples
# (short series); (b) both are 128 long but the candidate is detected only in a window of n.
for n in (12, 16, 20, 30):
    for mode in ('short', 'window'):
        hits_app = hits0 = tot = 0; neffs=[]
        for _ in range(2000):
            if mode == 'short':
                a, b = list(ar1(n,.85)), list(ar1(n,.85))
            else:
                a = list(ar1(128,.85)); bb = ar1(128,.85); s = rng.randrange(0, 128-n)
                b = [float(v) if s <= i < s+n else None for i, v in enumerate(bb)]
            sp = score_pair(a, b, 'spearman'); c0 = core_scoring(a, b, 'spearman')
            if sp is None or c0 is None: continue
            tot += 1; hits_app += sp[1] <= 0.05; hits0 += c0[1] <= 0.05
        print(f'n={n:3d} {mode:6s}: app rate {hits_app/tot:.3f}   lag-0 effN rate {hits0/tot:.3f}   (pairs {tot})')
