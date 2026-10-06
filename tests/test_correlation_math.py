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


# ── _circular_shift_pvalue (CR2/CR8, docs/AUDIT-2026-09-22.md) ──────────────
# CR8 replaced random sampling (n_perm draws, a seed) with exhaustive
# enumeration of the valid shift range -- there is no longer a sample
# count or seed to pass in, and the function is fully deterministic.

from api.config import CORRELATION_LAGS  # noqa: E402  (grouped with the math tests, not the top-level imports)

MAX_LAG = max(abs(lag) for lag in CORRELATION_LAGS)  # 6, with the real CORRELATION_LAGS


def _best_spearman(ref, cand):
    best_r, best_lag, _best_p, _best_n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, "spearman")
    return best_r, best_lag


def _valid_shift_count(n):
    """Mirrors _circular_shift_pvalue's own lo/hi math, so tests can predict
    the exact evaluable count (and therefore the exact minimum p) without
    reaching into the function's internals.

    Re-audit (docs/AUDIT-2026-10-05.md, C1/CR8): the exclusion margin is
    2*MAX_LAG, not MAX_LAG -- the inner lag-search _circular_shift_pvalue
    runs on every shifted series can itself move the effective offset by up
    to MAX_LAG in either direction, so a shift only MAX_LAG+1 away from a
    boundary could still combine with an inner lag to land back on (or very
    near) the real alignment. Only excluding by MAX_LAG left that window
    open; this used to be the actual, exploitable bug."""
    lo, hi = 2 * MAX_LAG + 1, n - 2 * MAX_LAG - 1
    return max(0, hi - lo + 1)


class TestCircularShiftPvalue:
    def test_returns_one_when_series_too_short_for_any_valid_shift(self):
        # n=12: lo=13, hi=12-13=-1 -- lo > hi, no valid shift exists at all.
        # This used to silently run a statistically meaningless permutation
        # test on whatever shifts rng.randint(1, n-1) happened to draw
        # (some of them within the lag buffer); now it correctly refuses.
        assert _valid_shift_count(12) == 0
        assert _circular_shift_pvalue(list(range(1, 13)), list(range(1, 13)), observed_r=1.0) == 1.0

    def test_pvalue_is_between_zero_and_one(self):
        rng = random.Random(10)
        ref = [rng.uniform(0, 1) for _ in range(40)]
        cand = [rng.uniform(0, 1) for _ in range(40)]
        r, _lag = _best_spearman(ref, cand)
        p = _circular_shift_pvalue(ref, cand, r)
        assert 0.0 <= p <= 1.0

    def test_is_deterministic_same_inputs_always_give_the_same_pvalue(self):
        """No RNG/seed anymore -- exhaustive enumeration means the same
        (ref, cand, observed_r) must always produce bit-identical output,
        not just "reproducible given the same seed" like the old sampling
        approach was."""
        rng = random.Random(11)
        ref = [rng.uniform(0, 1) for _ in range(40)]
        cand = [rng.uniform(0, 1) for _ in range(40)]
        r, _lag = _best_spearman(ref, cand)
        p1 = _circular_shift_pvalue(ref, cand, r)
        p2 = _circular_shift_pvalue(ref, cand, r)
        assert p1 == p2

    def test_minimum_possible_pvalue_at_the_real_dataset_size_matches_the_re_audits_own_1_in_104(self):
        """Re-audit (docs/AUDIT-2026-10-05.md, C1/CR8): CR8's original verify
        line claimed 'the smallest possible p is then about 1/116' for a real
        n=128 series, but that number came from the buggy MAX_LAG (not
        2*MAX_LAG) exclusion margin -- see _valid_shift_count's docstring.
        With the margin corrected, n=128 gives 103 evaluable shifts (lo=13,
        hi=115), so the true floor is 1/104, not 1/116 -- and, unlike the old
        formula, this floor no longer varies by which lag the real
        correlation sits at (the audit measured the old floor ranging
        0.0086-0.0345 depending on lag)."""
        assert _valid_shift_count(128) == 103
        rng = random.Random(2)
        ref = [rng.gauss(0, 1) for _ in range(128)]
        cand = [v + rng.gauss(0, 0.01) for v in ref]  # tight noisy copy, lag 0
        r, lag = _best_spearman(ref, cand)
        assert lag == 0
        assert r > 0.999
        p = _circular_shift_pvalue(ref, cand, r)
        assert p == pytest.approx(1 / 104)

    def test_pure_noise_gives_high_pvalue_typically(self):
        """Two independent random series should typically NOT be judged
        significant -- not a hard guarantee for any single draw, but true
        often enough that a consistently-low p here would indicate the
        permutation test is broken (e.g. always returning the floor).

        n=128 (not a shorter series): the corrected, coarser 2*MAX_LAG
        exclusion margin (C1, docs/AUDIT-2026-10-05.md) leaves too few
        evaluable shifts at small n for this test's 0.1 threshold to be
        meaningful -- at n=40 the floor itself is 1/16=0.0625, already
        below 0.1 regardless of whether the test series are related."""
        rng = random.Random(99)
        ref = [rng.uniform(0, 1) for _ in range(128)]
        cand = [rng.uniform(0, 1) for _ in range(128)]
        r, _lag = _best_spearman(ref, cand)
        if r is None:
            pytest.skip("no valid correlation found for this random draw")
        p = _circular_shift_pvalue(ref, cand, r)
        assert p > 0.1, f"expected weak/no correlation between independent noise, got p={p}"

    def test_never_evaluates_a_shift_within_the_lag_search_window(self, monkeypatch):
        """CR8 issue #1, corrected by the C1 re-audit (docs/AUDIT-2026-10-05.md):
        a shift that small lets the lag search re-create part of the
        ORIGINAL alignment, so the null it feeds isn't fully destroyed. The
        margin that matters is 2*MAX_LAG, not MAX_LAG: the inner lag-search
        run on every shifted series can itself move the effective offset by
        up to MAX_LAG in either direction, so a shift only MAX_LAG+1 away
        from a boundary (previously allowed) could combine with an inner
        lag to land back on, or very near, the real alignment. This
        assertion used to check only `MAX_LAG < shift < n - MAX_LAG`, which
        is exactly why the bug shipped unnoticed -- it is now
        `2*MAX_LAG < shift < n - 2*MAX_LAG`, matching the fixed production
        exclusion range. Spies on every shifted_ref actually passed to the
        lag-search and decodes which shift amount produced it (ref's
        values are all distinct, so this is unambiguous) -- proves the
        exclusion structurally, not just "the result looked plausible"."""
        import api.correlation_sql as correlation_sql_module

        rng = random.Random(5)
        n = 30
        ref = [rng.uniform(0, 1000) for _ in range(n)]  # all distinct w.h.p.
        cand = [rng.uniform(0, 1) for _ in range(n)]

        real_spearman_at_lags = correlation_sql_module._spearman_at_lags
        seen_shifts = []

        def spy(a, b, lags, method):
            if a is not ref and a is not cand:  # a shifted_ref call, not the caller's own best-r lookup
                for shift in range(n):
                    if a == ref[shift:] + ref[:shift]:
                        seen_shifts.append(shift)
                        break
            return real_spearman_at_lags(a, b, lags, method)

        monkeypatch.setattr(correlation_sql_module, "_spearman_at_lags", spy)
        r, _lag = _best_spearman(ref, cand)
        correlation_sql_module._circular_shift_pvalue(ref, cand, r)

        assert len(seen_shifts) == _valid_shift_count(n)
        for shift in seen_shifts:
            assert 2 * MAX_LAG < shift < n - 2 * MAX_LAG, (
                f"shift={shift} is within {2 * MAX_LAG} samples of 0 or n={n} -- "
                f"combined with the inner lag-search, this shift can "
                f"reconstruct an effective offset inside the real lag "
                f"window and must never be evaluated (C1, "
                f"docs/AUDIT-2026-10-05.md)"
            )

    def test_pvalue_is_never_exactly_zero(self):
        """CR8 issue #2: p=(1+extreme)/(1+evaluable) can never be 0, no
        matter how strong the real correlation is -- confirmed via the
        same near-perfect fixture that hits the theoretical floor above."""
        rng = random.Random(2)
        ref = [rng.gauss(0, 1) for _ in range(128)]
        cand = [v + rng.gauss(0, 0.01) for v in ref]
        r, _lag = _best_spearman(ref, cand)
        p = _circular_shift_pvalue(ref, cand, r)
        assert p > 0.0

    def test_unscorable_shifts_are_excluded_from_the_denominator_not_counted_as_non_extreme(self, monkeypatch):
        """CR8 issue #3: a shift where no lag could be scored (perm_r is
        None) used to still occupy one of the n_perm denominator slots,
        silently shrinking p for sparse series as if that shift had been a
        real, scored, non-extreme draw. Stubs _spearman_at_lags to make a
        known subset of the valid shifts unscorable, and confirms the
        returned p matches hand-computed (1+extreme)/(1+evaluable) over
        only the REMAINING (scorable) shifts -- not the full valid range."""
        import api.correlation_sql as correlation_sql_module

        n = 30
        valid_count = _valid_shift_count(n)
        assert valid_count == 5  # lo=13, hi=17 inclusive -> 5 integers
        ref = list(range(n))
        cand = list(range(n))
        real_spearman_at_lags = correlation_sql_module._spearman_at_lags

        call_index = {"i": -1}

        def stub(a, b, lags, method):
            if a is ref or a is cand:  # the caller's own best-r/lag lookup -- let it through for real
                return real_spearman_at_lags(a, b, lags, method)
            call_index["i"] += 1
            # Every 3rd shift (by iteration order) is "unscorable"; the
            # rest score as a fixed, known r so the exact count is provable.
            if call_index["i"] % 3 == 0:
                return (None, None, None, None)
            return (0.5, 0, 0.1, 20)  # never >= observed_r=0.9 below -> never "extreme"

        monkeypatch.setattr(correlation_sql_module, "_spearman_at_lags", stub)
        p = correlation_sql_module._circular_shift_pvalue(ref, cand, observed_r=0.9)

        unscorable = sum(1 for i in range(valid_count) if i % 3 == 0)
        expected_evaluable = valid_count - unscorable
        expected_p = (1 + 0) / (1 + expected_evaluable)  # 0.5 never counts as extreme
        assert p == pytest.approx(expected_p)
        # Sanity: if the bug were still present (unscorable kept in the
        # denominator), p would instead equal 1/(1+valid_count), a
        # different, smaller number for this fixture.
        assert p != pytest.approx((1 + 0) / (1 + valid_count))

    def test_re_searches_all_lags_per_shift_not_fixed_at_observed_best(self):
        """The CR2 bias fix this function has always had, proven directly
        by comparison rather than just checking the output is "a valid
        probability" (which would pass even if the bug were still
        present). Reconstructs what a fixed-at-observed-lag approach would
        have found over the SAME exhaustively-enumerated shift range, so
        the only variable is whether the null re-searches all 9 lags or is
        fixed at 1.

        This is a provable inequality, not just a typical-case tendency: a
        per-shift "best of 9 lags" score can never be less extreme than a
        fixed single lag's score, so full-search's count of
        as-extreme-as-observed shifts can only be >= the fixed-lag count
        -- meaning full-search's p-value can never be LOWER (falsely more
        significant) than the fixed-lag version's."""
        # n must clear 4*MAX_LAG+2 (=26) for the corrected 2*MAX_LAG exclusion
        # margin to leave any valid shift at all -- see _valid_shift_count.
        # n=38 specifically (not just any value above 26): every lag in
        # CORRELATION_LAGS ties at Spearman r=1.0 for this monotonic-in-index
        # construction (rank order is identical regardless of lag), so which
        # lag _spearman_at_lags reports as "best" among the tie comes down to
        # floating-point noise in scipy's tied-rank computation -- n=38 is
        # one of the values where that noise happens to land on the true
        # lag=2 at an exact r=1.0 (not a near-miss like 0.9999999999999999).
        n = 38
        ref = [(j + 1) ** 2 for j in range(n)]
        cand = [(j + 3) ** 2 for j in range(n)]  # true lag = 2
        observed_r, observed_lag = _best_spearman(ref, cand)
        assert observed_lag == 2
        assert observed_r == pytest.approx(1.0)

        full_search_p = _circular_shift_pvalue(ref, cand, observed_r)

        lo, hi = 2 * MAX_LAG + 1, n - 2 * MAX_LAG - 1
        fixed_lag_extreme, fixed_lag_evaluable = 0, 0
        for shift in range(lo, hi + 1):
            shifted_ref = ref[shift:] + ref[:shift]
            fixed_r, _fixed_lag, _fixed_p, _fixed_n = _spearman_at_lags(
                shifted_ref, cand, [observed_lag], "spearman"
            )
            if fixed_r is None:
                continue
            fixed_lag_evaluable += 1
            if abs(fixed_r) >= abs(observed_r):
                fixed_lag_extreme += 1
        fixed_lag_p = (1 + fixed_lag_extreme) / (1 + fixed_lag_evaluable)

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

    def test_p_is_not_bonferroni_scaled(self, monkeypatch):
        """The whole point of CR2: circular_shift's returned p must be the
        raw permutation fraction, never run through _bonferroni_correct
        like every other method -- confirmed directly by spying on
        _bonferroni_correct itself, rather than inferring it from the
        shape of the number (CR8 made evaluable-count, and therefore the
        p-value's granularity, data-dependent, so "not a clean fraction"
        is no longer a reliable signal on its own)."""
        import api.correlation_sql as correlation_sql_module

        calls = []
        real_bonferroni = correlation_sql_module._bonferroni_correct
        monkeypatch.setattr(
            correlation_sql_module, "_bonferroni_correct",
            lambda p, n: calls.append((p, n)) or real_bonferroni(p, n),
        )

        rng = random.Random(7)
        ref = [rng.uniform(1, 100) for _ in range(40)]
        cand = [rng.uniform(1, 100) for _ in range(40)]

        result = score_pair(ref, cand, "circular_shift")
        assert result is not None
        assert calls == [], f"_bonferroni_correct was called for circular_shift: {calls}"

        # Confirm the spy itself actually fires for a non-circular_shift
        # method, so an empty `calls` above means "correctly skipped", not
        # "the spy never gets exercised at all".
        score_pair(ref, cand, "spearman")
        assert len(calls) == 1

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
    the CR8-fixed circular_shift, to give a real measured answer rather
    than assume the fix works because the mechanism sounds right.
    """

    @pytest.mark.slow
    def test_ar1_pairs_pass_the_significance_gate_at_or_below_five_percent(self):
        def ar1(n, phi, seed):
            rng = random.Random(seed)
            x = [rng.gauss(0, 1)]
            for _ in range(n - 1):
                x.append(phi * x[-1] + rng.gauss(0, 1))
            return x

        # Exhaustive enumeration over 115 real valid shifts (n=128) per
        # pair, not a tunable sample count -- measured directly: 150 pairs
        # ~53s total (~0.36s/pair), about the same wall-clock cost as the
        # old n_perm=200 sampling it replaces (fewer shifts, but each one
        # still runs the full 9-lag search, so the per-shift cost is what
        # dominates, not the shift count).
        n_pairs = 150
        pvalues = []
        for i in range(n_pairs):
            ref = ar1(128, 0.85, seed=1000 + 2 * i)
            cand = ar1(128, 0.85, seed=1000 + 2 * i + 1)  # independent draw -- no real relationship
            r, _lag, _p, _n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, "spearman")
            if r is None:
                continue
            pvalues.append(_circular_shift_pvalue(ref, cand, r))

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

    @pytest.mark.slow
    def test_ar1_pairs_also_measures_power_not_just_the_false_positive_rate(self):
        """Re-audit checklist (docs/AUDIT-2026-09-22.md, 'Tests' section):
        'The CR2 simulation also measures power (the fraction of true
        correlates detected)' -- the false-positive test above only proves
        the gate isn't too loose; this proves it isn't so strict it also
        throws away real signal.

        cand = ref + scaled independent AR(1) noise (both autocorrelated,
        same phi, matching the false-positive test's own noise structure)
        -- a real, moderate relationship, not a trivial r=1.0 self-copy.
        noise_scale=0.2 was picked by direct measurement (not guessed): 30
        draws at this scale gave r in [0.65, 0.98], mean 0.89, never
        negative -- a consistently real, but not perfect, signal. (An
        earlier version of this test built cand via its OWN separate AR(1)
        recursion driven by ref, which could numerically blow up or
        decorrelate entirely depending on seed -- measured 0% power from
        that construction, not because circular_shift was broken, but
        because the fixture itself sometimes had no real relationship to
        detect. This additive-noise construction was verified not to have
        that problem.)"""
        def ar1(n, phi, seed):
            rng = random.Random(seed)
            x = [rng.gauss(0, 1)]
            for _ in range(n - 1):
                x.append(phi * x[-1] + rng.gauss(0, 1))
            return x

        n_pairs = 150
        pvalues = []
        for i in range(n_pairs):
            ref = ar1(128, 0.85, seed=3000 + 2 * i)
            noise = ar1(128, 0.85, seed=3000 + 2 * i + 1)
            cand = [r + 0.2 * nz for r, nz in zip(ref, noise)]
            r, _lag, _p, _n = _spearman_at_lags(ref, cand, CORRELATION_LAGS, "spearman")
            if r is None:
                continue
            pvalues.append(_circular_shift_pvalue(ref, cand, r))

        from statsmodels.stats.multitest import multipletests
        _reject, qvalues, _, _ = multipletests(pvalues, alpha=0.05, method="fdr_bh")
        power = sum(q < 0.05 for q in qvalues) / len(qvalues)

        assert power >= 0.8, (
            f"only {power:.1%} of {len(qvalues)} genuinely-related AR(1) pairs "
            f"(phi=0.85, cand=ref+0.2*independent AR(1) noise) passed q<0.05 -- "
            f"a correctly-calibrated gate must still detect most real "
            f"relationships, not just reject unrelated noise. A gate that "
            f"rejects everything would trivially pass the false-positive test "
            f"above while being useless."
        )
