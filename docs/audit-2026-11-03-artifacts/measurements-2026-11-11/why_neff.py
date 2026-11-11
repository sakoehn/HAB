import sys, warnings; warnings.simplefilter("ignore")
import numpy as np
from scipy import stats
sys.path.insert(0, r"C:\Users\sakoehn\Desktop\JGI\FastAPI")
from api import correlation_sql as cs
rng = np.random.default_rng(0)
def smooth(n=128, phi=0.85):           # each point ~ 85% of the previous one + noise (EGC-like smoothness)
    x = np.zeros(n); x[0] = rng.normal()
    for i in range(1, n): x[i] = phi * x[i-1] + rng.normal()
    return x
naive = neff = lags13 = full = 0; T = 1000
for _ in range(T):
    a, b = smooth(), smooth()          # two UNRELATED series
    r, p = stats.pearsonr(a, b)
    naive += p < 0.05
    neff  += cs._effective_n_pvalue(r, cs._effective_n(a, b)) < 0.05
    A, B = list(np.exp(a)), list(np.exp(b))
    best = max((abs(stats.pearsonr(A[l:] if l>=0 else A[:l], B[:len(B)-l] if l>=0 else B[-l:])[0]), l) for l in cs.CORRELATION_LAGS)
    res = cs.score_pair(A, B, "log_pearson")
    full += res is not None and res[1] < 0.05
print(f"{T} pairs of UNRELATED smooth series, % called 'significant' (p < 0.05):")
print(f"  plain p-value, treat 128 points as independent : {100*naive/T:.1f}%")
print(f"  effective-N p-value, one lag                   : {100*neff/T:.1f}%")
print(f"  our full score_pair (13 lags, N_eff + m_eff)   : {100*full/T:.1f}%")
print("  (an honest test should say about 5%)")
