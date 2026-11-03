"""Null / power Monte Carlo for the correlation finder's per-pair p-value.
Each pair: two series, scored exactly as the app does (score_pair), plus
reference quantities (lag-0 effective-N p, naive p, Pyper&Peterman with the
N/(N-j) ACF estimator, Li&Ji matrix diagnostics)."""
import os as _os, sys as _sys
_FASTAPI = _os.path.normpath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', '..', 'FastAPI'))
_sys.path.insert(0, _FASTAPI); _sys.path.insert(0, _os.path.join(_FASTAPI, 'scripts'))
import sys, math, random, json
import numpy as np
from scipy import stats
from multiprocessing import Pool
from api.correlation_sql import (score_pair, core_scoring, _spearman_at_lags, _effective_n,
    _lag_tests_m_eff, _autocorrelations, _effective_n_pvalue, _transformed_pair)
from api.config import CORRELATION_LAGS

N = 128; OFF = 30.0

def ar1(n, phi, rng):
    x = [rng.gauss(0, 1)]
    for _ in range(n - 1):
        x.append(phi * x[-1] + rng.gauss(0, 1))
    return np.array(x)

def make_pair(cond, rng):
    phi = 0.85
    if cond == 'phi95': phi = 0.95
    if cond == 'phi50': phi = 0.5
    if cond == 'white': phi = 0.0
    a = ar1(N, phi, rng) + OFF
    b = ar1(N, phi, rng) + OFF
    if cond == 'trend':
        tr = np.linspace(0, 8, N); a = a + tr; b = b + tr
    if cond == 'bloom':
        t = np.arange(N); bump = 8 * np.exp(-((t - 64) / 20.0) ** 2); a = a + bump; b = b + bump
    if cond.startswith('tp'):  # true positive: b = a + k*noise
        k = {'tp02': 0.2, 'tp10': 1.0, 'tp20': 2.0}[cond[:4]]
        b = a + k * ar1(N, phi, rng)
        if cond.endswith('_lag3'):   # candidate leads by 3 samples: b[t] = a[t+3]
            b = np.concatenate([b[3:], ar1(3, phi, rng) + OFF])
    a = list(a); b = list(b)
    if 'mcar' in cond:
        for i in range(N):
            if rng.random() < 0.2: a[i] = None
            if rng.random() < 0.2: b[i] = None
    if 'block' in cond:   # candidate detected only in a contiguous window of 80 samples
        start = rng.randrange(0, N - 80)
        b = [None if (i < start or i >= start + 80) else v for i, v in enumerate(b)]
    return a, b

def modified_effective_n(x, y):
    n = len(x); max_lag = n // 5; j = np.arange(1, max_lag + 1)
    ax = _autocorrelations(x, max_lag) * n / (n - j)
    ay = _autocorrelations(y, max_lag) * n / (n - j)
    s = np.sum((n - j) / n * ax * ay)
    if s <= 0: return float(n)
    return 1.0 / (1.0 / n + (2.0 / n) * s)

def lij_min_eig(ref, cand, method, lags=CORRELATION_LAGS):
    pair = _transformed_pair(ref, cand, method)
    x, y = np.asarray(pair[0], float), np.asarray(pair[1], float)
    max_lag = len(x) // 5
    acf_x = _autocorrelations(x, max_lag); acf_y = _autocorrelations(y, max_lag)
    two_sided_x = np.concatenate([acf_x[::-1], [1.0], acf_x])
    span = max(lags) - min(lags)
    padded_y = np.concatenate([np.zeros(span), acf_y[::-1], [1.0], acf_y, np.zeros(span)])
    def cross(shift):
        start = span + shift
        return float(two_sided_x @ padded_y[start:start + len(two_sided_x)])
    c0 = cross(0)
    corr = np.array([[cross(a - b) / c0 for b in lags] for a in lags])
    ev = np.linalg.eigvalsh(corr)
    clipped = np.clip(corr, -1, 1)
    ev2 = np.linalg.eigvalsh(clipped)
    return float(ev.min()), float(np.abs(corr).max()), float(sum((l >= 1) + (l - math.floor(l)) for l in ev2)), float(sum((l >= 1) + (l - math.floor(l)) for l in np.abs(ev2)))

def shifted(ref, cand, lag):
    n = len(ref)
    if lag >= 0:
        return ref[lag:], (cand[:n - lag] if lag > 0 else cand)
    return ref[:n + lag], cand[-lag:]

def one(args):
    cond, method, seed = args
    rng = random.Random(seed)
    a, b = make_pair(cond, rng)
    sp = score_pair(a, b, method)
    if sp is None: return None
    r, p, lag, n_best, _ = sp
    out = {'r': r, 'p_full': p, 'lag': lag, 'n_best': n_best}
    _br, _bl, best_p, _bn = _spearman_at_lags(a, b, CORRELATION_LAGS, method)
    out['p_best_raw'] = best_p
    out['p_best_bonf13'] = min(1.0, best_p * 13)
    cs = core_scoring(a, b, method)
    out['p_lag0'] = cs[1]; out['n_lag0'] = cs[2]
    pair = _transformed_pair(a, b, method)
    x, y = np.asarray(pair[0], float), np.asarray(pair[1], float)
    out['neff_lag0'] = _effective_n(x, y)
    out['neff_mod'] = modified_effective_n(x, y)
    r0, naive0 = stats.pearsonr(x, y)
    out['p_lag0_mod'] = _effective_n_pvalue(r0, out['neff_mod'])
    out['naive_lag0'] = float(naive0)
    sa, sb = shifted(a, b, lag)
    pb = _transformed_pair(sa, sb, method)
    xb, yb = np.asarray(pb[0], float), np.asarray(pb[1], float)
    out['naive_best'] = float(stats.pearsonr(xb, yb)[1])
    out['neff_best'] = _effective_n(xb, yb)
    out['m_eff'] = _lag_tests_m_eff(a, b, method)
    mn, mx, m_noabs, m_abs = lij_min_eig(a, b, method)
    out['min_eig'] = mn; out['max_abs_corr'] = mx; out['m_eff_noabs'] = m_noabs
    # "min p over lags" alternative selection (what Bonferroni-by-m_eff formally covers)
    ps = []
    for L in CORRELATION_LAGS:
        sa, sb = shifted(a, b, L)
        if len(sa) < 10: continue
        c = core_scoring(sa, sb, method)
        if c: ps.append(c[1])
    out['p_minp_bonf_meff'] = min(1.0, min(ps) * out['m_eff'])
    return out

def summarize(rows, label):
    rows = [r for r in rows if r is not None]
    n = len(rows)
    def rate(k): return sum(r[k] <= 0.05 for r in rows) / n
    def mean(k): return float(np.mean([r[k] for r in rows]))
    def med(k): return float(np.median([r[k] for r in rows]))
    fewer = [r for r in rows if r['n_best'] < r['n_lag0']]
    nonzero = [r for r in rows if r['lag'] != 0]
    s = {
        'label': label, 'n_pairs': n,
        'rate_app(best|r|,m_eff Bonf)': rate('p_full'),
        'rate_lag0_effN': rate('p_lag0'),
        'rate_lag0_effN_modifiedACF': rate('p_lag0_mod'),
        'rate_best_raw(no Bonf)': rate('p_best_raw'),
        'rate_best_Bonf13': rate('p_best_bonf13'),
        'rate_minp_Bonf_meff': rate('p_minp_bonf_meff'),
        'rate_naive_lag0': rate('naive_lag0'),
        'rate_naive_bestlag': rate('naive_best'),
        'neff_lag0_median': med('neff_lag0'), 'neff_lag0_mean': mean('neff_lag0'),
        'neff_mod_median': med('neff_mod'),
        'n_lag0_mean': mean('n_lag0'), 'n_best_mean': mean('n_best'),
        'm_eff_mean': mean('m_eff'), 'm_eff_median': med('m_eff'), 'm_eff_noabs_mean': mean('m_eff_noabs'),
        'min_eig_mean': mean('min_eig'), 'frac_neg_eig': sum(r['min_eig'] < -1e-9 for r in rows) / n,
        'frac_corr_gt1': sum(r['max_abs_corr'] > 1 + 1e-9 for r in rows) / n,
        'frac_best_lag_nonzero': len(nonzero) / n,
        'frac_best_has_fewer_n': len(fewer) / n,
        'rate_app_given_fewer_n': (sum(r['p_full'] <= 0.05 for r in fewer) / len(fewer)) if fewer else None,
        'rate_app_given_lag0': (sum(r['p_full'] <= 0.05 for r in rows if r['lag'] == 0) / max(1, n - len(nonzero))),
        'lag_hist': {str(L): sum(r['lag'] == L for r in rows) for L in sorted(CORRELATION_LAGS)},
        'mean_abs_r': float(np.mean([abs(r['r']) for r in rows])),
    }
    return s

if __name__ == '__main__':
    conds = [
        ('full', 'spearman', 6000), ('full', 'raw_pearson', 4000), ('full', 'log_pearson', 4000),
        ('mcar', 'spearman', 6000), ('mcar', 'raw_pearson', 3000),
        ('block', 'spearman', 4000),
        ('mcar_block', 'spearman', 3000),
        ('trend', 'spearman', 3000), ('bloom', 'spearman', 3000),
        ('phi95', 'spearman', 3000), ('phi50', 'spearman', 3000), ('white', 'spearman', 3000),
        ('tp02', 'spearman', 1000), ('tp10', 'spearman', 1000), ('tp20', 'spearman', 1000),
        ('tp10_mcar', 'spearman', 1000), ('tp10_lag3', 'spearman', 1000), ('tp10_lag3_mcar', 'spearman', 1000),
        ('tp20_mcar', 'spearman', 1000), ('tp20_lag3', 'spearman', 1000),
    ]
    results = []
    with Pool(11) as pool:
        for cond, method, reps in conds:
            rows = pool.map(one, [(cond, method, 100000 + i) for i in range(reps)], chunksize=50)
            s = summarize(rows, f'{cond}/{method}')
            results.append(s)
            print(json.dumps(s), flush=True)
    with open('./sim_null.json', 'w') as f:
        json.dump(results, f, indent=1)
