"""
Tests for api/correlation_loaders.py's assert_sample_order_is_trustworthy
-- the one-time startup guard against a broken
real sample time axis. Monkeypatches correlation_loaders.timepoint_sort_key
directly rather than touching the real JGI_ID_Timepoints_128.csv lookup,
so these tests are independent of that file's real contents.
"""
import os
import sqlite3
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

import api.correlation_loaders as correlation_loaders
from api.correlation_loaders import assert_sample_order_is_trustworthy, load_family_matrix, load_vector


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


# ── load_family_matrix ───────────────────────────────────────────────────────

class TestLoadFamilyMatrix:
    """One table for many annotations must hold exactly what load_vector
    gives for each one: same values in the same sample positions, NaN
    where load_vector has None (no row, or a NULL value)."""

    @pytest.fixture
    def conn(self):
        from scripts.create_sql_schema import SCHEMA
        connection = sqlite3.connect(":memory:")
        connection.executescript(SCHEMA)
        rows = [
            ("kegg", "s1", "K1", 1.0, 0.1), ("kegg", "s3", "K1", 3.0, 0.3),
            ("kegg", "s2", "K2", 2.0, None), ("kegg", "s3", "K2", None, 0.6),
            ("kegg", "s1", "K3", 9.0, 0.9),
            ("cog", "s1", "K1", 99.0, 9.9),   # same id, other source: must not leak in
        ]
        connection.executemany(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc, norm_egc) VALUES (?, ?, ?, ?, ?)", rows)
        yield connection
        connection.close()

    @pytest.mark.parametrize("metric", ["egc", "norm_egc"])
    @pytest.mark.parametrize("chunk_size", [900, 2])
    def test_matches_load_vector(self, conn, metric, chunk_size):
        order = ["s1", "s2", "s3"]
        ids = ["K2", "K4", "K1", "K3"]   # K4 has no rows at all
        table = load_family_matrix(conn, "kegg", ids, order, metric, chunk_size=chunk_size)
        assert table.shape == (4, 3)
        for row, aid in zip(table, ids):
            expected = [np.nan if v is None else v for v in load_vector(conn, "kegg", aid, order, metric)]
            np.testing.assert_array_equal(row, np.array(expected, dtype=float))

    def test_no_annotations(self, conn):
        assert load_family_matrix(conn, "kegg", [], ["s1", "s2"], "egc").shape == (0, 2)

    def test_unknown_metric_raises(self, conn):
        with pytest.raises(ValueError):
            load_family_matrix(conn, "kegg", ["K1"], ["s1"], "depth")
