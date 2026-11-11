"""
The vectorised family scorer (api/correlation_vector.py) must give the same
answers as score_pair, the one-pair-at-a-time reference, for every
candidate: same r and p to rounding, same lag and shared-point count
exactly, and the same "can't be scored" verdict.
"""
import math
import os
import sys

import numpy as np
import pytest
from scipy import stats

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.config import CORRELATION_LAGS
from api.correlation_sql import _lag_tests_m_eff, score_pair
from api.correlation_vector import rank_rows, score_family, score_family_checked

METHODS = ["raw_pearson", "log_pearson", "spearman"]


def _smooth_series(rng, n, phi=0.85):
    x = np.zeros(n)
    x[0] = rng.normal()
    for i in range(1, n):
        x[i] = phi * x[i - 1] + rng.normal()
    return np.exp(x)


def _as_list(row):
    return [None if not np.isfinite(v) else float(v) for v in row]


def _family(seed, n=128, ref_present=None):
    """A reference and a candidate table covering the awkward cases:
    gaps, sparse rows, constant rows, zeros and negatives, ties, and
    copies / shifted copies / a negated copy of the reference."""
    rng = np.random.default_rng(seed)
    ref = _smooth_series(rng, n)
    ref[rng.random(n) < 0.15] = np.nan
    if ref_present is not None:
        ref[:] = np.nan
        keep = np.sort(rng.choice(n, ref_present, replace=False))
        ref[keep] = _smooth_series(rng, ref_present)

    rows = []
    for _ in range(300):
        row = _smooth_series(rng, n)
        row[rng.random(n) < rng.uniform(0.0, 0.4)] = np.nan
        rows.append(row)
    for _ in range(30):                                  # sparse: 5-20 values
        row = np.full(n, np.nan)
        idx = rng.choice(n, rng.integers(5, 21), replace=False)
        row[idx] = _smooth_series(rng, len(idx))
        rows.append(row)
    rows.append(np.full(n, 3.0))                         # constant
    const_but_one = np.full(n, 3.0); const_but_one[n // 2] = 4.0
    rows.append(const_but_one)
    with_zeros = _smooth_series(rng, n); with_zeros[::3] = 0.0; with_zeros[1::7] = -1.0
    rows.append(with_zeros)
    rows.append(np.round(_smooth_series(rng, n), 0))     # many ties
    rows.append(ref.copy())                              # identical
    rows.append(ref * 2.5)                               # same shape, other scale
    for shift in (2, -3, 6):                             # shifted copies
        shifted = np.full(n, np.nan)
        if shift > 0:
            shifted[:-shift] = ref[shift:]
        else:
            shifted[-shift:] = ref[:shift]
        rows.append(shifted)
    rows.append(1.0 / ref)                               # rises when ref falls
    rows.append(np.full(n, np.nan))                      # never detected
    return ref, np.vstack(rows)


def _assert_matches_score_pair(ref, table, method, result):
    ref_list = _as_list(ref)
    for i, row in enumerate(table):
        expected = score_pair(ref_list, _as_list(row), method)
        if expected is None:
            assert not result["ok"][i], f"row {i}: score_pair can't score it, vector version did"
            continue
        assert result["ok"][i], f"row {i}: score_pair scored it, vector version didn't"
        r, p, lag, n_pairs, _ = expected
        assert result["lag"][i] == lag, f"row {i}: lag"
        assert result["n_pairs"][i] == n_pairs, f"row {i}: n_pairs"
        assert result["r"][i] == pytest.approx(r, abs=1e-12), f"row {i}: r"
        assert result["p"][i] == pytest.approx(p, rel=1e-9, abs=1e-300), f"row {i}: p"


# ── ranks ────────────────────────────────────────────────────────────────────

class TestRankRows:
    def test_matches_rankdata_with_ties_and_gaps(self):
        rng = np.random.default_rng(0)
        table = np.round(rng.uniform(0, 6, (50, 40)))     # lots of ties
        table[rng.random(table.shape) < 0.3] = np.nan
        ranks = rank_rows(table)
        for row, row_ranks in zip(table, ranks):
            present = ~np.isnan(row)
            assert np.array_equal(row_ranks[present], stats.rankdata(row[present]))
            assert np.isnan(row_ranks[~present]).all()


# ── score_family_checked == score_pair ──────────────────────────────────────

class TestMatchesScorePair:
    @pytest.mark.parametrize("method", METHODS)
    def test_typical_reference(self, method):
        ref, table = _family(seed=1)
        _assert_matches_score_pair(ref, table, method, score_family_checked(ref, table, method))

    @pytest.mark.parametrize("method", METHODS)
    @pytest.mark.parametrize("ref_present", [12, 25, 29])
    def test_sparse_reference(self, method, ref_present):
        # Fewer than 30 shared points everywhere: the look-back window
        # (shared // 5) is shorter than the 12-sample lag span, which is
        # where an unpadded shift runs off the end of the array.
        ref, table = _family(seed=2, ref_present=ref_present)
        _assert_matches_score_pair(ref, table, method, score_family_checked(ref, table, method))

    @pytest.mark.parametrize("method", METHODS)
    def test_short_series(self, method):
        ref, table = _family(seed=3, n=30)
        _assert_matches_score_pair(ref, table, method, score_family_checked(ref, table, method))

    def test_no_candidates(self):
        ref, _ = _family(seed=4)
        result = score_family_checked(ref, np.empty((0, len(ref))), "spearman")
        assert len(result["ok"]) == 0


# ── the vector arithmetic on its own (no score_pair fallback) ────────────────

class TestVectorArithmetic:
    @pytest.mark.parametrize("method", METHODS)
    def test_unflagged_rows_already_match(self, method):
        # Rows score_family does not flag for a recheck must be right on
        # their own; otherwise the fallback would be hiding real mistakes.
        ref, table = _family(seed=5)
        result = score_family(ref, table, method)
        unflagged = ~result["recheck"]
        assert unflagged.sum() > 300
        subset = {k: v[unflagged] for k, v in result.items() if isinstance(v, np.ndarray)}
        _assert_matches_score_pair(ref, table[unflagged], method, subset)

    @pytest.mark.parametrize("method", METHODS)
    def test_m_eff_matches(self, method):
        ref, table = _family(seed=6)
        result = score_family(ref, table, method)
        ref_list = _as_list(ref)
        for i, row in enumerate(table):
            if result["ok"][i]:
                assert result["m_eff"][i] == pytest.approx(
                    _lag_tests_m_eff(ref_list, _as_list(row), method), abs=1e-9), f"row {i}"

    def test_exact_tie_between_lags(self):
        # A rising reference and a rising candidate with one swapped pair
        # and its last value missing: lag 0 and lag +1 pair the same
        # candidate values with reference values of the same ranks, so
        # score_pair's Spearman r is exactly equal at both and it keeps the
        # earlier lag in CORRELATION_LAGS order (0). The vector arithmetic
        # gets the two equal to the last digit only, so what makes the
        # answer right is the near-tie flag sending the row to score_pair.
        n = 40
        ref = np.arange(1.0, n + 1)
        cand = np.arange(1.0, n + 1)
        cand[[20, 21]] = cand[[21, 20]]
        cand[-1] = np.nan
        expected = score_pair(_as_list(ref), _as_list(cand), "spearman")
        assert expected[2] == 0
        result = score_family(ref, cand[None, :], "spearman")
        assert result["lag"][0] == 0
        assert result["recheck"][0]

    def test_identical_copy_is_rechecked(self):
        # r lands within rounding of 1, where score_pair's own p is 0 and
        # the vector arithmetic's is a denormal; score_pair must decide.
        ref, table = _family(seed=7)
        result = score_family(ref, table, "raw_pearson")
        copy_row = next(i for i, row in enumerate(table) if np.array_equal(row, ref, equal_nan=True))
        assert result["recheck"][copy_row]


# ── why a candidate could not be scored ──────────────────────────────────────

class TestNotScoredReason:
    def test_too_few_points(self):
        ref = _smooth_series(np.random.default_rng(8), 128)
        row = np.full(128, np.nan); row[:8] = 5.0 + np.arange(8)
        result = score_family_checked(ref, row[None, :], "spearman")
        assert not result["ok"][0]
        assert result["reason"][0] == "too_few_points"
        assert result["max_shared"][0] == 8

    def test_no_variation(self):
        ref = _smooth_series(np.random.default_rng(9), 128)
        result = score_family_checked(ref, np.full((1, 128), 3.0), "raw_pearson")
        assert not result["ok"][0]
        assert result["reason"][0] == "no_variation"
        assert result["max_shared"][0] == 128

    def test_scored_rows_have_no_reason(self):
        ref, table = _family(seed=10)
        result = score_family_checked(ref, table, "spearman")
        assert all(reason is None for reason in result["reason"][result["ok"]])
