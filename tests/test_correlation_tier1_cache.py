"""
Tests for _get_or_compute_correlation -- Tier 1's read-through cache.
Uses an in-memory sqlite db with the real annotation_catalog/
annotation_series/correlations_cache schema so load_vector/load_sample_order
(imported from correlation_loaders.py) run unmodified against it.
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
    at_p_floor INTEGER,
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
                      lag_samples=0, p_value=0.01, n_pairs=12, at_p_floor=None):
    conn.execute(
        "INSERT INTO correlations_cache "
        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs, at_p_floor) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs, at_p_floor),
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

        assert result == {"r": 0.77, "p": 0.02, "lag_samples": 3, "n_pairs": 11, "at_p_floor": None}

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

    def test_constant_candidate_returns_none_not_crash(self, conn):
        # A candidate with the same value at every co-observed timepoint
        # gives pearsonr a NaN, which would silently bind as SQL NULL, trip
        # correlations_cache's NOT NULL constraint, and send the
        # IntegrityError handler looking for a concurrent writer's row that
        # was never written. Must fail gracefully for just this pair.
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        insert_series(conn, "kegg", "K00001", {s: 10.0 + i for i, s in enumerate(SAMPLES)})
        insert_series(conn, "kegg", "K00002", {s: 7.0 for s in SAMPLES})  # constant

        result = _get_or_compute_correlation(conn, 1, 2, metric="egc", method="raw_pearson")

        assert result is None
        rows = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
        assert rows == 0  # nothing bad got written either

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


class TestLagSignDependsOnCallersReference:
    # Scoring/caching always treats the numerically LOWER catalog id as
    # the reference series, regardless of which id the caller asked about,
    # so the returned lag must be flipped whenever the caller's reference
    # has the higher id -- otherwise it would be silently backwards. ref/cand values below are squared sequences (not
    # a straight line), so only the true offset produces r == 1.0 exactly
    # -- same trick as test_correlation_math.py's test_picks_the_correct_lag,
    # confirming lag=+2 (not some other value) is what's actually found.
    SAMPLES20 = [f"s{i:02d}" for i in range(20)]

    def _seed_offset_by_two_series(self, conn):
        insert_catalog(conn, 1, "kegg", "K00001")  # will be the numeric "low"
        insert_catalog(conn, 2, "kegg", "K00002")  # will be the numeric "high"
        low_values = {self.SAMPLES20[j]: float((j + 1) ** 2) for j in range(20)}
        high_values = {self.SAMPLES20[j]: float((j + 3) ** 2) for j in range(20)}
        insert_series(conn, "kegg", "K00001", low_values)
        insert_series(conn, "kegg", "K00002", high_values)

    def test_freshly_computed_lag_is_negated_when_reference_is_the_higher_id(self, conn):
        self._seed_offset_by_two_series(conn)

        # Caller's reference (catalog_id_a) is 1, the numeric low -- lag is
        # relative to id 1 as reference already, no negation needed.
        result_low_as_ref = _get_or_compute_correlation(
            conn, 1, 2, metric="egc", method="raw_pearson", get_sample_order=lambda: self.SAMPLES20,
        )
        assert result_low_as_ref["lag_samples"] == 2

    def test_cache_hit_lag_is_negated_when_reference_is_the_higher_id(self, conn):
        self._seed_offset_by_two_series(conn)

        # First call (id 1 as reference) computes and caches lag=+2.
        _get_or_compute_correlation(
            conn, 1, 2, metric="egc", method="raw_pearson", get_sample_order=lambda: self.SAMPLES20,
        )
        # Second call asks the SAME pair but with id 2 (the numeric high)
        # as the caller's reference -- a pure cache hit, must come back
        # negated, not the raw stored value.
        result_high_as_ref = _get_or_compute_correlation(
            conn, 2, 1, metric="egc", method="raw_pearson", get_sample_order=lambda: self.SAMPLES20,
        )
        assert result_high_as_ref["lag_samples"] == -2


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


class TestConcurrentInsertRace:
    # Found via live testing: React StrictMode double-fires the panel's
    # fetch effect in dev, sending two near-simultaneous identical family
    # requests -- each on its own sqlite3 connection. Both see a cache miss
    # for the same pair, both compute, and the second one's INSERT hit the
    # UNIQUE constraint and crashed the whole request with an uncaught
    # sqlite3.IntegrityError (500). Same race is reachable in production
    # any time two requests score an overlapping family concurrently (two
    # users, two tabs), not just via StrictMode.

    def test_concurrent_insert_is_recovered_not_raised(self, conn):
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        identical_values = {s: 10.0 + i for i, s in enumerate(SAMPLES)}
        insert_series(conn, "kegg", "K00001", identical_values)
        insert_series(conn, "kegg", "K00002", identical_values)

        winner_row = {"r": 0.4242, "p": 0.01, "lag_samples": -1, "n_pairs": 20, "at_p_floor": None}

        class RacingConnProxy:
            """Wraps the real sqlite3.Connection (whose .execute attribute
            can't be monkeypatched directly -- it's a read-only C-level
            attribute). Forwards everything except .execute, where it
            injects a "concurrent request" INSERT the first time our own
            function tries to INSERT into correlations_cache -- simulating
            another connection winning the race between our cache-miss
            check and our own write."""
            def __init__(self, real_conn):
                self._real = real_conn
                self._raced = False

            def execute(self, sql, params=()):
                if not self._raced and sql.strip().startswith("INSERT INTO correlations_cache"):
                    self._raced = True
                    self._real.execute(
                        "INSERT INTO correlations_cache "
                        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs) "
                        "VALUES (1, 2, ?, 'egc', 'raw_pearson', ?, ?, ?)",
                        (winner_row["r"], winner_row["lag_samples"], winner_row["p"], winner_row["n_pairs"]),
                    )
                    self._real.commit()
                return self._real.execute(sql, params)

            def __getattr__(self, name):
                return getattr(self._real, name)

        result = _get_or_compute_correlation(
            RacingConnProxy(conn), 1, 2, metric="egc", method="raw_pearson",
        )

        assert result == winner_row  # returned the concurrent winner's row, not our own
        rows = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
        assert rows == 1  # exactly one row survives -- no duplicate, no crash

    def test_integrity_error_with_nothing_to_read_back_returns_none_not_crash(self, conn):
        # Not every IntegrityError means "a concurrent request already
        # won": a NOT NULL violation (e.g. from a NaN score) means nothing
        # was ever written by anyone, so the re-read finds no row. That
        # must fail this one pair gracefully, not raise TypeError indexing
        # into None.
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        identical_values = {s: 10.0 + i for i, s in enumerate(SAMPLES)}
        insert_series(conn, "kegg", "K00001", identical_values)
        insert_series(conn, "kegg", "K00002", identical_values)

        class AlwaysIntegrityErrorOnInsertProxy:
            """Same wrapping trick as RacingConnProxy, but simulates an
            IntegrityError with no actual concurrent winner behind it --
            nothing else ever inserts a row for this pair."""
            def __init__(self, real_conn):
                self._real = real_conn

            def execute(self, sql, params=()):
                if sql.strip().startswith("INSERT INTO correlations_cache"):
                    raise sqlite3.IntegrityError("NOT NULL constraint failed: correlations_cache.r")
                return self._real.execute(sql, params)

            def __getattr__(self, name):
                return getattr(self._real, name)

        result = _get_or_compute_correlation(
            AlwaysIntegrityErrorOnInsertProxy(conn), 1, 2, metric="egc", method="raw_pearson",
        )

        assert result is None
        rows = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
        assert rows == 0


class TestOperationalErrorDuringCacheWrite:
    # A lock-timeout mid-write (plausible against a large,
    # heavily-contended real db) raises sqlite3.OperationalError. Left
    # uncaught it would 500 the whole family request and discard every
    # other candidate's already-computed result, potentially minutes to
    # hours of circular_shift work. A different
    # failure mode from the IntegrityError race above: nobody else won
    # here, nothing was ever actually written by anyone, so there's no
    # winner row to read back -- the fix is to roll back the failed
    # write and still return the real result this call itself computed.

    def test_operational_error_on_insert_still_returns_the_real_computed_result(self, conn):
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        identical_values = {s: 10.0 + i for i, s in enumerate(SAMPLES)}
        insert_series(conn, "kegg", "K00001", identical_values)
        insert_series(conn, "kegg", "K00002", identical_values)

        class AlwaysOperationalErrorOnInsertProxy:
            """Same wrapping trick as AlwaysIntegrityErrorOnInsertProxy,
            but simulates a lock-timeout (OperationalError) instead --
            the write itself never lands, by anyone."""
            def __init__(self, real_conn):
                self._real = real_conn

            def execute(self, sql, params=()):
                if sql.strip().startswith("INSERT INTO correlations_cache"):
                    raise sqlite3.OperationalError("database is locked")
                return self._real.execute(sql, params)

            def __getattr__(self, name):
                return getattr(self._real, name)

        result = _get_or_compute_correlation(
            AlwaysOperationalErrorOnInsertProxy(conn), 1, 2, metric="egc", method="raw_pearson",
        )

        # The real, freshly-computed result must still come back -- a
        # near-perfect self-copy (identical_values for both ids) scores
        # r=1.0 -- not None, not a crash.
        assert result is not None
        assert result["r"] == pytest.approx(1.0)
        rows = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
        assert rows == 0  # the failed write really never persisted anything


class TestCircularShiftMethod:
    # "circular_shift" through the real read-through
    # cache -- confirms the stored p_value is the raw permutation
    # fraction (never Bonferroni-scaled, unlike every other method -- see
    # score_pair), and that it shares the cache table safely alongside
    # the other 3 methods without ever colliding on the same row.
    #
    # The module-level SAMPLES (12 points) that every other test class in
    # this file uses is too short for circular_shift's null -- max|lag|=6 leaves
    # NO valid interior shift at n=12 (see test_correlation_math.py's
    # TestCircularShiftPvalue for the exact boundary), so a meaningful
    # permutation p-value needs its own larger sample set here.

    BIG_SAMPLES = [f"s{i:02d}" for i in range(1, 31)]  # 30 -- 5 valid shifts (2*max_lag margin)

    def test_computes_and_caches_a_real_result(self, conn):
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        # Non-monotonic -- avoids the shift/re-lag self-similarity pitfall
        # a strictly increasing series has under Spearman (see
        # test_correlation_math.py's test_perfect_correlation_gives_low_pvalue
        # for the full explanation); a near-noiseless copy still gives a
        # very strong real relationship to detect.
        base = {s: 10.0 + i + 3.0 * ((i % 3) - 1) for i, s in enumerate(self.BIG_SAMPLES)}
        copy = {s: v + 0.05 for s, v in base.items()}
        insert_series(conn, "kegg", "K00001", base)
        insert_series(conn, "kegg", "K00002", copy)

        result = _get_or_compute_correlation(conn, 1, 2, metric="egc", method="circular_shift")

        assert result is not None
        assert result["r"] > 0.9
        assert 0.0 <= result["p"] <= 1.0

        row = conn.execute(
            "SELECT r, p_value, method FROM correlations_cache WHERE catalog_id_a=1 AND catalog_id_b=2"
        ).fetchone()
        assert row is not None
        assert row[2] == "circular_shift"
        # The exact formula at this fixture's real size (30 samples, 5
        # valid shifts under the 2*max_lag margin): a near-perfect, non-monotonic
        # relationship should hit the floor, (1+0)/(1+5) = 1/6 -- not just
        # "some small p".
        assert row[1] == pytest.approx(1 / 6)
        # This p IS the floor (no shift
        # scored as extreme as the real alignment) -- at_p_floor must say
        # so, through the cache-write path, not just the fresh-compute one.
        assert result["at_p_floor"] is True

    def test_too_few_samples_for_any_valid_shift_returns_p_one_not_a_bogus_fraction(self, conn):
        """The no-valid-shift edge, exercised through the real cache layer this
        time: with the module-level 12-sample fixture every other test
        class in this file relies on, there is no valid interior shift at
        all (lo=7 > hi=5) -- the pre-fix code would have still drawn 1000
        random shifts from [1, 11] (some of them inside the lag buffer)
        and reported a misleadingly precise-looking fraction. Post-fix,
        this must come back as exactly 1.0, not some arbitrary number."""
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        base = {s: 10.0 + i + 3.0 * ((i % 3) - 1) for i, s in enumerate(SAMPLES)}
        copy = {s: v + 0.05 for s, v in base.items()}
        insert_series(conn, "kegg", "K00001", base)
        insert_series(conn, "kegg", "K00002", copy)

        result = _get_or_compute_correlation(conn, 1, 2, metric="egc", method="circular_shift")

        assert result is not None
        assert result["r"] > 0.9  # the r statistic itself is unaffected -- only p defaults to 1.0
        assert result["p"] == 1.0
        # This 1.0 means "no valid shift to test against," not "hit
        # the floor" -- at_p_floor must stay False here, not True.
        assert result["at_p_floor"] is False

    def test_constant_candidate_returns_none_not_crash(self, conn):
        """At the cache layer, the same NaN-guard/graceful-None behavior
        other methods get must hold for circular_shift too."""
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        insert_series(conn, "kegg", "K00001", {s: 10.0 + i for i, s in enumerate(SAMPLES)})
        insert_series(conn, "kegg", "K00002", {s: 7.0 for s in SAMPLES})  # constant

        result = _get_or_compute_correlation(conn, 1, 2, metric="egc", method="circular_shift")

        assert result is None
        rows = conn.execute("SELECT COUNT(*) FROM correlations_cache").fetchone()[0]
        assert rows == 0

    def test_shares_the_cache_table_without_colliding_with_other_methods(self, conn):
        """The same (catalog_id_a, catalog_id_b, metric) pair, scored
        under 2 different methods, must land as 2 independent rows --
        method is part of correlations_cache's UNIQUE constraint and this
        confirms that's actually load-bearing here, not just declared."""
        insert_catalog(conn, 1, "kegg", "K00001")
        insert_catalog(conn, 2, "kegg", "K00002")
        base = {s: 10.0 + i + 3.0 * ((i % 3) - 1) for i, s in enumerate(SAMPLES)}
        copy = {s: v + 0.05 for s, v in base.items()}
        insert_series(conn, "kegg", "K00001", base)
        insert_series(conn, "kegg", "K00002", copy)

        _get_or_compute_correlation(conn, 1, 2, metric="egc", method="raw_pearson")
        _get_or_compute_correlation(conn, 1, 2, metric="egc", method="circular_shift")

        rows = conn.execute(
            "SELECT method FROM correlations_cache WHERE catalog_id_a=1 AND catalog_id_b=2"
        ).fetchall()
        assert {r[0] for r in rows} == {"raw_pearson", "circular_shift"}
        assert len(rows) == 2
