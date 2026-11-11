"""
Saved correlation results carry CORRELATION_METHOD_VERSION, and results
from any other version are ignored. That only works if the version is
bumped whenever the math changes, so this test pins score_pair's exact
answers on a few fixed pairs. If it fails, the math changed: if that was
on purpose, bump CORRELATION_METHOD_VERSION in api/correlation_sql.py and
re-record EXPECTED and FINGERPRINT_VERSION here.
"""
import math
import os
import sys
import warnings

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.correlation_sql import CORRELATION_METHOD_VERSION, score_pair
from api.correlation_vector import score_family_checked

# The version EXPECTED was recorded with.
FINGERPRINT_VERSION = 1

N = 128


def _wave(t, period):
    return 10 + 5 * math.sin(2 * math.pi * t / period)


def _jitter(t, k):
    return 0.3 * math.sin(7.3 * t + k) + 0.2 * math.cos(3.1 * t * k)


PAIRS = {
    "same wave, candidate 2 samples earlier": (
        [_wave(t, 24) + _jitter(t, 1) for t in range(N)],
        [_wave(t + 2, 24) * 0.5 + _jitter(t, 2) for t in range(N)]),
    "two similar waves, with gaps": (
        [None if t % 9 == 4 else _wave(t, 31) + _jitter(t, 3) for t in range(N)],
        [None if t % 7 == 2 else 6 + 3 * math.cos(t / 5.0) + _jitter(t, 4) for t in range(N)]),
    "rises when the other falls, sparse": (
        [None if t % 4 else _wave(t, 40) for t in range(N)],
        [None if t % 4 else 30 - _wave(t, 40) + _jitter(t, 5) for t in range(N)]),
    "trend plus ties": (
        [round(1 + t / 10.0) for t in range(N)],
        [round(2 + t / 12.0 + _jitter(t, 6)) for t in range(N)]),
}

# (r, p, lag, n_pairs) from score_pair at FINGERPRINT_VERSION.
EXPECTED = {
    ("same wave, candidate 2 samples earlier", "raw_pearson"): (0.9911375710192121, 0.00012267787475803472, 2, 126),
    ("same wave, candidate 2 samples earlier", "log_pearson"): (0.9885928013223042, 0.0001377012544791825, 2, 126),
    ("same wave, candidate 2 samples earlier", "spearman"): (0.9818762654668165, 0.00036076722356208075, 2, 126),
    ("two similar waves, with gaps", "raw_pearson"): (0.9773850004748843, 0.0003432994911750665, 6, 93),
    ("two similar waves, with gaps", "log_pearson"): (0.9738701495957344, 0.000318756462645066, 6, 93),
    ("two similar waves, with gaps", "spearman"): (0.9567007848169257, 0.001214949965892373, 6, 93),
    ("rises when the other falls, sparse", "raw_pearson"): (-0.997316698015038, 4.605477527187053e-05, 0, 32),
    ("rises when the other falls, sparse", "log_pearson"): (-0.976402250645236, 0.0031242734671528653, 0, 32),
    ("rises when the other falls, sparse", "spearman"): (-0.9658849956754023, 0.005198557964774931, 0, 32),
    ("trend plus ties", "raw_pearson"): (0.989206767557895, 0.0016370022055223889, 5, 123),
    ("trend plus ties", "log_pearson"): (0.9799554159825771, 0.0012771057296050623, 4, 124),
    ("trend plus ties", "spearman"): (0.9899045619165681, 0.0016418209778632418, 5, 123),
}

CHANGED = ("The correlation math changed. If that was on purpose, bump "
           "CORRELATION_METHOD_VERSION in api/correlation_sql.py and re-record "
           "EXPECTED and FINGERPRINT_VERSION in this file.")


def test_fingerprint_was_recorded_with_the_current_version():
    assert FINGERPRINT_VERSION == CORRELATION_METHOD_VERSION, (
        "CORRELATION_METHOD_VERSION changed: re-record EXPECTED from score_pair "
        "and set FINGERPRINT_VERSION to match.")


@pytest.mark.parametrize("name, method", sorted(EXPECTED))
def test_score_pair_gives_the_recorded_answer(name, method):
    ref, cand = PAIRS[name]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        r, p, lag, n_pairs, _ = score_pair(ref, cand, method)
    exp_r, exp_p, exp_lag, exp_n = EXPECTED[(name, method)]
    assert (lag, n_pairs) == (exp_lag, exp_n), CHANGED
    # Tolerances allow for last-digit differences between numpy/scipy
    # builds, far below any real change to the math.
    assert r == pytest.approx(exp_r, abs=1e-12), CHANGED
    assert p == pytest.approx(exp_p, rel=1e-9), CHANGED


@pytest.mark.parametrize("method", ["raw_pearson", "log_pearson", "spearman"])
def test_vector_scorer_gives_the_recorded_answer(method):
    # The family route scores with correlation_vector, so it is pinned too.
    names = [name for name, m in sorted(EXPECTED) if m == method]
    for name in names:
        ref, cand = PAIRS[name]
        result = score_family_checked(
            np.array(ref, dtype=float), np.array([cand], dtype=float), method)
        exp_r, exp_p, exp_lag, exp_n = EXPECTED[(name, method)]
        assert (result["lag"][0], result["n_pairs"][0]) == (exp_lag, exp_n), f"{name}: {CHANGED}"
        assert result["r"][0] == pytest.approx(exp_r, abs=1e-12), f"{name}: {CHANGED}"
        assert result["p"][0] == pytest.approx(exp_p, rel=1e-9), f"{name}: {CHANGED}"
