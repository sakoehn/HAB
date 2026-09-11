"""
Tests for _apply_fdr -- the Benjamini-Hochberg step of Tier 2. No DB needed,
this operates purely on the list of dicts a family's scoring loop produces.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.correlation_sql import _apply_fdr


def test_empty_family_returns_empty_list():
    assert _apply_fdr([]) == []


def test_single_entry_q_equals_p():
    # BH with one test is a no-op -- the one q-value equals its p-value.
    family = [{"p": 0.03}]

    result = _apply_fdr(family)

    assert result[0]["q"] == pytest.approx(0.03)


def test_known_bh_values_five_candidates():
    # p-values chosen so the BH math is hand-checkable:
    # sorted p: .01, .02, .03, .04, .5 (already sorted here, ranks 1-5)
    # raw q_i = p_i * n / rank: .05, .05, .05, .05, .5
    # monotonicity enforcement (cummin from the end) doesn't change any of
    # these since they're already non-decreasing -- expected final q's are
    # [.05, .05, .05, .05, .5].
    family = [
        {"id": "a", "p": 0.01},
        {"id": "b", "p": 0.02},
        {"id": "c", "p": 0.03},
        {"id": "d", "p": 0.04},
        {"id": "e", "p": 0.50},
    ]

    result = _apply_fdr(family)

    q_by_id = {entry["id"]: entry["q"] for entry in result}
    assert q_by_id["a"] == pytest.approx(0.05)
    assert q_by_id["b"] == pytest.approx(0.05)
    assert q_by_id["c"] == pytest.approx(0.05)
    assert q_by_id["d"] == pytest.approx(0.05)
    assert q_by_id["e"] == pytest.approx(0.50)


def test_preserves_other_fields_unchanged():
    family = [{"id": "x", "p": 0.02, "r": 0.87, "lag_samples": 3}]

    result = _apply_fdr(family)

    assert result[0]["r"] == 0.87
    assert result[0]["lag_samples"] == 3


def test_q_stays_paired_with_the_right_entry_regardless_of_input_order():
    # Input deliberately NOT sorted by p -- confirms _apply_fdr doesn't
    # silently re-sort and mismatch q-values against the wrong entries.
    family = [
        {"id": "big", "p": 0.9},
        {"id": "small", "p": 0.001},
    ]

    result = _apply_fdr(family)

    q_by_id = {entry["id"]: entry["q"] for entry in result}
    assert q_by_id["small"] < q_by_id["big"]
