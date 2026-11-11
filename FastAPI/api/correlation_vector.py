"""
Scores one reference against a whole table of candidates at once.

score_pair (correlation_sql.py) is the reference implementation and scores
one pair at a time: about 50 small scipy calls per candidate, which is
where a cold family's minute goes. This module runs the same steps on a
(candidates x samples) table with numpy, one call per step per lag.

score_pair drops the timepoints where either value is missing. A table
can't do that, because every candidate is missing different timepoints and
the rows would end up different lengths. Instead each step carries a
True/False mask of the timepoints that count, and fills the others with 0
before summing, so they add nothing.

Results match score_pair to floating-point rounding (about 1e-15), not
bit for bit, because sums are taken in a different order. Where rounding
could flip a yes/no decision (two lags almost tied, r within rounding of
1, an m_eff eigenvalue on a whole number), the row is flagged and
score_family_checked re-scores it with score_pair itself.

tests/test_correlation_vector.py holds the two versions to the same
answers; a change to score_pair's math has to be made here as well.
"""
import numpy as np
from scipy import stats

from .config import CORRELATION_LAGS

# Same floor as _transformed_pair: fewer shared points than this at a lag
# and the lag is skipped.
MIN_SHARED_POINTS = 10

# How close to a decision boundary counts as "too close to call".
_TIE_EPS = 1e-9
_R_ONE_EPS = 1e-12


def rank_rows(table: np.ndarray) -> np.ndarray:
    """stats.rankdata (ties get the average rank) for every row, ignoring
    NaN: NaN stays NaN, every other value gets the rank it would have in
    the row with the NaNs removed. Ranks are whole or half numbers, so
    this is exact."""
    m, n = table.shape
    order = np.argsort(table, axis=1, kind="stable")    # NaN sorts last
    sorted_vals = np.take_along_axis(table, order, axis=1)
    starts_group = np.ones((m, n), dtype=bool)
    starts_group[:, 1:] = sorted_vals[:, 1:] != sorted_vals[:, :-1]
    position = np.arange(1, n + 1)[None, :]
    first = np.maximum.accumulate(np.where(starts_group, position, 0), axis=1)
    next_start = np.where(starts_group, position, n + 1)
    next_start = np.minimum.accumulate(next_start[:, ::-1], axis=1)[:, ::-1]
    last = np.full((m, n), n, dtype=np.int64)
    last[:, :-1] = next_start[:, 1:] - 1
    ranks = np.empty((m, n))
    np.put_along_axis(ranks, order, (first + last) / 2.0, axis=1)
    ranks[np.isnan(table)] = np.nan
    return ranks


def _masked_pearson(x, y, mask, k):
    """stats.pearsonr's own formula, per row, on the masked-in entries
    only. Also returns the centred rows, which effective N reuses. r is
    NaN where either row is constant on its mask, as pearsonr does."""
    xz = np.where(mask, x, 0.0)
    yz = np.where(mask, y, 0.0)
    x_centred = np.where(mask, x - (xz.sum(1) / k)[:, None], 0.0)
    y_centred = np.where(mask, y - (yz.sum(1) / k)[:, None], 0.0)
    # pearsonr scales by the largest value before squaring, to avoid
    # overflow; doing the same keeps the rounding the same.
    x_max = np.abs(x_centred).max(1)
    y_max = np.abs(y_centred).max(1)
    x_norm = x_max * np.sqrt(((x_centred / x_max[:, None]) ** 2).sum(1))
    y_norm = y_max * np.sqrt(((y_centred / y_max[:, None]) ** 2).sum(1))
    r = ((x_centred / x_norm[:, None]) * (y_centred / y_norm[:, None])).sum(1)
    r = np.clip(r, -1.0, 1.0)
    x_constant = np.where(mask, x, np.inf).min(1) == np.where(mask, x, -np.inf).max(1)
    y_constant = np.where(mask, y, np.inf).min(1) == np.where(mask, y, -np.inf).max(1)
    r = np.where(x_constant | y_constant, np.nan, r)
    return r, x_centred, y_centred


def _move_kept_to_front(values, mask):
    """Each row's masked-in values slid to the front in their original
    order, zeros after: the gap-free series score_pair measures
    autocorrelation on."""
    order = np.argsort(~mask, axis=1, kind="stable")
    return np.take_along_axis(np.where(mask, values, 0.0), order, axis=1)


def _autocovariance(rows, max_step):
    """out[:, j] = sum over i of rows[i] * rows[i + j], for j = 0..max_step.
    The zero padding after each row's own values keeps every sum to that
    row's own length."""
    out = np.empty((rows.shape[0], max_step + 1))
    out[:, 0] = np.einsum("ij,ij->i", rows, rows)
    for j in range(1, max_step + 1):
        out[:, j] = np.einsum("ij,ij->i", rows[:, :-j], rows[:, j:])
    return out


def _effective_n_rows(x_centred, y_centred, mask, k):
    """_effective_n for every row. Also returns both autocorrelation
    tables (steps 1..J), zero past each row's own window of k // 5, for
    m_eff to reuse."""
    window = k // 5
    widest = int(window.max()) if len(k) else 0
    cov_x = _autocovariance(_move_kept_to_front(x_centred, mask), widest)
    cov_y = _autocovariance(_move_kept_to_front(y_centred, mask), widest)
    with np.errstate(invalid="ignore", divide="ignore"):
        acf_x = cov_x[:, 1:] / cov_x[:, :1]
        acf_y = cov_y[:, 1:] / cov_y[:, :1]
    step = np.arange(1, widest + 1)[None, :]
    in_window = step <= window[:, None]
    acf_x = np.where(in_window, acf_x, 0.0)
    acf_y = np.where(in_window, acf_y, 0.0)
    kf = k.astype(float)
    weight = np.where(in_window, (kf[:, None] - step) / kf[:, None], 0.0)
    s = (weight * acf_x * acf_y).sum(1)
    with np.errstate(divide="ignore"):
        n_eff = np.where(s <= 0, kf, 1.0 / (1.0 / kf + (2.0 / kf) * s))
    n_eff = np.where(window == 0, kf, n_eff)
    return n_eff, acf_x, acf_y


def _pvalue_rows(r, n_eff):
    """_effective_n_pvalue for every row."""
    df = n_eff - 2
    p = np.ones_like(r)
    with np.errstate(invalid="ignore", divide="ignore"):
        r_squared = r * r
        t = np.abs(r) * np.sqrt(df / (1 - r_squared))
        testable = (df >= 1) & (r_squared < 1) & np.isfinite(r)
        if testable.any():
            p[testable] = 2 * stats.t.sf(t[testable], df[testable])
    p = np.where((df >= 1) & (r_squared >= 1), 0.0, p)
    return p, df


def _m_eff_rows(acf_x, acf_y, lag0_ok, lags):
    """_lag_tests_m_eff for every row, from the lag-0 autocorrelations.
    Returns (m_eff, recheck): recheck marks rows with an eigenvalue within
    rounding of a whole number >= 2, where m_eff's round-down could tip
    either way, or with c0 within rounding of 0."""
    m, widest = acf_x.shape
    n_lags = len(lags)
    span = max(lags) - min(lags)
    # Two-sided autocorrelation: index widest + h holds acf(h).
    two_sided_x = np.concatenate([acf_x[:, ::-1], np.ones((m, 1)), acf_x], axis=1)
    two_sided_y = np.concatenate([acf_y[:, ::-1], np.ones((m, 1)), acf_y], axis=1)
    length = two_sided_x.shape[1]
    # Zero padding on both sides so y can be shifted by any lag difference
    # even when the window is shorter than the lag span, the same as
    # padded_y in _lag_tests_m_eff.
    padded_y = np.concatenate([np.zeros((m, span)), two_sided_y, np.zeros((m, span))], axis=1)
    shifts = np.arange(-span, span + 1)
    cross = np.empty((m, len(shifts)))
    for i, shift in enumerate(shifts):
        start = span + shift
        cross[:, i] = np.einsum("ij,ij->i", two_sided_x, padded_y[:, start:start + length])
    c0 = cross[:, span]
    lag_array = np.asarray(lags)
    difference = lag_array[:, None] - lag_array[None, :]
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = np.clip(cross[:, difference + span] / c0[:, None, None], -1.0, 1.0)
    unusable = ~np.isfinite(corr).all(axis=(1, 2))
    corr[unusable] = np.eye(n_lags)
    eigenvalues = np.abs(np.linalg.eigvalsh(corr))
    m_eff = ((eigenvalues >= 1) + (eigenvalues - np.floor(eigenvalues))).sum(1)
    m_eff = np.minimum(n_lags, np.maximum(1.0, m_eff))
    every_lag = ~lag0_ok | (c0 <= 0) | unusable
    m_eff = np.where(every_lag, float(n_lags), m_eff)
    near_whole = (np.abs(eigenvalues - np.round(eigenvalues)) < _TIE_EPS) & (np.round(eigenvalues) >= 2)
    recheck = (near_whole.any(1) & ~every_lag) | (np.abs(c0) < _TIE_EPS)
    return m_eff, recheck


def score_family(ref, table, method: str, lags=CORRELATION_LAGS) -> dict:
    """score_pair for every row of table against ref, without the
    score_pair fallback (use score_family_checked for real results).

    ref is (samples,), table is (candidates x samples); NaN or a value
    <= 0 means missing, as in _transformed_pair. Returns arrays, one entry
    per candidate:
        ok          False where score_pair would return None
        r, p, lag, n_pairs, m_eff   as score_pair (p already m_eff-corrected)
        max_shared  most shared points at any lag
        reason      None if scored, else "too_few_points" / "no_variation"
        recheck     too close to a decision boundary to trust rounding
    """
    ref = np.asarray(ref, dtype=float)
    table = np.asarray(table, dtype=float).reshape(-1, ref.shape[0])
    m, n = table.shape
    with np.errstate(invalid="ignore"):
        ref_present = np.isfinite(ref) & (ref > 0)
        table_present = np.isfinite(table) & (table > 0)
    if method == "log_pearson":
        with np.errstate(invalid="ignore", divide="ignore"):
            ref_values = np.where(ref_present, np.log(np.where(ref_present, ref, 1.0)), np.nan)
            table_values = np.where(table_present, np.log(np.where(table_present, table, 1.0)), np.nan)
    elif method in ("raw_pearson", "spearman"):
        ref_values, table_values = ref, table
    else:
        raise ValueError(f"{method} not found.")

    best_abs = np.full(m, -1.0)
    best_r = np.full(m, np.nan)
    best_lag = np.zeros(m, dtype=int)
    best_p = np.full(m, np.nan)
    best_n = np.zeros(m, dtype=int)
    max_shared = np.zeros(m, dtype=int)
    recheck = np.zeros(m, dtype=bool)
    lag0 = None
    for lag in lags:
        # lag > 0 pairs ref[t + lag] with candidate[t], as _spearman_at_lags.
        if lag >= 0:
            a, a_present = ref_values[lag:], ref_present[lag:]
            b, b_present = table_values[:, :n - lag], table_present[:, :n - lag]
        else:
            a, a_present = ref_values[:n + lag], ref_present[:n + lag]
            b, b_present = table_values[:, -lag:], table_present[:, -lag:]
        mask = a_present[None, :] & b_present
        k = mask.sum(1)
        max_shared = np.maximum(max_shared, k)
        if a.shape[0] < MIN_SHARED_POINTS:
            continue
        enough = k >= MIN_SHARED_POINTS
        x = np.broadcast_to(a[None, :], b.shape)
        y = b
        if method == "spearman":
            x = rank_rows(np.where(mask, x, np.nan))
            y = rank_rows(np.where(mask, y, np.nan))
        safe_k = np.where(enough, k, 1)
        with np.errstate(invalid="ignore", divide="ignore"):
            r, x_centred, y_centred = _masked_pearson(x, y, mask, safe_k)
            n_eff, acf_x, acf_y = _effective_n_rows(x_centred, y_centred, mask, safe_k)
            p, df = _pvalue_rows(r, n_eff)
        scored = enough & np.isfinite(r)
        if lag == 0:
            lag0 = (acf_x, acf_y, enough)
        abs_r = np.abs(r)
        # Strictly greater, in lag order, so ties go to the earlier lag as
        # in _spearman_at_lags; a near-tie is left to score_pair.
        recheck |= scored & (best_abs >= 0) & (np.abs(abs_r - best_abs) < _TIE_EPS)
        better = scored & (abs_r > best_abs)
        best_abs = np.where(better, abs_r, best_abs)
        best_r = np.where(better, r, best_r)
        best_lag = np.where(better, lag, best_lag)
        best_p = np.where(better, p, best_p)
        best_n = np.where(better, k, best_n)
        recheck |= better & (np.abs(df - 1) < _TIE_EPS)

    ok = best_abs >= 0
    # score_pair can land on r == 1.0 exactly and return p = 0 where this
    # arithmetic gets 1 - 2e-16 and a tiny non-zero p, or the reverse.
    recheck |= ok & (best_abs > 1.0 - _R_ONE_EPS)
    if lag0 is None:
        m_eff = np.full(m, float(len(lags)))
    else:
        m_eff, meff_recheck = _m_eff_rows(*lag0, lags)
        recheck |= meff_recheck
    reason = np.where(ok, None, np.where(max_shared < MIN_SHARED_POINTS, "too_few_points", "no_variation"))
    return {
        "ok": ok,
        "r": best_r,
        "p": np.minimum(best_p * m_eff, 1.0),
        "lag": best_lag,
        "n_pairs": best_n,
        "m_eff": m_eff,
        "max_shared": max_shared,
        "reason": reason.astype(object),
        "recheck": recheck & ok,
    }


def score_family_checked(ref, table, method: str, lags=CORRELATION_LAGS) -> dict:
    """score_family, then every row flagged for a recheck is re-scored with
    score_pair, so each too-close-to-call decision is score_pair's own."""
    from .correlation_sql import score_pair   # here, not at the top: correlation_sql imports this module

    result = score_family(ref, table, method, lags)
    table = np.asarray(table, dtype=float).reshape(-1, np.asarray(ref).shape[0])
    ref_list = [float(v) if np.isfinite(v) else None for v in np.asarray(ref, dtype=float)]
    rechecked = np.nonzero(result["recheck"])[0]
    for i in rechecked:
        exact = score_pair(ref_list, [float(v) if np.isfinite(v) else None for v in table[i]], method)
        if exact is None:
            result["ok"][i] = False
            result["reason"][i] = "too_few_points" if result["max_shared"][i] < MIN_SHARED_POINTS else "no_variation"
        else:
            result["r"][i], result["p"][i], result["lag"][i], result["n_pairs"][i] = exact[:4]
    result["rechecked"] = len(rechecked)
    return result
