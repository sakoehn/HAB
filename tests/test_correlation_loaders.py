"""
Tests for api/correlation_loaders.py's assert_sample_order_is_trustworthy
(CR6, see docs/AUDIT.md) -- the one-time startup guard against a broken
real sample time axis. Monkeypatches correlation_loaders.timepoint_sort_key
directly rather than touching the real JGI_ID_Timepoints_128.csv lookup,
so these tests are independent of that file's real contents.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

import api.correlation_loaders as correlation_loaders
from api.correlation_loaders import assert_sample_order_is_trustworthy


def _patch_keys(monkeypatch, keys_by_sample: dict[str, float]):
    monkeypatch.setattr(
        correlation_loaders, "timepoint_sort_key", lambda sample: keys_by_sample[sample],
    )


class TestValidCases:
    def test_all_resolved_distinct_timepoints_does_not_raise(self, monkeypatch):
        _patch_keys(monkeypatch, {"s1": 100.0, "s2": 200.0, "s3": 300.0})

        assert_sample_order_is_trustworthy(["s1", "s2", "s3"])  # no raise

    def test_unevenly_spaced_real_gaps_do_not_raise(self, monkeypatch):
        # Real dataset has legitimate 8h/12h gaps from missing samples,
        # not just the base 4h cadence -- confirmed against the live
        # 128-sample data before writing this fix. Must not false-positive.
        _patch_keys(monkeypatch, {"s1": 0.0, "s2": 4 * 3600, "s3": 16 * 3600})

        assert_sample_order_is_trustworthy(["s1", "s2", "s3"])  # no raise

    def test_empty_list_does_not_raise(self, monkeypatch):
        _patch_keys(monkeypatch, {})

        assert_sample_order_is_trustworthy([])  # no raise


class TestUnresolvedTimepoint:
    def test_a_single_unresolved_sample_raises(self, monkeypatch):
        _patch_keys(monkeypatch, {"s1": 100.0, "s2": -1.0, "s3": 300.0})

        try:
            assert_sample_order_is_trustworthy(["s1", "s2", "s3"])
            assert False, "expected ValueError"
        except ValueError as e:
            assert "s2" in str(e)

    def test_every_sample_unresolved_raises_with_full_count(self, monkeypatch):
        _patch_keys(monkeypatch, {"s1": -1.0, "s2": -1.0})

        try:
            assert_sample_order_is_trustworthy(["s1", "s2"])
            assert False, "expected ValueError"
        except ValueError as e:
            assert "2 sample" in str(e)


class TestCollidingTimepoints:
    def test_two_samples_sharing_a_timestamp_raises(self, monkeypatch):
        _patch_keys(monkeypatch, {"s1": 100.0, "s2": 100.0, "s3": 300.0})

        try:
            assert_sample_order_is_trustworthy(["s1", "s2", "s3"])
            assert False, "expected ValueError"
        except ValueError as e:
            assert "s1" in str(e) and "s2" in str(e)

    def test_unresolved_check_runs_before_collision_check(self, monkeypatch):
        # Both problems present at once -- the unresolved-timepoint error
        # is the more actionable one (missing CSV data), so it should win.
        _patch_keys(monkeypatch, {"s1": -1.0, "s2": 100.0, "s3": 100.0})

        try:
            assert_sample_order_is_trustworthy(["s1", "s2", "s3"])
            assert False, "expected ValueError"
        except ValueError as e:
            assert "resolvable timepoint" in str(e)
