"""Option (d): keep the per-candidate loop but strip the overhead -- numpy
masks instead of the Python filter loop, a direct pearson formula instead of
scipy.stats.pearsonr, one batched t.sf per candidate, lag-0 acf reused for
m_eff. Same arithmetic as score_pair otherwise. Used only to QUANTIFY how far
a non-vectorised cleanup gets; not proposed as the final design."""
import math, numpy as np
from scipy import stats
LAGS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]

def _acf(d, max_lag):
    full = np.correlate(d, d, "full")[len(d) - 1:len(d) + max_lag]
    return full[1:] / full[0]

def _pearson(x, y):
    xm = x - x.mean(); ym = y - y.mean()
    xmax = np.abs(xm).max(); ymax = np.abs(ym).max()
    if xmax == 0 or ymax == 0: return np.nan
    normxm = xmax * np.sqrt(((xm / xmax) ** 2).sum()); normym = ymax * np.sqrt(((ym / ymax) ** 2).sum())
    return min(1.0, max(-1.0, float(((xm / normxm) * (ym / normym)).sum())))

def score_pair_lean(ref: np.ndarray, cand: np.ndarray, method: str):
    n = len(ref)
    vr = np.isfinite(ref) & (ref > 0); vc = np.isfinite(cand) & (cand > 0)
    if method == "log_pearson":
        R = np.where(vr, np.log(np.where(vr, ref, 1.0)), np.nan); C = np.where(vc, np.log(np.where(vc, cand, 1.0)), np.nan)
    else:
        R, C = ref, cand
    best = None; ts = []; dfs = []; cand_lags = []; acf0 = None
    for lag in LAGS:
        if lag >= 0: a, b, ma, mb = R[lag:], C[:n - lag] if lag else C, vr[lag:], vc[:n - lag] if lag else vc
        else: a, b, ma, mb = R[:n + lag], C[-lag:], vr[:n + lag], vc[-lag:]
        m = ma & mb; k = int(m.sum())
        if k < 10: continue
        x = a[m]; y = b[m]
        if method == "spearman": x = stats.rankdata(x); y = stats.rankdata(y)
        r = _pearson(x, y)
        if math.isnan(r): continue
        max_lag = k // 5
        dx = x - x.mean(); dy = y - y.mean()
        ax = _acf(dx, max_lag); ay = _acf(dy, max_lag)
        if lag == 0: acf0 = (ax, ay, x, y)
        j = np.arange(1, max_lag + 1)
        s = np.sum((k - j) / k * ax * ay)
        n_eff = float(k) if s <= 0 else 1.0 / (1.0 / k + (2.0 / k) * s)
        cand_lags.append((r, lag, k, n_eff))
    if not cand_lags: return None
    # batched p-values
    rs = np.array([c[0] for c in cand_lags]); ne = np.array([c[3] for c in cand_lags]); df = ne - 2
    with np.errstate(invalid="ignore", divide="ignore"):
        t = np.abs(rs) * np.sqrt(df / (1 - rs * rs))
    p = np.where(df < 1, 1.0, np.where(rs * rs >= 1, 0.0, 2 * stats.t.sf(t, df)))
    i = int(np.argmax(np.abs(rs) > np.maximum.accumulate(np.abs(rs)) - 0) ) if False else None
    # first strictly-greater wins, in LAGS order
    bi = 0
    for q in range(1, len(rs)):
        if abs(rs[q]) > abs(rs[bi]): bi = q
    # m_eff
    if acf0 is None: m_eff = 13.0
    else:
        ax, ay, x, y = acf0
        if np.ptp(x) == 0 or np.ptp(y) == 0: m_eff = 13.0
        else:
            tsx = np.concatenate([ax[::-1], [1.0], ax]); span = 12
            py = np.concatenate([np.zeros(span), ay[::-1], [1.0], ay, np.zeros(span)])
            cross = lambda sh: float(tsx @ py[span + sh: span + sh + len(tsx)])
            c0 = cross(0)
            if c0 <= 0: m_eff = 13.0
            else:
                corr = np.array([[np.clip(cross(a - b) / c0, -1, 1) for b in LAGS] for a in LAGS])
                lam = np.abs(np.linalg.eigvalsh(corr)); m_eff = float(min(13, max(1.0, sum((l >= 1) + (l - math.floor(l)) for l in lam))))
    return cand_lags[bi][0], min(p[bi] * m_eff, 1.0), cand_lags[bi][1], cand_lags[bi][2], None

if __name__ == "__main__":
    import time, warnings
    from bench_common import *
    warnings.simplefilter("ignore")
    conn = correlation_sql._connect(); order = correlation_loaders.load_sample_order(conn)
    ref_id, cands = ref_and_candidates(conn, "cog", "COG0000", "kegg")
    ref_l = correlation_loaders.load_vector(conn, "cog", "COG0000", order, "egc")
    to_arr = lambda v: np.array([np.nan if x is None else x for x in v], dtype=float)
    ref = to_arr(ref_l)
    rng = np.random.default_rng(7); pick = rng.choice(len(cands), size=2500, replace=False)
    vecs = [correlation_loaders.load_vector(conn, "kegg", cands[i]["annotation_id"], order, "egc") for i in pick]
    for method in ("raw_pearson", "log_pearson", "spearman"):
        t0 = time.perf_counter(); lean = [score_pair_lean(ref, to_arr(v), method) for v in vecs]; tl = time.perf_counter() - t0
        t0 = time.perf_counter(); ex = [correlation_sql.score_pair(ref_l, v, method) for v in vecs[:500]]; te = (time.perf_counter() - t0) * 5
        bad = 0
        for a, b in zip(lean[:500], ex):
            if (a is None) != (b is None): bad += 1; continue
            if a is None: continue
            if abs(a[0]-b[0]) > 1e-12 or a[2] != b[2] or a[3] != b[3] or (abs(a[1]-b[1]) > 1e-12 and abs(a[1]-b[1])/max(b[1],1e-300) > 1e-9): bad += 1
        print(f"[{method:12s}] lean scalar {1000*tl/2500:.3f} ms/candidate (13k => {tl/2500*13000:.1f}s) vs score_pair {1000*te/2500:.3f} ms/candidate; mismatches on 500: {bad}")
