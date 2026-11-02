"""
Tests for the pure math/statistics pieces of correlation_sql.py that don't
touch the database: _bonferroni_correct, _effective_n, core_scoring,
_spearman_at_lags, score_pair.
"""
import math
import os
import random
import sys

import numpy as np
import pytest
from scipy import stats

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.config import CORRELATION_LAGS
from api.correlation_sql import (
    _bonferroni_correct,
    _effective_n,
    core_scoring,
    score_pair,
    _spearman_at_lags,
)


# ── _bonferroni_correct ─────────────────────────────────────────────────────

class TestBonferroniCorrect:
    def test_basic_multiplication(self):
        assert _bonferroni_correct(0.01, 9) == 0.09

    def test_caps_at_one(self):
        assert _bonferroni_correct(0.5, 9) == 1.0

    def test_n_tests_of_one_is_a_no_op(self):
        assert _bonferroni_correct(0.03, 1) == 0.03

    def test_exactly_one_at_the_boundary_stays_one(self):
        assert _bonferroni_correct(0.2, 5) == 1.0


# ── core_scoring ─────────────────────────────────────────────────────────────

class TestCoreScoring:
    def test_filters_none_and_nonpositive_values(self):
        # 10 clean pairs plus 3 that should get filtered (None, 0, negative)
        a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, None, 0, -5]
        b = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]

        result = core_scoring(a, b, "raw_pearson")

        assert result is not None
        r, p, n = result
        assert n == 10  # only the 10 clean pairs survive

    def test_returns_none_below_ten_valid_pairs(self):
        a = [1, 2, 3, 4, 5, 6, 7, 8, 9]  # 9 valid pairs, one short
        b = [1, 2, 3, 4, 5, 6, 7, 8, 9]

        assert core_scoring(a, b, "raw_pearson") is None

    def test_raw_pearson_perfect_correlation(self):
        a = list(range(1, 15))
        b = list(range(1, 15))

        r, p, n = core_scoring(a, b, "raw_pearson")

        assert r == 1.0
        assert p < 0.001

    def test_log_pearson_linearizes_power_law_relationship(self):
        # log_pearson takes log(a) AND log(b) -- so it's log(a) vs log(b)
        # that needs to be linear, which happens for a power-law
        # relationship (log(a**k) == k*log(a)), not an exponential one
        # (log(exp(a)) == a, which is not linear in log(a)).
        a = list(range(1, 15))
        b = [x ** 3 for x in a]

        r, p, n = core_scoring(a, b, "log_pearson")

        assert r > 0.999

    def test_spearman_catches_monotonic_nonlinear_relationship(self):
        a = list(range(1, 15))
        b = [x ** 3 for x in a]  # nonlinear but strictly monotonic

        r, p, n = core_scoring(a, b, "spearman")

        assert r == 1.0  # rank correlation is exact for any monotonic transform

    def test_returns_none_for_a_constant_candidate(self):
        # Zero variance in either series makes pearsonr return NaN for
        # both r and p. That NaN must never reach the caller as a "valid"
        # score -- unguarded, it eventually hits correlations_cache's
        # NOT NULL columns (sqlite3 silently binds NaN as SQL NULL) and
        # crashes the whole family request, not just this one candidate.
        a = [5.0] * 14  # constant -- zero variance
        b = list(range(1, 15))

        assert core_scoring(a, b, "raw_pearson") is None

    def test_unrecognized_method_raises(self):
        a = list(range(1, 15))
        b = list(range(1, 15))

        try:
            core_scoring(a, b, "not_a_real_method")
            assert False, "expected ValueError"
        except ValueError:
            pass


# ── _spearman_at_lags ────────────────────────────────────────────────────────

class TestSpearmanAtLags:
    def test_picks_the_correct_lag(self):
        # ref[j] = (j+1)**2 for j in 0..19; cand is ref shifted so that
        # cand[i] = (i+3)**2 == ref[i+2] -- true lag is 2, and only at
        # lag=2 do the compared windows become bit-identical (r == 1.0
        # exactly), since squares aren't a straight line so any other
        # offset can't also hit r == 1.0.
        ref = [(j + 1) ** 2 for j in range(20)]
        cand = [(i + 3) ** 2 for i in range(20)]

        best_r, best_lag, best_p, best_n = _spearman_at_lags(
            ref, cand, lags=[-2, -1, 0, 1, 2, 3], method="raw_pearson"
        )

        assert best_lag == 2
        assert best_r == 1.0

    def test_a_true_4_or_5_sample_lag_is_found_exactly_not_forced_onto_3_or_6(self):
        """CORRELATION_LAGS must include every offset up to ±6, so a real
        4- or 5-sample lead/lag lands in its exact bucket instead of being
        forced onto whichever of 3 or 6 is closer (a lag set skipping
        ±4/±5 finds lag=3 at r=0.99994 for this fixture, not the true
        lag=4 at r=1.0)."""
        n = 30
        ref = [(j + 1) ** 2 for j in range(n)]
        cand = [(i + 5) ** 2 for i in range(n)]  # true lag = 4 (cand[i] == ref[i+4])

        best_r, best_lag, _best_p, _best_n = _spearman_at_lags(
            ref, cand, CORRELATION_LAGS, method="raw_pearson"
        )

        assert best_lag == 4
        assert best_r == 1.0

    def test_skips_lags_that_trim_below_ten_points(self):
        ref = list(range(1, 13))   # length 12
        cand = list(range(1, 13))

        # lag=10 trims the compared window to length 2 -- must be skipped,
        # falling back to lag=0 which still has 12 valid points.
        best_r, best_lag, best_p, best_n = _spearman_at_lags(
            ref, cand, lags=[10, 0], method="raw_pearson"
        )

        assert best_lag == 0

    def test_returns_all_none_when_every_lag_is_unusable(self):
        ref = list(range(1, 13))
        cand = list(range(1, 13))

        best_r, best_lag, best_p, best_n = _spearman_at_lags(
            ref, cand, lags=[10, 11], method="raw_pearson"
        )

        assert (best_r, best_lag, best_p, best_n) == (None, None, None, None)


# ── Shared fixtures for the effective-N tests ───────────────────────────────

def _ar1(n, phi, rng):
    """A smooth random series: each value is phi * the previous one plus
    fresh noise. phi near 1 = very smooth (neighbours look alike)."""
    x = [rng.gauss(0, 1)]
    for _ in range(n - 1):
        x.append(phi * x[-1] + rng.gauss(0, 1))
    return np.array(x)


# Real EGC values are always positive and core_scoring drops anything <= 0,
# so simulated series are lifted well above zero -- otherwise roughly half
# of every AR(1) series would be silently filtered out before scoring.
_OFFSET = 30


# ── _effective_n ─────────────────────────────────────────────────────────────

class TestEffectiveN:
    def test_independent_noise_keeps_nearly_every_sample(self):
        # No autocorrelation -> each point is real, separate evidence.
        rng = random.Random(7)
        values = [
            _effective_n([rng.gauss(0, 1) for _ in range(128)], [rng.gauss(0, 1) for _ in range(128)])
            for _ in range(50)
        ]
        assert np.mean(values) > 0.9 * 128

    def test_smooth_series_count_far_fewer_than_n(self):
        # Two independent AR(1) series at phi=0.8: theory says
        # N*(1-phi^2)/(1+phi^2) ~= 28 of 128. The sample autocorrelation
        # is biased low at n=128 (measured mean ~36), so the band is wide
        # but still far below 128.
        rng = random.Random(8)
        values = [_effective_n(_ar1(128, 0.8, rng), _ar1(128, 0.8, rng)) for _ in range(100)]
        assert 20 < np.mean(values) < 50

    def test_never_exceeds_the_real_number_of_points(self):
        # One series alternating up/down, the other smooth: their
        # lag-1 autocorrelations have opposite signs, which pushes the
        # formula's raw estimate ABOVE n. More evidence than data points
        # isn't possible, so it must be capped at n.
        n = 40
        zigzag = [1 if i % 2 else 3 for i in range(n)]
        smooth = list(range(1, n + 1))
        assert _effective_n(zigzag, smooth) == n

    def test_is_symmetric(self):
        rng = random.Random(9)
        a, b = _ar1(60, 0.7, rng), _ar1(60, 0.3, rng)
        assert _effective_n(a, b) == pytest.approx(_effective_n(b, a))


# ── core_scoring's effective-N p-value ───────────────────────────────────────

def _t_test_p(r, n_eff):
    """The textbook two-sided p-value for a correlation r, given n_eff
    independent observations."""
    df = n_eff - 2
    t = abs(r) * math.sqrt(df / (1 - r * r))
    return 2 * stats.t.sf(t, df)


class TestCoreScoringEffectiveNPvalue:
    def _smooth_pair(self, seed):
        rng = random.Random(seed)
        return list(_ar1(128, 0.85, rng) + _OFFSET), list(_ar1(128, 0.85, rng) + _OFFSET)

    @pytest.mark.parametrize("method", ["raw_pearson", "log_pearson", "spearman"])
    def test_smooth_series_get_a_larger_p_than_the_naive_test(self, method):
        # The naive p-value treats all 128 points as independent; the
        # effective-N one must be less confident for smooth data.
        a, b = self._smooth_pair(seed=11)
        r, p, n = core_scoring(a, b, method)
        naive_p = _t_test_p(r, n)
        assert p > naive_p

    @pytest.mark.parametrize("method, transform", [
        ("raw_pearson", lambda v: list(v)),
        ("log_pearson", lambda v: [math.log(x) for x in v]),
        ("spearman", lambda v: list(stats.rankdata(v))),
    ])
    def test_effective_n_is_measured_on_the_values_actually_correlated(self, method, transform):
        # Each coefficient correlates a different version of the data
        # (raw values, logs, ranks); the autocorrelation that sets n_eff
        # must come from that same version.
        a, b = self._smooth_pair(seed=12)
        r, p, n = core_scoring(a, b, method)
        expected = _t_test_p(r, _effective_n(transform(a), transform(b)))
        assert p == pytest.approx(expected)

    def test_effective_n_is_measured_after_gaps_are_dropped(self):
        # Gaps (None / <= 0) are removed first, and n_eff is measured on
        # the remaining co-observed points.
        a, b = self._smooth_pair(seed=13)
        gappy_a = list(a)
        for i in range(0, 128, 5):
            gappy_a[i] = None
        kept_a = [x for i, x in enumerate(a) if i % 5]
        kept_b = [x for i, x in enumerate(b) if i % 5]
        r, p, n = core_scoring(gappy_a, b, "raw_pearson")
        assert n == len(kept_a)
        assert p == pytest.approx(_t_test_p(r, _effective_n(kept_a, kept_b)))

    def test_perfect_correlation_still_has_p_zero(self):
        # r = 1 exactly would divide by zero in the t formula.
        a = list(range(1, 15))
        r, p, n = core_scoring(a, list(a), "raw_pearson")
        assert r == 1.0
        assert p == 0.0


# ── score_pair ───────────────────────────────────────────────────────────────

class TestScorePair:
    def test_p_is_bonferroni_corrected_across_every_lag(self):
        rng = random.Random(21)
        ref = list(_ar1(128, 0.5, rng) + _OFFSET)
        cand = list(_ar1(128, 0.5, rng) + _OFFSET)
        r, p, lag, n, _at_p_floor = score_pair(ref, cand, "spearman")
        _r, _lag, best_p, _n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, "spearman")
        assert p == pytest.approx(min(1.0, best_p * len(CORRELATION_LAGS)))

    def test_at_p_floor_is_always_none(self):
        # at_p_floor only ever described the removed permutation test.
        ref = list(range(1, 21))
        result = score_pair(ref, list(ref), "spearman")
        assert result is not None
        assert result[4] is None

    def test_circular_shift_is_no_longer_a_method(self):
        ref = list(range(1, 21))
        with pytest.raises(ValueError):
            score_pair(ref, list(ref), "circular_shift")


# ── False-positive rate / power simulation ──────────────────────────────────

class TestEffectiveNFalsePositiveRateSimulation:
    """
    Unrelated smooth series must come out significant (Bonferroni p <= 0.05)
    no more than 5% of the time. The naive p-value passes far more of
    exactly these pairs, because it treats neighbouring timepoints as
    independent evidence. Measured with this implementation on 2,000 pairs
    per case: 1.3-1.7% stationary, 2.2-3.1% both-trending, for every
    coefficient. 500 pairs keeps the sampling wobble (~0.8%) well inside
    the gap between those rates and the 5% bar.
    """

    N_PAIRS = 500

    def _false_positive_rate(self, method, make_pair):
        rng = random.Random(1000)
        hits = 0
        for _ in range(self.N_PAIRS):
            ref, cand = make_pair(rng)
            result = score_pair(list(ref), list(cand), method)
            assert result is not None
            hits += result[1] <= 0.05
        return hits / self.N_PAIRS

    @pytest.mark.slow
    @pytest.mark.parametrize("method", ["raw_pearson", "log_pearson", "spearman"])
    def test_unrelated_smooth_series(self, method):
        rate = self._false_positive_rate(
            method, lambda rng: (_ar1(128, 0.85, rng) + _OFFSET, _ar1(128, 0.85, rng) + _OFFSET),
        )
        assert rate <= 0.05, f"{rate:.1%} of unrelated AR(1) pairs were significant ({method})"

    @pytest.mark.slow
    @pytest.mark.parametrize("method", ["raw_pearson", "log_pearson", "spearman"])
    def test_unrelated_series_that_both_trend_upward(self, method):
        # The bloom case: two genes that both rise over the sampling window
        # for unrelated reasons.
        trend = np.linspace(0, 8, 128)
        rate = self._false_positive_rate(
            method,
            lambda rng: (_ar1(128, 0.85, rng) + _OFFSET + trend, _ar1(128, 0.85, rng) + _OFFSET + trend),
        )
        assert rate <= 0.05, f"{rate:.1%} of unrelated trending pairs were significant ({method})"

    @pytest.mark.slow
    def test_genuinely_related_series_are_still_detected(self):
        # cand = ref + small independent smooth noise -> r ~ 0.9. A test
        # that rejects everything would pass the two tests above while
        # being useless, so power is checked too.
        rng = random.Random(3000)
        hits = 0
        for _ in range(100):
            ref = _ar1(128, 0.85, rng)
            cand = ref + 0.2 * _ar1(128, 0.85, rng)
            result = score_pair(list(ref + _OFFSET), list(cand + _OFFSET), "spearman")
            hits += result[1] <= 0.05
        assert hits / 100 >= 0.9
