"""
fast_corr.py -- vectorised prototype of correlation_sql.score_pair applied to
one reference vector against a whole candidate matrix at once.

    score_family(ref, cand, method) -> dict of arrays, one entry per candidate:
        ok       bool   False where score_pair would return None
        r, p     float  (p is the Bonferroni/m_eff-corrected p, like score_pair)
        lag      int    best lag (CORRELATION_LAGS order, strict '>' on |r|)
        n_pairs  int    co-observed points at the best lag
        m_eff    float  Li & Ji effective number of lag tests
        guard    bool   candidate sits within eps of a discontinuous decision
                        (near-tie between lags, eigenvalue near an integer >= 2,
                        c0 near 0, df near 1) -- recompute with score_pair to be
                        certain the decision matches the scalar code.

Inputs: ref is a (n,) float array, cand an (m, n) float array; NaN (or any
value <= 0) means "missing" exactly as _transformed_pair treats None / <= 0.

The arithmetic mirrors score_pair step for step (same transform, the same
scipy.stats.pearsonr formula, the same compacted-series autocorrelation for
effective N, the same Bartlett/Li & Ji m_eff), but reductions are done row-wise
on zero-padded arrays, so results agree to floating-point rounding
(~1e-15 relative), not bit-for-bit. See findings-correlation-perf.md.
"""
import math
import numpy as np
from scipy import stats

CORRELATION_LAGS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]
MIN_PAIRS = 10


def rank_rows_nan(X: np.ndarray) -> np.ndarray:
    """scipy.stats.rankdata(method='average') applied to every row of X,
    ignoring NaN (NaN stays NaN; other entries get the ranks they would get
    in the compacted row). Exact: ranks are half-integers."""
    m, n = X.shape
    j = np.argsort(X, axis=1, kind="stable")          # NaN sorts last
    y = np.take_along_axis(X, j, axis=1)
    newgrp = np.ones((m, n), dtype=bool)
    newgrp[:, 1:] = y[:, 1:] != y[:, :-1]
    pos = np.arange(1, n + 1, dtype=np.int64)[None, :]
    start = np.maximum.accumulate(np.where(newgrp, pos, 0), axis=1)
    nxt = np.where(newgrp, pos, n + 1)
    rev = np.minimum.accumulate(nxt[:, ::-1], axis=1)[:, ::-1]
    nextstart = np.full((m, n), n + 1, dtype=np.int64)
    nextstart[:, :-1] = rev[:, 1:]
    end = nextstart - 1
    avg = start + (end - start) / 2.0                 # == ordinal_first + (count-1)/2, exact
    ranks = np.empty((m, n), dtype=float)
    np.put_along_axis(ranks, j, avg, axis=1)
    ranks[np.isnan(X)] = np.nan
    return ranks


def _masked_pearson(X, Y, M, k):
    """scipy.stats.pearsonr's formula, row-wise, on X/Y whose entries outside
    the boolean mask M are ignored. k = M.sum(1). Returns r (NaN where either
    row is constant on the mask, like pearsonr's ConstantInputWarning path)."""
    with np.errstate(invalid="ignore", divide="ignore"):
        Xz = np.where(M, X, 0.0)
        Yz = np.where(M, Y, 0.0)
        xmean = Xz.sum(1) / k
        ymean = Yz.sum(1) / k
        xm = np.where(M, X - xmean[:, None], 0.0)
        ym = np.where(M, Y - ymean[:, None], 0.0)
        xmax = np.abs(xm).max(1)
        ymax = np.abs(ym).max(1)
        normxm = xmax * np.sqrt(((xm / xmax[:, None]) ** 2).sum(1))
        normym = ymax * np.sqrt(((ym / ymax[:, None]) ** 2).sum(1))
        r = ((xm / normxm[:, None]) * (ym / normym[:, None])).sum(1)
        r = np.clip(r, -1.0, 1.0)
        # constant input -> NaN (scipy: all(x == x[0]) on the compacted row)
        xmin = np.where(M, X, np.inf).min(1); xmaxv = np.where(M, X, -np.inf).max(1)
        ymin = np.where(M, Y, np.inf).min(1); ymaxv = np.where(M, Y, -np.inf).max(1)
        const = (xmin == xmaxv) | (ymin == ymaxv)
        r = np.where(const, np.nan, r)
    return r, xm, ym


def _compact(D, M):
    """Move the masked-in entries of each row to the front (original order
    kept), zero elsewhere -- the gap-free series _effective_n works on."""
    idx = np.argsort(~M, axis=1, kind="stable")
    return np.take_along_axis(np.where(M, D, 0.0), idx, axis=1)


def _autocov(Dc, max_j):
    """c[:, j] = sum_i Dc[i] * Dc[i+j] for j = 0..max_j (zero padding makes
    the sum run over exactly the compacted length)."""
    m, n = Dc.shape
    c = np.empty((m, max_j + 1))
    c[:, 0] = np.einsum("ij,ij->i", Dc, Dc)
    for j in range(1, max_j + 1):
        c[:, j] = np.einsum("ij,ij->i", Dc[:, :-j], Dc[:, j:])
    return c


def _effective_n_rows(xm, ym, M, k):
    """_effective_n for every row; also returns the acf arrays (lags 1..J)
    with zeros beyond each row's own max_lag = k // 5, for m_eff reuse."""
    max_lag = k // 5
    J = int(max_lag.max()) if len(k) else 0
    Xc = _compact(xm, M)
    Yc = _compact(ym, M)
    cx = _autocov(Xc, J)
    cy = _autocov(Yc, J)
    with np.errstate(invalid="ignore", divide="ignore"):
        acfx = cx[:, 1:] / cx[:, :1]
        acfy = cy[:, 1:] / cy[:, :1]
    j = np.arange(1, J + 1)[None, :]
    inlag = j <= max_lag[:, None]
    acfx = np.where(inlag, acfx, 0.0)
    acfy = np.where(inlag, acfy, 0.0)
    kf = k.astype(float)
    w = np.where(inlag, (kf[:, None] - j) / kf[:, None], 0.0)
    s = ((w * acfx) * acfy).sum(1)
    with np.errstate(divide="ignore"):
        n_eff = np.where(s <= 0, kf, 1.0 / (1.0 / kf + (2.0 / kf) * s))
    n_eff = np.where(max_lag == 0, kf, n_eff)
    return n_eff, acfx, acfy


def _pvalue_rows(r, n_eff):
    df = n_eff - 2
    p = np.ones_like(r)
    with np.errstate(invalid="ignore", divide="ignore"):
        rr = r * r
        t = np.abs(r) * np.sqrt(df / (1 - rr))
        live = (df >= 1) & (rr < 1) & np.isfinite(r)
        if live.any():
            p[live] = 2 * stats.t.sf(t[live], df[live])
        p = np.where((df >= 1) & (rr >= 1), 0.0, p)
    return p, df


def _m_eff_rows(acfx, acfy, lags, k0_ok):
    """Li & Ji m_eff from lag-0 acfs; returns (m_eff, guard) where guard marks
    rows with an eigenvalue within 1e-9 of an integer >= 2 or c0 within 1e-9
    of zero (the discontinuities of this estimator)."""
    m, J = acfx.shape
    n_lags = len(lags)
    span = max(lags) - min(lags)
    L = 2 * J + 1
    tsx = np.concatenate([acfx[:, ::-1], np.ones((m, 1)), acfx], axis=1)
    tsy = np.concatenate([acfy[:, ::-1], np.ones((m, 1)), acfy], axis=1)
    shifts = np.arange(-span, span + 1)
    cross = np.empty((m, len(shifts)))
    for si, sh in enumerate(shifts):
        a0 = max(0, -sh); b0 = max(0, sh)
        ln = L - abs(sh)
        cross[:, si] = np.einsum("ij,ij->i", tsx[:, a0:a0 + ln], tsy[:, b0:b0 + ln])
    c0 = cross[:, span]
    lag_arr = np.asarray(lags)
    diff = lag_arr[:, None] - lag_arr[None, :]            # a - b
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = np.clip(cross[:, diff + span] / c0[:, None, None], -1.0, 1.0)
    bad = ~np.isfinite(corr).all(axis=(1, 2))
    corr[bad] = np.eye(n_lags)
    lam = np.abs(np.linalg.eigvalsh(corr))
    m_eff = ((lam >= 1) + (lam - np.floor(lam))).sum(1)
    m_eff = np.minimum(n_lags, np.maximum(1.0, m_eff))
    fallback = (~k0_ok) | (c0 <= 0) | bad
    m_eff = np.where(fallback, float(n_lags), m_eff)
    near_int = (np.abs(lam - np.round(lam)) < 1e-9) & (np.round(lam) >= 2)
    guard = (near_int.any(1) & ~fallback) | (np.abs(c0) < 1e-9)
    return m_eff, guard


def score_family(ref: np.ndarray, cand: np.ndarray, method: str, lags=CORRELATION_LAGS):
    ref = np.asarray(ref, dtype=float)
    cand = np.asarray(cand, dtype=float)
    m, n = cand.shape
    assert ref.shape == (n,)
    with np.errstate(invalid="ignore"):
        Vr = np.isfinite(ref) & (ref > 0)
        Vc = np.isfinite(cand) & (cand > 0)
    if method == "raw_pearson":
        R, C = ref, cand
    elif method == "log_pearson":
        with np.errstate(invalid="ignore", divide="ignore"):
            R = np.where(Vr, np.log(np.where(Vr, ref, 1.0)), np.nan)
            C = np.where(Vc, np.log(np.where(Vc, cand, 1.0)), np.nan)
    elif method == "spearman":
        R, C = ref, cand
    else:
        raise ValueError(method)

    best_abs = np.full(m, -1.0)
    best_r = np.full(m, np.nan)
    best_lag = np.zeros(m, dtype=int)
    best_p = np.full(m, np.nan)
    best_n = np.zeros(m, dtype=int)
    guard = np.zeros(m, dtype=bool)
    acf0 = None
    for lag in lags:
        if lag >= 0:
            A = R[lag:]; B = C[:, :n - lag] if lag > 0 else C
            Ma = Vr[lag:]; Mb = Vc[:, :n - lag] if lag > 0 else Vc
        else:
            A = R[:n + lag]; B = C[:, -lag:]
            Ma = Vr[:n + lag]; Mb = Vc[:, -lag:]
        if A.shape[0] < MIN_PAIRS:
            continue
        M = Ma[None, :] & Mb
        k = M.sum(1)
        ok = k >= MIN_PAIRS
        X = np.broadcast_to(A[None, :], B.shape)
        Y = B
        if method == "spearman":
            X = rank_rows_nan(np.where(M, X, np.nan))
            Y = rank_rows_nan(np.where(M, Y, np.nan))
        with np.errstate(invalid="ignore", divide="ignore"):
            kk = np.where(ok, k, 1)
            r, xm, ym = _masked_pearson(X, Y, M, kk)
            n_eff, acfx, acfy = _effective_n_rows(xm, ym, M, kk)
            p, df = _pvalue_rows(r, n_eff)
        valid = ok & np.isfinite(r)
        if lag == 0:
            acf0 = (acfx, acfy, ok)
        a = np.abs(r)
        better = valid & (a > best_abs)
        # near-tie guard: a lag whose |r| is within 1e-9 of the running best (either side)
        near = valid & (np.abs(a - best_abs) < 1e-9) & (best_abs >= 0)
        guard |= near
        best_abs = np.where(better, a, best_abs)
        best_r = np.where(better, r, best_r)
        best_lag = np.where(better, lag, best_lag)
        best_p = np.where(better, p, best_p)
        best_n = np.where(better, k, best_n)
        guard |= valid & better & (np.abs(df - 1) < 1e-9)
    found = best_abs >= 0
    # |r| within rounding of 1: the scalar path may land on exactly 1.0 and
    # short-circuit to p = 0.0 while the vector path gets 1 - 2e-16 and a
    # p of ~1e-300 (or vice versa). Let score_pair decide those.
    guard |= found & (best_abs > 1.0 - 1e-12)
    if acf0 is None:
        m_eff = np.full(m, float(len(lags))); g2 = np.zeros(m, bool)
    else:
        acfx, acfy, k0_ok = acf0
        # ptp == 0 on either compacted lag-0 series -> every lag counts; that
        # is exactly the rows where lag-0 r is NaN (constant input), which we
        # replicate from the acf arrays: a constant row has c0 == 0 -> acf NaN -> handled
        m_eff, g2 = _m_eff_rows(acfx, acfy, lags, k0_ok)
    guard |= g2 & found
    bonf = np.minimum(best_p * m_eff, 1.0)
    return {
        "ok": found, "r": best_r, "p": bonf, "lag": best_lag, "n_pairs": best_n,
        "m_eff": m_eff, "guard": guard & found,
    }


def score_family_hybrid(ref, cand, method, score_pair, lags=CORRELATION_LAGS):
    """score_family, then recompute guarded rows with the scalar score_pair
    so every discontinuous decision is taken by the reference code."""
    out = score_family(ref, cand, method, lags)
    idx = np.nonzero(out["guard"])[0]
    ref_l = [None if not (np.isfinite(v) and v > 0) else float(v) for v in ref]
    for i in idx:
        cand_l = [None if not (np.isfinite(v)) else float(v) for v in cand[i]]
        res = score_pair(ref_l, cand_l, method)
        if res is None:
            out["ok"][i] = False
        else:
            out["r"][i], out["p"][i], out["lag"][i], out["n_pairs"][i] = res[0], res[1], res[2], res[3]
    out["n_guarded"] = len(idx)
    return out
