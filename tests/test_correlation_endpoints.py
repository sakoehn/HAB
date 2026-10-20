"""
End-to-end tests for the two HTTP endpoints in correlation_sql.py, hit
through a real FastAPI TestClient (not just calling the Python functions
directly) -- confirms query-param wiring, the /correlations/family q<0.05
gate, and the 400 on an invalid target_source.

Pre-seeds correlations_cache directly rather than constructing real
correlated time series: /correlation and /correlations/family both read
through Tier 1's cache-hit path first, so seeding known r/p values there is
a much more direct and deterministic way to test the FDR gate itself than
reverse-engineering data that produces a particular p-value by chance.
"""
import os
import random
import sqlite3
import sys
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

import api.correlation_sql as correlation_sql

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
def client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)

    # ref (taxonomy) vs two kegg candidates -- cross-source, so no
    # exclusion-rule complexity, this file is only testing the HTTP layer.
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (1, 'taxonomy', 'Bacteria')")
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id, name, depth) VALUES (2, 'kegg', 'K00002', 'Nitrogenase', 3)")
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (3, 'kegg', 'K00003')")

    # A fourth candidate, cache-MISS, whose value never changes across
    # samples -- pearsonr returns NaN for it, which must omit just this one
    # candidate rather than crash the whole family request. Deliberately not pre-seeded into correlations_cache, so
    # scoring it exercises the real compute-on-miss path, not a cache hit.
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (4, 'kegg', 'K00004')")
    # A fifth candidate, also significant but weaker than (1,2)'s r=0.9 --
    # proves results come back sorted by |r| descending, not in
    # catalog-id/insertion order.
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (5, 'kegg', 'K00005')")
    samples = [f"s{i:02d}" for i in range(1, 13)]  # 12 samples, above the 10-point floor
    for i, sample in enumerate(samples):
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('taxonomy', ?, 'Bacteria', ?)",
            (sample, 10.0 + i),
        )
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg', ?, 'K00004', ?)",
            (sample, 7.0),  # constant
        )

    # Pair (1,2): strong, clearly-significant correlation, lag=3 samples.
    conn.execute(
        "INSERT INTO correlations_cache "
        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs) "
        "VALUES (1, 2, 0.9, 'egc', 'raw_pearson', 3, 0.0001, 12)"
    )
    # Pair (1,3): weak, not significant.
    conn.execute(
        "INSERT INTO correlations_cache "
        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs) "
        "VALUES (1, 3, 0.1, 'egc', 'raw_pearson', 0, 0.9, 12)"
    )
    # Pair (1,5): significant but weaker than (1,2) -- inserted with a
    # HIGHER catalog id than (1,2) so catalog-id order and |r| order
    # disagree, making a sort-order regression actually visible.
    conn.execute(
        "INSERT INTO correlations_cache "
        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs) "
        "VALUES (1, 5, 0.5, 'egc', 'raw_pearson', 0, 0.001, 12)"
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(correlation_sql, "SQLITE_DB_PATH", db_path)

    app = FastAPI()
    app.include_router(correlation_sql.router)
    return TestClient(app)


class TestCorrelationEndpoint:
    def test_returns_cached_pair(self, client):
        response = client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 2, "metric": "egc", "method": "raw_pearson"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["r"] == 0.9
        assert body["p"] == 0.0001

    # Same allowlist-up-front validation as the family endpoint, for this
    # single-pair endpoint too.

    def test_invalid_method_returns_400(self, client):
        response = client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 2, "metric": "egc", "method": "not_a_real_method"},
        )
        assert response.status_code == 400

    def test_invalid_metric_returns_400(self, client):
        response = client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 2, "metric": "not_a_real_metric", "method": "raw_pearson"},
        )
        assert response.status_code == 400


@pytest.fixture
def circular_shift_client(tmp_path, monkeypatch):
    # Deliberately its own isolated db, not the shared `client` fixture
    # above -- adding a real, strongly-correlated candidate there once
    # broke 4 unrelated TestCorrelationFamilyEndpoint tests, which
    # enumerate every kegg candidate and don't expect a new one to show up
    # in their significant-results/sort-order/limit assertions.
    db_path = str(tmp_path / "test_circular_shift.db")
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)

    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (1, 'taxonomy', 'Bacteria')")
    # id 2: catalog row only, no series data -- exercises a genuine
    # cache-miss compute against empty data (must return null, not crash
    # or accidentally reuse an unrelated cached row).
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (2, 'kegg', 'K00002')")
    # id 4: constant across every sample -- the NaN guard must hold for
    # circular_shift too.
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (4, 'kegg', 'K00004')")
    # id 6: real, strongly-correlated data -- the positive-path case.
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (6, 'kegg', 'K00006')")

    # 30, not 12 -- max|lag|=6 leaves no valid interior shift at n=12 (see
    # test_correlation_math.py's TestCircularShiftPvalue), which would make
    # every p-value in this fixture a trivial, uninformative 1.0 regardless
    # of how strong the real relationship is. 30 gives 5 valid shifts,
    # enough for this fixture's near-noiseless copy to demonstrate a real
    # low p.
    samples = [f"s{i:02d}" for i in range(1, 31)]
    for i, sample in enumerate(samples):
        wobble = 3.0 * ((i % 3) - 1)  # non-monotonic, avoids the shift/re-lag self-similarity pitfall
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('taxonomy', ?, 'Bacteria', ?)",
            (sample, 10.0 + i + wobble),
        )
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg', ?, 'K00004', ?)",
            (sample, 7.0),  # constant
        )
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg', ?, 'K00006', ?)",
            (sample, 10.0 + i + wobble + 0.05),  # near-noiseless copy of Bacteria's series
        )

    # A pre-seeded 'raw_pearson' row for (1, 2), to prove circular_shift
    # against the same pair doesn't collide with a different method's
    # cached row (method is part of the UNIQUE constraint).
    conn.execute(
        "INSERT INTO correlations_cache "
        "(catalog_id_a, catalog_id_b, r, metric, method, lag_samples, p_value, n_pairs) "
        "VALUES (1, 2, 0.9, 'egc', 'raw_pearson', 3, 0.0001, 12)"
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(correlation_sql, "SQLITE_DB_PATH", db_path)

    app = FastAPI()
    app.include_router(correlation_sql.router)
    return TestClient(app)


class TestCorrelationEndpointCircularShift:
    # End-to-end coverage for method="circular_shift" through the real
    # HTTP layer and cache-miss compute path -- the pure math is covered in
    # test_correlation_math.py; this confirms it's wired up and reachable,
    # and that the constant-candidate NaN guard holds for it too.

    def test_computes_a_real_result_end_to_end(self, circular_shift_client):
        response = circular_shift_client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 6, "metric": "egc", "method": "circular_shift"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body is not None
        assert body["r"] > 0.9  # near-noiseless copy, ids 1 and 6 -- see fixture
        # With 30 samples (5 valid shifts under the 2*max_lag exclusion
        # margin, see _circular_shift_pvalue), a near-noiseless copy should
        # hit the real permutation floor, (1+0)/(1+5) = 1/6 -- not just "some
        # value between 0 and 1", which would also pass if p were always
        # the 1.0 no-valid-shift default.
        assert body["p"] == pytest.approx(1 / 6)
        assert body["n_pairs"] == 24  # best lag=6 trims the 30-sample window to 24
        # This p IS the resolution limit --
        # end-to-end confirmation the flag reaches the HTTP response, not
        # just the internal dict _get_or_compute_correlation returns.
        assert body["at_p_floor"] is True

    def test_non_circular_shift_result_reports_floor_as_not_applicable(self, client):
        # at_p_floor only ever means something for circular_shift's
        # permutation test -- every other method must report None
        # (not False, which would wrongly imply "checked, and no"),
        # through the real HTTP response.
        response = client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 2, "metric": "egc", "method": "raw_pearson"},
        )

        assert response.json()["at_p_floor"] is None

    def test_result_is_cached_and_a_repeat_request_is_a_hit(self, circular_shift_client):
        first = circular_shift_client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 6, "metric": "egc", "method": "circular_shift"},
        ).json()
        second = circular_shift_client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 6, "metric": "egc", "method": "circular_shift"},
        ).json()

        assert first == second  # bit-identical -- second call read the cached row, didn't recompute

    def test_does_not_collide_with_a_different_methods_cached_pair(self, circular_shift_client):
        # Same (catalog_id_a, catalog_id_b, metric) as the pre-seeded
        # 'raw_pearson' row for (1, 2) in the fixture, but a different
        # method -- method is part of the cache key, so this must be its
        # own independent cache-miss compute, not accidentally returning
        # the raw_pearson row's r=0.9/p=0.0001.
        response = circular_shift_client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 2, "metric": "egc", "method": "circular_shift"},
        )

        assert response.status_code == 200
        # id 2 (K00002) has no real annotation_series rows in this fixture
        # (only a pre-seeded cache row under 'raw_pearson') -- a genuine
        # cache-miss compute against empty series data correctly finds
        # nothing scoreable and returns null, not the unrelated cached row.
        assert response.json() is None

    def test_constant_candidate_is_omitted_here_too(self, circular_shift_client):
        # The same constant-candidate protection
        # must hold for circular_shift, not just the other 3 methods --
        # id 4 (K00004) is constant across every sample in the fixture.
        response = circular_shift_client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 4, "metric": "egc", "method": "circular_shift"},
        )

        assert response.status_code == 200
        assert response.json() is None


class TestCorrelationFamilyEndpoint:
    def test_invalid_target_source_returns_400(self, client):
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "not_a_real_source", "metric": "egc", "method": "raw_pearson",
            },
        )

        assert response.status_code == 400

    # A bad method/metric must 400 before any work starts, not 500 deep
    # inside the per-candidate scoring loop after resolving the whole
    # family (and, for circular_shift, running the full prescreening pass).
    # Uses a real reference that genuinely has family candidates (not an
    # empty or unknown one), so a slow/wasted-work path would actually be
    # reachable if validation didn't happen first.

    def test_invalid_method_returns_400_before_any_scoring(self, client):
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "not_a_real_method",
            },
        )

        assert response.status_code == 400

    def test_invalid_metric_returns_400_before_any_scoring(self, client):
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "not_a_real_metric", "method": "raw_pearson",
            },
        )

        assert response.status_code == 400

    def test_unknown_ref_returns_404(self, client):
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "NotReal",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
            },
        )

        assert response.status_code == 404

    def test_filters_to_significant_candidates_only(self, client):
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
            },
        )

        assert response.status_code == 200
        body = response.json()
        assert body["prescreened"] is False  # only 4 candidates, well under the screen threshold
        catalog_ids = {entry["catalog_id"] for entry in body["results"]}

        assert catalog_ids == {2, 5}  # candidate 3's q lands well above 0.05

    def test_significant_entry_carries_the_expected_shape(self, client):
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
            },
        )

        entry = response.json()["results"][0]
        assert entry["r"] == 0.9
        assert entry["q"] < 0.05
        assert entry["name"] == "Nitrogenase"
        assert entry["depth"] == 3
        assert entry["lag_samples"] == 3
        assert entry["lag_hours"] == 12  # 3 samples * LAG_HOURS_PER_SAMPLE (4)

    def test_results_are_sorted_by_absolute_r_descending(self, client):
        # (1,5) was inserted into correlations_cache AFTER (1,2), with
        # a higher catalog id but a weaker |r| (0.5 vs 0.9) -- catalog-id
        # order and |r| order disagree here on purpose, so this only
        # passes if the endpoint actually sorts rather than returning
        # database order.
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
            },
        )

        catalog_ids_in_order = [entry["catalog_id"] for entry in response.json()["results"]]
        assert catalog_ids_in_order == [2, 5]

    def test_limit_caps_the_returned_list_to_the_strongest_matches(self, client):
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
                "limit": 1,
            },
        )

        results = response.json()["results"]
        assert len(results) == 1
        assert results[0]["catalog_id"] == 2  # the stronger of the two significant matches

    def test_significant_count_reflects_the_true_total_even_when_limit_cuts_it_shorter(self, client):
        # A request that caps `results` at
        # 1 must still disclose that there were really 2 significant
        # candidates -- otherwise "1 result" and "1 of 2,847 results" render
        # identically and a real cap looks like the whole answer.
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
                "limit": 1,
            },
        )

        body = response.json()
        assert len(body["results"]) == 1
        assert body["significant_count"] == 2  # pairs (1,2) and (1,5) -- (1,3) isn't significant

    def test_constant_candidate_is_omitted_not_a_crash(self, client):
        # Candidate 4 (K00004) is constant across every sample -- must come
        # back 200 with candidate 4 simply absent from the results, not a
        # 500 from a NaN -> IntegrityError -> None-subscript crash chain.
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
            },
        )

        assert response.status_code == 200
        catalog_ids = {entry["catalog_id"] for entry in response.json()["results"]}
        assert 4 not in catalog_ids


class TestCorrelationFamilyLock:
    # Confirmed happening in practice, not just theoretical (session that
    # added this): after ~2 auto-retries on a real circular_shift family,
    # the server process had 8 threads with real accumulated CPU time, and
    # the per-candidate rate had roughly doubled (7.5s/candidate measured
    # live vs. 3.6s/candidate in isolation) -- concurrent requests for the
    # SAME family were each redundantly recomputing the same still-
    # uncached candidates in parallel instead of cooperating on the cache.

    def test_concurrent_requests_for_the_same_family_do_not_duplicate_work(self, circular_shift_client, monkeypatch):
        # Of this fixture's 3 candidates, K00002/K00004 return None (no
        # series data / constant) and are NEVER cached -- so every
        # request recomputes them regardless of any lock (2 unavoidable
        # score_pair calls each, x2 concurrent requests = 4 total). Only
        # K00006 produces a real score that gets cached -- the lock's
        # whole point is that this ONE candidate must be genuinely
        # computed only once across both requests, not once each.
        # Expected total with the lock working: 4 (unavoidable) + 1
        # (K00006, deduplicated) = 5. Without the lock: 4 + 2 = 6.
        call_count = {"n": 0}
        real_score_pair = correlation_sql.score_pair

        def counting_slow_score_pair(ref, cand, method):
            # Small real sleep (not a mock) so a second thread genuinely
            # has a window to start its own redundant computation if the
            # lock isn't actually serializing them.
            time.sleep(0.05)
            call_count["n"] += 1
            return real_score_pair(ref, cand, method)

        monkeypatch.setattr(correlation_sql, "score_pair", counting_slow_score_pair)

        results = []
        def make_request():
            resp = circular_shift_client.get(
                "/correlations/family",
                params={
                    "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                    "target_source": "kegg", "metric": "egc", "method": "circular_shift",
                },
            )
            results.append(resp)

        t1 = threading.Thread(target=make_request)
        t2 = threading.Thread(target=make_request)
        t1.start()
        time.sleep(0.02)  # let t1 reach (and acquire) the lock first, deterministically
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

        assert len(results) == 2
        for resp in results:
            assert resp.status_code == 200

        assert call_count["n"] == 5, (
            f"score_pair called {call_count['n']} times, expected exactly 5 "
            "(4 unavoidable for the 2 never-cached candidates x 2 requests, "
            "+ 1 for K00006 -- if this is 6, the lock let both requests "
            "redundantly compute K00006 instead of the second one waiting "
            "and then getting a cache hit)"
        )


@pytest.fixture
def prescreen_client(tmp_path, monkeypatch):
    # Own isolated db, same reasoning as circular_shift_client above: real
    # series data for candidates of genuinely different correlation
    # strength, needed to prove the fast pre-screen actually ranks by |r|
    # rather than just passing everything through.
    db_path = str(tmp_path / "test_prescreen.db")
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)

    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (1, 'taxonomy', 'Bacteria')")
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (2, 'kegg', 'K00002')")  # strong
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (3, 'kegg', 'K00003')")  # weak/none

    # 50, not 12 -- same reasoning as circular_shift_client above, but
    # these prescreen tests additionally gate on the q<0.05 SIGNIFICANCE of
    # the surviving candidate after circular_shift scores it, not just on
    # which candidate the fast pre-screen keeps. With the 2*max_lag
    # exclusion margin, n=12 has no valid shift and n=40 only reaches
    # p=0.0625; n=50 gives this fixture's near-noiseless copy p=0.038, the
    # smallest n (in steps of 10) that clears the gate.
    samples = [f"s{i:02d}" for i in range(1, 51)]
    for i, sample in enumerate(samples):
        wobble = 3.0 * ((i % 3) - 1)
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('taxonomy', ?, 'Bacteria', ?)",
            (sample, 10.0 + i + wobble),
        )
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg', ?, 'K00002', ?)",
            (sample, 10.0 + i + wobble + 0.05),  # near-noiseless copy -- strong |r|
        )
        # Deliberately unrelated to the reference's wobble pattern -- weak |r|.
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg', ?, 'K00003', ?)",
            (sample, 5.0 + ((i * 7) % 5)),
        )
    conn.commit()
    conn.close()

    monkeypatch.setattr(correlation_sql, "SQLITE_DB_PATH", db_path)

    app = FastAPI()
    app.include_router(correlation_sql.router)
    return TestClient(app)


@pytest.fixture
def prescreen_n_aware_client(tmp_path, monkeypatch):
    # The real failure case -- a SPARSE
    # candidate at a near-perfect raw |r| must NOT beat a FULLY-SAMPLED
    # candidate at a real, substantial |r| just because raw |r| ignores
    # how much data backs each one. Exact construction verified directly
    # against the real _spearman_at_lags (not hand-derived): candidate 4
    # (only 10 of 50 samples real, a monotonic copy of ref over just
    # those 10) scores r=1.0 at n=10; candidate 5 (all 50 samples real, a
    # 15-swap partial shuffle of ref's own values, seed=0) scores
    # r=0.4840816... at n=50. Raw |r| ranks 4 > 5 (1.0 vs 0.484); the
    # Fisher-z-style n-aware key ranks 5 > 4 (0.484*sqrt(47)=3.32 vs
    # 1.0*sqrt(7)=2.65) -- the exact reversal this fix exists to produce.
    db_path = str(tmp_path / "test_prescreen_n_aware.db")
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)

    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (1, 'taxonomy', 'Bacteria')")
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (4, 'kegg', 'K00004')")  # sparse, high raw |r|
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (5, 'kegg', 'K00005')")  # dense, moderate raw |r|

    n = 50
    ref_values = [10.0 + i for i in range(n)]
    samples = [f"s{i:02d}" for i in range(1, n + 1)]
    for i, sample in enumerate(samples):
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('taxonomy', ?, 'Bacteria', ?)",
            (sample, ref_values[i]),
        )
        if i < 10:
            # Candidate 4: only the first 10 samples get a row at all --
            # the rest are genuinely absent (None via load_vector), not
            # zero (core_scoring treats <=0 the same as missing).
            conn.execute(
                "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg', ?, 'K00004', ?)",
                (sample, float(i + 1)),  # monotonic over just these 10 -- r=1.0 at n=10
            )

    # Candidate 5: every sample real, values = a 15-swap partial shuffle
    # of ref's own value set (deterministic, seed=0) -- a real, moderate
    # relationship at full n=50, not a hand-picked r.
    rng = random.Random(0)
    cand5_values = list(ref_values)
    idxs = list(range(n))
    for _ in range(15):
        swap_i, swap_j = rng.sample(idxs, 2)
        cand5_values[swap_i], cand5_values[swap_j] = cand5_values[swap_j], cand5_values[swap_i]
    for i, sample in enumerate(samples):
        conn.execute(
            "INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg', ?, 'K00005', ?)",
            (sample, cand5_values[i]),
        )

    conn.commit()
    conn.close()

    monkeypatch.setattr(correlation_sql, "SQLITE_DB_PATH", db_path)

    app = FastAPI()
    app.include_router(correlation_sql.router)
    return TestClient(app)


# _family_locks would otherwise grow by one entry per distinct family ever
# requested, for the life of the process. These test
# _get_family_lock/_evict_idle_family_locks
# directly (no HTTP/DB needed), isolated from the real module-level dict
# via monkeypatch so they can't interfere with each other or with
# TestCorrelationFamilyLock above.
class TestFamilyLockEviction:
    @pytest.fixture(autouse=True)
    def _isolated_locks(self, monkeypatch):
        monkeypatch.setattr(correlation_sql, "_family_locks", {})

    def test_same_key_returns_the_same_lock_object(self):
        key = ("taxonomy", "kegg", "egc", "circular_shift")
        first = correlation_sql._get_family_lock(key)
        second = correlation_sql._get_family_lock(key)
        assert first is second

    def test_different_keys_return_different_locks(self):
        lock_a = correlation_sql._get_family_lock(("taxonomy", "kegg", "egc", "circular_shift"))
        lock_b = correlation_sql._get_family_lock(("taxonomy", "cog", "egc", "circular_shift"))
        assert lock_a is not lock_b

    def test_stays_under_the_cap_no_eviction_needed(self, monkeypatch):
        monkeypatch.setattr(correlation_sql, "_FAMILY_LOCKS_MAX_ENTRIES", 10)
        for i in range(5):
            correlation_sql._get_family_lock((f"key{i}",))
        assert len(correlation_sql._family_locks) == 5

    def test_evicts_idle_unlocked_entries_once_over_the_cap(self, monkeypatch):
        monkeypatch.setattr(correlation_sql, "_FAMILY_LOCKS_MAX_ENTRIES", 2)
        monkeypatch.setattr(correlation_sql, "_FAMILY_LOCKS_IDLE_SECONDS", 100)
        now = time.time()
        # Two old, idle, unlocked entries, seeded directly (bypassing
        # _get_family_lock so their timestamp is really old, not "now").
        correlation_sql._family_locks[("old1",)] = (threading.Lock(), now - 200)
        correlation_sql._family_locks[("old2",)] = (threading.Lock(), now - 200)

        # A third request pushes the dict over the cap, triggering eviction.
        correlation_sql._get_family_lock(("new",))

        assert ("old1",) not in correlation_sql._family_locks
        assert ("old2",) not in correlation_sql._family_locks
        assert ("new",) in correlation_sql._family_locks

    def test_never_evicts_a_currently_held_lock_even_if_idle(self, monkeypatch):
        # The actual point of this fix: an idle TIMESTAMP alone must never
        # be enough to evict a lock a request might still be relying on.
        # If it were replaced by a second, different Lock object for the
        # same key, a concurrent request for the same family could
        # acquire that NEW lock while the first still holds the OLD one --
        # both running at once, exactly the redundant-work race this lock
        # exists to prevent.
        monkeypatch.setattr(correlation_sql, "_FAMILY_LOCKS_MAX_ENTRIES", 1)
        monkeypatch.setattr(correlation_sql, "_FAMILY_LOCKS_IDLE_SECONDS", 100)
        now = time.time()
        held_lock = threading.Lock()
        held_lock.acquire()
        correlation_sql._family_locks[("held",)] = (held_lock, now - 200)

        correlation_sql._get_family_lock(("new",))

        assert ("held",) in correlation_sql._family_locks
        assert correlation_sql._family_locks[("held",)][0] is held_lock

    def test_does_not_evict_an_entry_that_is_idle_but_not_yet_past_the_threshold(self, monkeypatch):
        monkeypatch.setattr(correlation_sql, "_FAMILY_LOCKS_MAX_ENTRIES", 1)
        monkeypatch.setattr(correlation_sql, "_FAMILY_LOCKS_IDLE_SECONDS", 100)
        now = time.time()
        correlation_sql._family_locks[("recent",)] = (threading.Lock(), now - 10)  # well under the 100s threshold

        correlation_sql._get_family_lock(("new",))

        assert ("recent",) in correlation_sql._family_locks

    def test_requesting_a_lock_refreshes_its_last_used_time(self, monkeypatch):
        """A family re-requested right before it would otherwise be
        evicted must not be evicted out from under the request that's
        about to use it."""
        monkeypatch.setattr(correlation_sql, "_FAMILY_LOCKS_MAX_ENTRIES", 1)
        monkeypatch.setattr(correlation_sql, "_FAMILY_LOCKS_IDLE_SECONDS", 100)
        now = time.time()
        key = ("almost-stale",)
        correlation_sql._family_locks[key] = (threading.Lock(), now - 99)  # 1s from eligible

        correlation_sql._get_family_lock(key)  # refreshes last_requested_at to "now"
        correlation_sql._get_family_lock(("new",))  # pushes over cap, triggers eviction check

        assert key in correlation_sql._family_locks  # just refreshed -- must survive


class TestCorrelationFamilyPrescreen:
    # circular_shift is ~120x slower per candidate than a parametric
    # method (measured directly against the real db), so a real family
    # (thousands of candidates) is real work if scored in full.
    # correlation_family_endpoint pre-filters to the strongest
    # CIRCULAR_SHIFT_SCREEN_TOP_N candidates by a fast method first, then
    # only runs the expensive permutation test on those -- monkeypatched
    # down to 1 here so a 2-real-candidate fixture can exercise the real
    # ranking logic without needing hundreds of rows.

    def test_small_family_is_not_prescreened(self, prescreen_client, monkeypatch):
        monkeypatch.setattr(correlation_sql, "CIRCULAR_SHIFT_SCREEN_TOP_N", 200)
        response = prescreen_client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "circular_shift",
            },
        )
        body = response.json()
        assert body["prescreened"] is False
        assert body["prescreen_pool_size"] is None
        assert body["prescreen_top_n"] is None

    def test_non_circular_shift_methods_are_never_prescreened(self, prescreen_client, monkeypatch):
        # Prescreening exists specifically because circular_shift is slow --
        # a fast parametric method never needs it, regardless of family size.
        monkeypatch.setattr(correlation_sql, "CIRCULAR_SHIFT_SCREEN_TOP_N", 1)
        response = prescreen_client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
            },
        )
        body = response.json()
        assert body["prescreened"] is False

    def test_large_family_is_prescreened_and_discloses_pool_size(self, prescreen_client, monkeypatch):
        monkeypatch.setattr(correlation_sql, "CIRCULAR_SHIFT_SCREEN_TOP_N", 1)
        response = prescreen_client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "circular_shift",
            },
        )
        body = response.json()
        assert body["prescreened"] is True
        assert body["prescreen_pool_size"] == 2  # candidates 2 and 3
        assert body["prescreen_top_n"] == 1

    def test_prescreen_keeps_the_stronger_candidate_and_drops_the_weaker_one(self, prescreen_client, monkeypatch):
        # The actual point of prescreening: candidate 2 (near-noiseless
        # copy of the reference, strong |r|) must survive into the
        # expensive circular_shift pass; candidate 3 (unrelated pattern,
        # weak |r|) must be screened out before ever reaching it -- not
        # just "fewer results", specifically the RIGHT one kept.
        monkeypatch.setattr(correlation_sql, "CIRCULAR_SHIFT_SCREEN_TOP_N", 1)
        response = prescreen_client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "circular_shift",
            },
        )
        body = response.json()
        catalog_ids = {entry["catalog_id"] for entry in body["results"]}
        assert catalog_ids == {2}
        assert 3 not in catalog_ids

    def test_prescreen_keeps_the_fully_sampled_candidate_over_the_sparse_one(
        self, prescreen_n_aware_client, monkeypatch,
    ):
        # Candidate 4
        # (sparse, n=10, raw |r|=1.0) must NOT survive prescreening over
        # candidate 5 (fully-sampled, n=50, raw |r|=0.48) just because its
        # raw |r| looks stronger. Spies on which candidates reach the
        # EXPENSIVE circular_shift scoring step directly, rather than
        # inferring prescreen selection from final significance (which
        # depends on downstream BH/floor behavior this test isn't about).
        monkeypatch.setattr(correlation_sql, "CIRCULAR_SHIFT_SCREEN_TOP_N", 1)

        real_get_or_compute = correlation_sql._get_or_compute_correlation
        circular_shift_candidate_ids = []

        def spy(conn, ref_id, cand_id, metric, method, **kwargs):
            if method == "circular_shift":
                circular_shift_candidate_ids.append(cand_id)
            return real_get_or_compute(conn, ref_id, cand_id, metric, method, **kwargs)

        monkeypatch.setattr(correlation_sql, "_get_or_compute_correlation", spy)

        prescreen_n_aware_client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "circular_shift",
            },
        )

        assert circular_shift_candidate_ids == [5]  # NOT 4, despite 4's higher raw |r|
