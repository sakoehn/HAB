import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, random
import numpy as np
from api.correlation_sql import _lag_tests_m_eff, _effective_n, _transformed_pair
rng = random.Random(3)
def ar1(n, phi):
    x=[rng.gauss(0,1)]
    for _ in range(n-1): x.append(phi*x[-1]+rng.gauss(0,1))
    return list(np.array(x)+30)
print(' n   max_lag  m_eff(mean, phi=.85)  N_eff/n (mean)   m_eff(mean, phi=0)')
for n in (10, 12, 15, 20, 25, 30, 40, 60, 128):
    ms=[]; ne=[]; mw=[]
    for _ in range(300):
        a,b = ar1(n,.85), ar1(n,.85)
        ms.append(_lag_tests_m_eff(a,b,'spearman'))
        x,y = _transformed_pair(a,b,'spearman'); ne.append(_effective_n(x,y)/n)
        mw.append(_lag_tests_m_eff(ar1(n,0), ar1(n,0), 'spearman'))
    print(f'{n:3d}   {n//5:4d}     {np.mean(ms):6.2f}              {np.mean(ne):5.2f}            {np.mean(mw):6.2f}')
