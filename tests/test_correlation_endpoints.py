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
import sqlite3
import sys

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

    # CR4 regression: a fourth candidate, cache-MISS, whose value never
    # changes across samples -- pearsonr returns NaN for it, which used to
    # crash the whole family request instead of just omitting this one
    # candidate. Deliberately not pre-seeded into correlations_cache, so
    # scoring it exercises the real compute-on-miss path, not a cache hit.
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (4, 'kegg', 'K00004')")
    # CR5 regression: a fifth candidate, also significant but weaker than
    # (1,2)'s r=0.9 -- used to prove results come back sorted by |r|
    # descending, not in catalog-id/insertion order.
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
    # id 4: constant across every sample -- CR4 x CR2 composition check.
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (4, 'kegg', 'K00004')")
    # id 6: real, strongly-correlated data -- the positive-path case.
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (6, 'kegg', 'K00006')")

    samples = [f"s{i:02d}" for i in range(1, 13)]  # 12 samples, above the 10-point floor
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
    # CR2 (docs/AUDIT.md): end-to-end coverage for method="circular_shift"
    # through the real HTTP layer and cache-miss compute path -- the pure
    # math is already covered in test_correlation_math.py, this confirms
    # it's actually wired up and reachable, and composes correctly with
    # CR4 (the constant-candidate crash fix), not just in isolation.

    def test_computes_a_real_result_end_to_end(self, circular_shift_client):
        response = circular_shift_client.get(
            "/correlation",
            params={"catalog_id_a": 1, "catalog_id_b": 6, "metric": "egc", "method": "circular_shift"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body is not None
        assert body["r"] > 0.9  # near-noiseless copy, ids 1 and 6 -- see fixture
        assert 0.0 <= body["p"] <= 1.0
        assert body["n_pairs"] == 12

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
        # CR4 x CR2 composition: the same constant-candidate protection
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
        catalog_ids = {entry["catalog_id"] for entry in body}

        assert catalog_ids == {2, 5}  # candidate 3's q lands well above 0.05

    def test_significant_entry_carries_the_expected_shape(self, client):
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
            },
        )

        entry = response.json()[0]
        assert entry["r"] == 0.9
        assert entry["q"] < 0.05
        assert entry["name"] == "Nitrogenase"
        assert entry["depth"] == 3
        assert entry["lag_samples"] == 3
        assert entry["lag_hours"] == 12  # 3 samples * LAG_HOURS_PER_SAMPLE (4)

    def test_results_are_sorted_by_absolute_r_descending(self, client):
        # CR5: (1,5) was inserted into correlations_cache AFTER (1,2), with
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

        catalog_ids_in_order = [entry["catalog_id"] for entry in response.json()]
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

        body = response.json()
        assert len(body) == 1
        assert body[0]["catalog_id"] == 2  # the stronger of the two significant matches

    def test_constant_candidate_is_omitted_not_a_crash(self, client):
        # CR4: candidate 4 (K00004) is constant across every sample -- must
        # come back 200 with candidate 4 simply absent from the results,
        # not a 500 from the old NaN -> IntegrityError -> None-subscript
        # crash chain.
        response = client.get(
            "/correlations/family",
            params={
                "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
                "target_source": "kegg", "metric": "egc", "method": "raw_pearson",
            },
        )

        assert response.status_code == 200
        catalog_ids = {entry["catalog_id"] for entry in response.json()}
        assert 4 not in catalog_ids
