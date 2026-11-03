import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, sqlite3, random
import numpy as np
from api.correlation_sql import _get_or_compute_correlation, _spearman_at_lags, score_pair
from api.config import CORRELATION_LAGS

# A. Explicit direction: candidate peaks EARLIER than reference by 2 samples
t = np.arange(40)
ref = list(30 + 10*np.exp(-((t-20)/4.0)**2))   # ref peaks at t=20
cand = list(30 + 10*np.exp(-((t-18)/4.0)**2))  # cand peaks at t=18 (earlier)
r, lag, p, n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, 'raw_pearson')
print('cand peaks 2 samples EARLIER than ref -> best_lag =', lag, '(positive = candidate leads; panel says "leads by 8h")')
cand2 = list(30 + 10*np.exp(-((t-23)/4.0)**2))  # cand peaks LATER by 3
r, lag, p, n = _spearman_at_lags(ref, cand2, CORRELATION_LAGS, 'raw_pearson')
print('cand peaks 3 samples LATER than ref  -> best_lag =', lag, '(negative = candidate lags; panel says "lags by 12h")')

# B. Symmetry with missing values: swapping roles negates the lag, keeps r and p
rng = random.Random(5)
def ar1(n, phi):
    x=[rng.gauss(0,1)]
    for _ in range(n-1): x.append(phi*x[-1]+rng.gauss(0,1))
    return np.array(x)+30
bad = 0; checked = 0
for k in range(300):
    a = ar1(128, .85); b = np.concatenate([a[3:], ar1(3,.85)]) + 0.5*ar1(128,.85)   # b leads a by 3
    a = list(a); b = list(b)
    for i in range(128):
        if rng.random()<0.2: a[i]=None
        if rng.random()<0.2: b[i]=None
    s1 = score_pair(a, b, 'spearman'); s2 = score_pair(b, a, 'spearman')
    if s1 is None or s2 is None: continue
    checked += 1
    if not (abs(s1[0]-s2[0])<1e-12 and s1[2] == -s2[2] and abs(s1[1]-s2[1])<1e-9 and s1[3]==s2[3]):
        bad += 1; print('asymmetry:', s1, s2)
print(f'role swap: {checked} pairs checked, {bad} asymmetric (r, p, n equal and lag negated otherwise)')

# C. Fresh compute with the HIGH id as the caller's reference (the untested CR1 path)
SCHEMA = """
CREATE TABLE annotation_catalog(id INTEGER PRIMARY KEY, source TEXT NOT NULL, annotation_id TEXT NOT NULL, name TEXT, parent TEXT, depth INTEGER, UNIQUE (source, annotation_id));
CREATE TABLE annotation_series(id INTEGER PRIMARY KEY, source TEXT NOT NULL, sample TEXT NOT NULL, annotation_id TEXT NOT NULL, egc REAL, norm_egc REAL, UNIQUE(source, sample, annotation_id));
CREATE TABLE correlations_cache(id INTEGER PRIMARY KEY, catalog_id_a INTEGER NOT NULL, catalog_id_b INTEGER NOT NULL, r REAL NOT NULL, metric TEXT NOT NULL, method TEXT NOT NULL, lag_samples INTEGER NOT NULL, p_value REAL NOT NULL, n_pairs INTEGER NOT NULL, at_p_floor INTEGER, UNIQUE (catalog_id_a, catalog_id_b, metric, method));
"""
conn = sqlite3.connect(':memory:'); conn.executescript(SCHEMA)
S = [f's{i:02d}' for i in range(20)]
conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (1,'kegg','K1')")
conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (2,'kegg','K2')")
for j in range(20):
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg',?,?,?)", (S[j], 'K1', float((j+1)**2)))
    conn.execute("INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg',?,?,?)", (S[j], 'K2', float((j+3)**2)))  # K2[t] = K1[t+2]: K2 leads K1 by 2
conn.commit()
res_high_first = _get_or_compute_correlation(conn, 2, 1, 'egc', 'raw_pearson', get_sample_order=lambda: S)
print('fresh compute, reference = high id (2): lag_samples =', res_high_first['lag_samples'], '(K1 lags K2 by 2 -> expected -2)')
row = conn.execute("SELECT catalog_id_a, catalog_id_b, lag_samples FROM correlations_cache").fetchone()
print('stored canonical row (low, high, lag):', row, '(expected (1, 2, +2))')
res_low = _get_or_compute_correlation(conn, 1, 2, 'egc', 'raw_pearson', get_sample_order=lambda: S)
print('cache hit, reference = low id (1): lag_samples =', res_low['lag_samples'], '(expected +2)')
