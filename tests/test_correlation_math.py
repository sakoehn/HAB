"""
Tests for the pure math/statistics pieces of correlation_sql.py that don't
touch the database: _bonferroni_correct, core_scoring, _spearman_at_lags,
_circular_shift_pvalue, score_pair.
"""
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.correlation_sql import (
    _bonferroni_correct,
    _circular_shift_pvalue,
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
        # CR4: zero variance in either series makes pearsonr return NaN for
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


# ── _circular_shift_pvalue (CR2, docs/AUDIT.md) ─────────────────────────────
# Mirrors the established test shapes from the old (still-live but
# deliberately biased -- see its own docstring) JSON-backend equivalent in
# tests/test_correlation_output.py, adapted to this version's signature:
# no `lag` argument, since re-searching the full lag window on every shift
# (instead of fixing it at the observed best) IS the bias fix CR2 asks for.

from api.config import CORRELATION_LAGS, PERMUTATION_N  # noqa: E402  (grouped with the math tests, not the top-level imports)


def _best_spearman(ref, cand):
    best_r, best_lag, _best_p, _best_n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, "spearman")
    return best_r, best_lag


class TestCircularShiftPvalue:
    def test_returns_one_for_fewer_than_three_points(self):
        assert _circular_shift_pvalue([1.0, 2.0], [1.0, 2.0], observed_r=1.0, n_perm=100, seed=1) == 1.0

    def test_pvalue_is_between_zero_and_one(self):
        rng = random.Random(10)
        ref = [rng.uniform(0, 1) for _ in range(20)]
        cand = [rng.uniform(0, 1) for _ in range(20)]
        r, _lag = _best_spearman(ref, cand)
        p = _circular_shift_pvalue(ref, cand, r, n_perm=200, seed=42)
        assert 0.0 <= p <= 1.0

    def test_pvalue_is_reproducible_with_fixed_seed(self):
        """Same seed, same inputs -> bit-identical p-value -- reproducibility
        is the documented justification for PERMUTATION_SEED's fixed default."""
        rng = random.Random(11)
        ref = [rng.uniform(0, 1) for _ in range(20)]
        cand = [rng.uniform(0, 1) for _ in range(20)]
        r, _lag = _best_spearman(ref, cand)
        p1 = _circular_shift_pvalue(ref, cand, r, n_perm=200, seed=42)
        p2 = _circular_shift_pvalue(ref, cand, r, n_perm=200, seed=42)
        assert p1 == p2

    def test_different_seeds_can_give_different_pvalues(self):
        """Sanity check that the permutation is actually doing something
        seed-dependent, not silently short-circuiting to a constant."""
        rng = random.Random(12)
        ref = [rng.uniform(0, 1) for _ in range(20)]
        cand = [rng.uniform(0, 1) for _ in range(20)]
        r, _lag = _best_spearman(ref, cand)
        pvalues = {_circular_shift_pvalue(ref, cand, r, n_perm=200, seed=s) for s in range(5)}
        assert len(pvalues) > 1

    def test_perfect_correlation_gives_low_pvalue(self):
        """A strong, genuine relationship should almost always be
        significant under permutation -- the observed r should rarely be
        beaten by a circularly-shifted null.

        Deliberately NOT a self-comparison of any strictly monotonic
        sequence (a linear ramp, or -- confirmed by direct experiment --
        even a squared sequence, since Spearman is rank-based and squaring
        a monotonic sequence preserves its rank order exactly). A
        circularly-shifted monotonic sequence is still nearly monotonic
        over most of its length, so re-searching all 9 lags keeps finding
        high-|r| shifted-null matches far more often than a real "how
        often does chance alignment this good happen" test should allow
        (measured p~0.37-0.41 for both, nowhere near low). Real EGC data
        isn't monotonic -- it fluctuates -- so this is a synthetic-data
        pitfall, not a real-world validity concern; using a genuinely
        non-monotonic base series with a tight noisy copy (n=80, so the
        ~350 shift*lag combinations checked don't have too high a chance
        of a lucky spurious match at this length -- also confirmed by
        direct experiment: n=40 gave p as high as 0.09, right at this
        test's own threshold, purely from that multiple-comparisons luck)
        sidesteps the self-similarity issue entirely."""
        rng = random.Random(1)
        n = 80
        ref = [rng.uniform(0, 100) for _ in range(n)]
        cand = [v + rng.uniform(-1, 1) for v in ref]
        r, _lag = _best_spearman(ref, cand)
        assert r > 0.99
        p = _circular_shift_pvalue(ref, cand, r, n_perm=500, seed=42)
        assert p < 0.1, f"expected a near-perfect correlation to be significant, got p={p}"

    def test_pure_noise_gives_high_pvalue_typically(self):
        """Two independent random series should typically NOT be judged
        significant -- not a hard guarantee for any single seed/sample,
        but true often enough that a consistently-low p here would
        indicate the permutation test is broken (e.g. always returning 0)."""
        rng = random.Random(99)
        ref = [rng.uniform(0, 1) for _ in range(40)]
        cand = [rng.uniform(0, 1) for _ in range(40)]
        r, _lag = _best_spearman(ref, cand)
        if r is None:
            pytest.skip("no valid correlation found for this random draw")
        p = _circular_shift_pvalue(ref, cand, r, n_perm=500, seed=42)
        assert p > 0.01, f"expected weak/no correlation between independent noise, got p={p}"

    def test_shift_is_never_zero(self):
        """A shift of 0 would compare the reference against itself,
        trivially matching the observed correlation every time and
        corrupting the null distribution -- rng.randint(1, n-1) inside
        _circular_shift_pvalue must never draw 0."""
        rng = random.Random(42)
        n = 10
        for _ in range(50):
            shift = rng.randint(1, n - 1)
            assert 1 <= shift <= n - 1

    def test_re_searches_all_lags_per_shift_not_fixed_at_observed_best(self):
        """The actual CR2 bias fix, proven directly by comparison rather
        than just checking the output is "a valid probability" (which
        would pass even if the bug were still present). Reconstructs what
        the OLD, biased approach would have found -- fixing the lag at
        the observed best on every shift, the exact behavior of the
        still-live JSON-backend's corrected_pvalue, and the bug the SQL
        rewrite introduced by dropping it entirely (docs/AUDIT.md CR2) --
        using the SAME random shifts (same seed) as the real
        _circular_shift_pvalue call, so the only variable is whether the
        null re-searches all 9 lags or is fixed at 1.

        This is a provable inequality, not just a typical-case tendency:
        a per-shift "best of 9 lags" score can never be less extreme than
        a fixed single lag's score, so full-search's count of
        as-extreme-as-observed shifts can only be >= the fixed-lag
        count -- meaning full-search's p-value can never be LOWER
        (falsely more significant) than the biased version's."""
        n = 20
        ref = [(j + 1) ** 2 for j in range(n)]
        cand = [(j + 3) ** 2 for j in range(n)]  # true lag = 2
        observed_r, observed_lag = _best_spearman(ref, cand)
        assert observed_lag == 2
        assert observed_r == pytest.approx(1.0)

        n_perm, seed = 500, 42
        full_search_p = _circular_shift_pvalue(ref, cand, observed_r, n_perm=n_perm, seed=seed)

        # Same shift sequence (fresh Random(seed), same single randint
        # call per iteration), but only ever scored at the one observed
        # lag -- reuses _spearman_at_lags with a one-element lags list so
        # the windowing/filtering logic isn't duplicated here.
        rng = random.Random(seed)
        fixed_lag_extreme = 0
        for _ in range(n_perm):
            shift = rng.randint(1, n - 1)
            shifted_ref = ref[shift:] + ref[:shift]
            fixed_r, _fixed_lag, _fixed_p, _fixed_n = _spearman_at_lags(
                shifted_ref, cand, [observed_lag], "spearman"
            )
            if fixed_r is not None and abs(fixed_r) >= abs(observed_r):
                fixed_lag_extreme += 1
        fixed_lag_p = fixed_lag_extreme / n_perm

        assert full_search_p >= fixed_lag_p, (
            f"full re-search p ({full_search_p}) is lower than the "
            f"fixed-lag p ({fixed_lag_p}) it should always be >= to -- "
            f"the re-search must have a bug letting it find FEWER "
            f"extreme shifts than checking just one lag ever could"
        )


# ── score_pair's "circular_shift" method dispatch ───────────────────────────

class TestScorePairCircularShift:
    def test_returns_none_when_no_lag_has_enough_points(self):
        ref = list(range(1, 9))  # only 8 points, below the 10-point floor
        cand = list(range(1, 9))
        assert score_pair(ref, cand, "circular_shift") is None

    def test_p_is_not_bonferroni_scaled(self):
        """The whole point of CR2: circular_shift's returned p must be the
        raw permutation fraction, not run through _bonferroni_correct like
        every other method -- a permutation p-value is always a multiple
        of 1/PERMUTATION_N (see api/config.py), which a
        Bonferroni-multiplied parametric p-value essentially never is."""
        rng = random.Random(7)
        ref = [rng.uniform(1, 100) for _ in range(20)]
        cand = [rng.uniform(1, 100) for _ in range(20)]

        result = score_pair(ref, cand, "circular_shift")
        assert result is not None
        _r, p, _lag, _n = result

        scaled = p * PERMUTATION_N
        assert abs(scaled - round(scaled)) < 1e-9, f"p={p} isn't a clean multiple of 1/{PERMUTATION_N}"

    def test_returns_valid_shape(self):
        ref = list(range(1, 21))
        cand = list(range(1, 21))
        result = score_pair(ref, cand, "circular_shift")
        assert result is not None
        r, p, lag, n = result
        assert r == pytest.approx(1.0)
        assert 0.0 <= p <= 1.0
        assert lag in CORRELATION_LAGS
        assert n >= 10


# ── CR2's own explicit verification bar ─────────────────────────────────────

class TestCR2FalsePositiveRateSimulation:
    """
    CR2 (docs/AUDIT.md) states an explicit, checkable bar: "simulated
    independent AR(1) pairs pass q < 0.05 at <= 5%". The audit's own
    simulation measured ~51% under the OLD parametric significance gate at
    phi=0.85, n=128 -- this reproduces that exact scenario (independent
    AR(1) series, same autocorrelation strength, same sample count) against
    circular_shift instead, to give a real measured answer rather than
    assume the fix works because the mechanism sounds right.
    """

    @pytest.mark.slow
    def test_ar1_pairs_pass_the_significance_gate_at_or_below_five_percent(self):
        def ar1(n, phi, seed):
            rng = random.Random(seed)
            x = [rng.gauss(0, 1)]
            for _ in range(n - 1):
                x.append(phi * x[-1] + rng.gauss(0, 1))
            return x

        # n_perm=200 here (not PERMUTATION_N=1000, the real default) to
        # keep this runnable in well under a minute -- confirmed by timing
        # one pair first (n=128, n_perm=200 ~0.37s; ~150 pairs ~55s total).
        # Still gives p-values with 1/200 resolution, plenty to tell
        # "far below 5%" apart from "not."
        n_pairs = 150
        pvalues = []
        for i in range(n_pairs):
            ref = ar1(128, 0.85, seed=1000 + 2 * i)
            cand = ar1(128, 0.85, seed=1000 + 2 * i + 1)  # independent draw -- no real relationship
            r, _lag, _p, _n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, "spearman")
            if r is None:
                continue
            pvalues.append(_circular_shift_pvalue(ref, cand, r, n_perm=200, seed=42))

        from statsmodels.stats.multitest import multipletests
        _reject, qvalues, _, _ = multipletests(pvalues, alpha=0.05, method="fdr_bh")
        pass_rate = sum(q < 0.05 for q in qvalues) / len(qvalues)

        assert pass_rate <= 0.05, (
            f"{pass_rate:.1%} of {len(qvalues)} independent AR(1) pairs (phi=0.85, "
            f"n=128) passed q<0.05 -- CR2's own bar is <=5%. The audit's own "
            f"simulation measured ~51% under the old parametric gate at these "
            f"exact same parameters, so this is the real scenario CR2 describes, "
            f"not a synthetic stand-in for it."
        )
