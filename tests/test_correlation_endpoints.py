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
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id, name) VALUES (2, 'kegg', 'K00002', 'Nitrogenase')")
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (3, 'kegg', 'K00003')")

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


class TestCorrelationFamilyEndpoint:
    def test_invalid_target_source_returns_400(self, client):
        response = client.get(
            "/correlations/family",
            params={"ref_catalog_id": 1, "target_source": "not_a_real_source", "metric": "egc", "method": "raw_pearson"},
        )

        assert response.status_code == 400

    def test_filters_to_significant_candidates_only(self, client):
        response = client.get(
            "/correlations/family",
            params={"ref_catalog_id": 1, "target_source": "kegg", "metric": "egc", "method": "raw_pearson"},
        )

        assert response.status_code == 200
        body = response.json()
        catalog_ids = {entry["catalog_id"] for entry in body}

        assert catalog_ids == {2}  # candidate 3's q lands well above 0.05

    def test_significant_entry_carries_the_expected_shape(self, client):
        response = client.get(
            "/correlations/family",
            params={"ref_catalog_id": 1, "target_source": "kegg", "metric": "egc", "method": "raw_pearson"},
        )

        entry = response.json()[0]
        assert entry["r"] == 0.9
        assert entry["q"] < 0.05
        assert entry["name"] == "Nitrogenase"
        assert entry["lag_samples"] == 3
        assert entry["lag_hours"] == 12  # 3 samples * LAG_HOURS_PER_SAMPLE (4)
