"""
Tests for _get_or_compute_correlation -- Tier 1's read-through cache.
Uses an in-memory sqlite db with the real annotation_catalog/
annotation_series/correlations_cache schema so load_vector/load_sample_order
(imported from migrate_correlations_to_sql.py) run unmodified against it.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.correlation_sql import _get_or_compute_correlation

SCHEMA = """
CREATE TABLE annotation_catalog(
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    annotation_id TEXT NOT NULL,
    name TEXT,
    parent TEXT,
    depth INTEGER,
    UNIQUE (source, annotation_id)
);

CREATE TABLE annotation_series(
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    sample TEXT NOT NULL,
    annotation_id TEXT NOT NULL,
    name TEXT,
    category TEXT,
    parent TEXT,
    depth INTEGER,
    egc REAL,
    norm_egc REAL,
    scaffold_count INTEGER,
    gene_count INTEGER,
    UNIQUE(source, sample, annotation_id)
);

CREATE TABLE correlations_cache(
    id INTEGER PRIMARY KEY,
    catalog_id_a INTEGER NOT NULL,
    catalog_id_b INTEGER NOT NULL,
    r REAL NOT NULL,
    metric TEXT NOT NULL,
    method TEXT NOT NULL,
    lag_samples INTEGER NOT NULL,
    p_value REAL NOT NULL,
    n_pairs INTEGER NOT NULL,
    UNIQUE (catalog_id_a, catalog_id_b, metric, method)
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    connection.commit()
    yield connection
    connection.close()


def insert_catalog(conn, id, source, annotation_id):
    conn.execute(
        "INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (?, ?, ?)",
        (id, source, annotation_id),
    )
    conn.commit()


def insert_series(conn, source, annotation_id, values_by_sample, metric="egc"):
    column = "egc" if metric == "egc" else "norm_egc"
    for sample, value in values_by_sample.items():
        conn.execute(
            f"INSERT INTO annotation_series (source, sample, annotation_id, {column}) "
            "VALUES (?, ?, ?, ?)",
            (source, sample, annotation_id, value),
        )
    conn.commit()


def insert_cache_row(conn, catalog_id_a, catalog_id_b, r=0.5, metric="egc", method="raw_pearson",
                      lag_samples=0, p_value=0.01, n_pairs=12):
    conn.execute(
        "INSERT INTO correlations_cache "
        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs),
    )
    conn.commit()


SAMPLES = [f"s{i:02d}" for i in range(1, 13)]  # 12 samples, well above the 10-point floor


class TestCacheHit:
    def test_returns_cached_row_without_touching_series(self, conn):
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        insert_cache_row(conn, 1, 2, r=0.77, lag_samples=3, p_value=0.02, n_pairs=11)
        # Deliberately no annotation_series rows -- if the function fell
        # through to computing instead of using the cache, load_vector
        # would find nothing and it would behave very differently.

        result = _get_or_compute_correlation(conn, 1, 2, metric="egc", method="raw_pearson")

        assert result == {"r": 0.77, "p": 0.02, "lag_samples": 3, "n_pairs": 11}

    def test_hits_regardless_of_argument_order(self, conn):
        insert_catalog(conn, 5, "kegg", "K00005")
        insert_catalog(conn, 2, "kegg", "K00002")
        insert_cache_row(conn, 2, 5, r=0.4, n_pairs=10)  # stored canonically low=2, high=5

        result = _get_or_compute_correlation(conn, 5, 2, metric="egc", method="raw_pearson")

        assert result["r"] == 0.4


class TestCacheMiss:
    def test_computes_and_inserts_on_miss(self, conn):
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        identical_values = {s: 10.0 + i for i, s in enumerate(SAMPLES)}
        insert_series(conn, "kegg", "K00001", identical_values)
        insert_series(conn, "kegg", "K00002", identical_values)

        result = _get_or_compute_correlation(conn, 1, 2, metric="egc", method="raw_pearson")

        assert result is not None
        assert result["r"] == pytest.approx(1.0)

        rows = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
        assert rows == 1

    def test_stores_canonical_low_high_regardless_of_call_order(self, conn):
        insert_catalog(conn, 5, "kegg", "K00005")
        insert_catalog(conn, 2, "kegg", "K00002")
        identical_values = {s: 10.0 + i for i, s in enumerate(SAMPLES)}
        insert_series(conn, "kegg", "K00005", identical_values)
        insert_series(conn, "kegg", "K00002", identical_values)

        _get_or_compute_correlation(conn, 5, 2, metric="egc", method="raw_pearson")

        row = conn.execute(
            "SELECT catalog_id_a, catalog_id_b FROM correlations_cache"
        ).fetchone()
        assert row == (2, 5)

    def test_second_call_in_either_order_is_a_cache_hit_not_a_recompute(self, conn):
        insert_catalog(conn, 5, "kegg", "K00005")
        insert_catalog(conn, 2, "kegg", "K00002")
        identical_values = {s: 10.0 + i for i, s in enumerate(SAMPLES)}
        insert_series(conn, "kegg", "K00005", identical_values)
        insert_series(conn, "kegg", "K00002", identical_values)

        _get_or_compute_correlation(conn, 5, 2, metric="egc", method="raw_pearson")
        _get_or_compute_correlation(conn, 2, 5, metric="egc", method="raw_pearson")

        rows = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
        assert rows == 1

    def test_returns_none_and_inserts_nothing_when_too_few_valid_pairs(self, conn):
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        # Only 4 samples -- below the 10-point floor in core_scoring.
        sparse_values = {s: 10.0 + i for i, s in enumerate(SAMPLES[:4])}
        insert_series(conn, "kegg", "K00001", sparse_values)
        insert_series(conn, "kegg", "K00002", sparse_values)

        result = _get_or_compute_correlation(conn, 1, 2, metric="egc", method="raw_pearson")

        assert result is None
        rows = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
        assert rows == 0


class TestGetSampleOrderMemoization:
    # Discovered via live testing against the real ~6.3M-row annotation_series
    # table: load_sample_order's full-table DISTINCT scan costs ~1s per call.
    # A family of N cache-miss candidates calling it N times (instead of once)
    # turned a several-minute request into several hours. These tests pin the
    # fix: get_sample_order is only invoked on an actual cache MISS, and a
    # caller's own memoization means repeated misses only pay for it once.

    def test_cache_hit_never_calls_get_sample_order(self, conn):
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        insert_cache_row(conn, 1, 2, r=0.5)

        def blow_up():
            raise AssertionError("get_sample_order should not be called on a cache hit")

        result = _get_or_compute_correlation(
            conn, 1, 2, metric="egc", method="raw_pearson", get_sample_order=blow_up,
        )

        assert result is not None

    def test_cache_miss_calls_get_sample_order_exactly_once_per_call(self, conn):
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        identical_values = {s: 10.0 + i for i, s in enumerate(SAMPLES)}
        insert_series(conn, "kegg", "K00001", identical_values)
        insert_series(conn, "kegg", "K00002", identical_values)

        calls = []
        def counting_get_sample_order():
            calls.append(1)
            return SAMPLES

        _get_or_compute_correlation(
            conn, 1, 2, metric="egc", method="raw_pearson", get_sample_order=counting_get_sample_order,
        )

        assert len(calls) == 1

    def test_a_callers_memoized_factory_is_reused_across_multiple_misses(self, conn):
        # Simulates the family endpoint's own pattern: one memoizing closure
        # shared across every candidate in the loop.
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        insert_catalog(conn, 3, "kegg", "K00003")
        identical_values = {s: 10.0 + i for i, s in enumerate(SAMPLES)}
        insert_series(conn, "kegg", "K00001", identical_values)
        insert_series(conn, "kegg", "K00002", identical_values)
        insert_series(conn, "kegg", "K00003", identical_values)

        compute_count = []
        _box = []
        def memoized_get_sample_order():
            if not _box:
                compute_count.append(1)
                _box.append(SAMPLES)
            return _box[0]

        _get_or_compute_correlation(conn, 1, 2, metric="egc", method="raw_pearson", get_sample_order=memoized_get_sample_order)
        _get_or_compute_correlation(conn, 1, 3, metric="egc", method="raw_pearson", get_sample_order=memoized_get_sample_order)

        assert len(compute_count) == 1  # underlying work only happened once across 2 misses
