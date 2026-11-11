import sys, warnings; warnings.simplefilter("ignore")
import numpy as np
sys.path.insert(0, r"C:\Users\sakoehn\Desktop\JGI\FastAPI")
from api import correlation_sql as cs
rng = np.random.default_rng(0)
def smooth(n=128, phi=0.85):
    x = np.zeros(n); x[0] = rng.normal()
    for i in range(1, n): x[i] = phi * x[i-1] + rng.normal()
    return list(np.exp(x))
T = 1000; one = free = x13 = meff = 0; meffs = []
for _ in range(T):
    a, b = smooth(), smooth()                     # two UNRELATED series
    r0, p0, _ = cs.core_scoring(a, b, "log_pearson"); one += p0 < 0.05            # lag 0 only
    br, bl, bp, bn = cs._spearman_at_lags(a, b, cs.CORRELATION_LAGS, "log_pearson")
    free += bp < 0.05                                                             # best of 13, no charge
    x13  += min(bp * 13, 1) < 0.05                                                # charge full 13
    m = cs._lag_tests_m_eff(a, b, "log_pearson"); meffs.append(m)
    meff += min(bp * m, 1) < 0.05                                                 # charge m_eff (what we do)
print(f"{T} pairs of UNRELATED smooth series, % called significant:")
print(f"  only lag 0 tried                     : {100*one/T:5.1f}%")
print(f"  best of 13 lags, no charge           : {100*free/T:5.1f}%")
print(f"  best of 13 lags, charged 13          : {100*x13/T:5.1f}%")
print(f"  best of 13 lags, charged m_eff (ours): {100*meff/T:5.1f}%   (median m_eff {np.median(meffs):.1f})")
