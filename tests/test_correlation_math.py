"""
Tests for the pure math/statistics pieces of correlation_sql.py that don't
touch the database: _bonferroni_correct, core_scoring, _spearman_at_lags.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.correlation_sql import _bonferroni_correct, core_scoring, _spearman_at_lags


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
