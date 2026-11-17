"""
/correlations/family scores every not-yet-saved candidate with the
vectorised scorer in batches, saving each batch's scores and unscorable
pairs in one commit. These tests pin what that must do: the same answers
score_pair gives, every candidate saved once, nothing re-scored on a
second request, progress kept if a later batch fails, and lags oriented to
the reference whichever id is higher.
"""
import math
import os
import sqlite3
import sys
import warnings

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

import api.correlation_sql as correlation_sql
from api.correlation_sql import CORRELATION_METHOD_VERSION, score_pair
from scripts.create_sql_schema import SCHEMA

N_SAMPLES = 40
SAMPLES = [f"s{i:02d}" for i in range(1, N_SAMPLES + 1)]
REF_ID = 10   # higher than every candidate id, so stored lags are flipped


def _wave(i, shift=0):
    return 10 + 5 * math.sin((i + shift) / 3.0)


# catalog id -> (annotation_id, values by sample index, or None for missing)
CANDIDATES = {
    1: ("K00001", [_wave(i, 2) + 0.01 * (i % 3) for i in range(N_SAMPLES)]),    # peaks 2 samples earlier
    2: ("K00002", [5 + ((i * 7) % 5) for i in range(N_SAMPLES)]),               # unrelated
    3: ("K00003", [7.0] * N_SAMPLES),                                           # constant
    4: ("K00004", [_wave(i) if i < 6 else None for i in range(N_SAMPLES)]),      # 6 points
    5: ("K00005", [30 - _wave(i) for i in range(N_SAMPLES)]),                    # falls as ref rises
    6: ("K00006", [None if i % 4 == 0 else _wave(i, -1) for i in range(N_SAMPLES)]),
    7: ("K00007", [_wave(i) * 2 for i in range(N_SAMPLES)]),                     # same shape
}
REF_VALUES = [_wave(i) for i in range(N_SAMPLES)]
SCORABLE = {1, 2, 5, 6, 7}


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    path = str(tmp_path / "family.db")
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (?, 'taxonomy', 'Bacteria')", (REF_ID,))
    for sample, value in zip(SAMPLES, REF_VALUES):
        conn.execute("INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('taxonomy', ?, 'Bacteria', ?)",
                     (sample, value))
    for cid, (aid, values) in CANDIDATES.items():
        conn.execute("INSERT INTO annotation_catalog (id, source, annotation_id) VALUES (?, 'kegg', ?)", (cid, aid))
        for sample, value in zip(SAMPLES, values):
            if value is not None:
                conn.execute("INSERT INTO annotation_series (source, sample, annotation_id, egc) VALUES ('kegg', ?, ?, ?)",
                             (sample, aid, value))
    conn.commit()
    conn.close()
    monkeypatch.setattr(correlation_sql, "SQLITE_DB_PATH", path)
    return path


@pytest.fixture
def client(db_path):
    app = FastAPI()
    app.include_router(correlation_sql.router)
    return TestClient(app)


def _family(client, method="spearman"):
    return client.get("/correlations/family", params={
        "ref_source": "taxonomy", "ref_annotation_id": "Bacteria",
        "target_source": "kegg", "metric": "egc", "method": method, "limit": 500,
    })


def _rows(db_path, table):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(f"SELECT * FROM {table} ORDER BY catalog_id_a, catalog_id_b").fetchall()
    finally:
        conn.close()


def _spy_loaded_ids(monkeypatch):
    loaded = []
    real = correlation_sql.load_family_matrix

    def spy(conn, source, annotation_ids, sample_order, metric):
        loaded.append(list(annotation_ids))
        return real(conn, source, annotation_ids, sample_order, metric)

    monkeypatch.setattr(correlation_sql, "load_family_matrix", spy)
    return loaded


class TestSameAnswersAsScorePair:
    @pytest.mark.parametrize("method", ["raw_pearson", "log_pearson", "spearman"])
    def test_every_scored_candidate_matches_score_pair(self, client, method):
        body = _family(client, method).json()
        by_id = {entry["catalog_id"]: entry for entry in body["results"]}
        assert set(by_id) == SCORABLE
        for cid in SCORABLE:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                r, p, lag, n_pairs, _ = score_pair(REF_VALUES, CANDIDATES[cid][1], method)
            entry = by_id[cid]
            assert entry["r"] == pytest.approx(r, abs=1e-12)
            assert entry["p"] == pytest.approx(p, rel=1e-9)
            assert (entry["lag_samples"], entry["n_pairs"]) == (lag, n_pairs)
        assert body["tested_count"] == len(SCORABLE)
        assert body["untested_count"] == len(CANDIDATES) - len(SCORABLE)

    def test_candidate_peaking_earlier_leads_although_the_reference_has_the_higher_id(self, client, db_path):
        body = _family(client).json()
        entry = next(e for e in body["results"] if e["catalog_id"] == 1)
        assert entry["lag_samples"] == 2
        # Stored relative to the lower id (the candidate), so flipped ...
        stored_lag = [row[6] for row in _rows(db_path, "correlations_cache") if row[1] == 1 and row[5] == "spearman"]
        assert stored_lag == [-2]
        # ... and the single-pair route, reading that row, agrees.
        single = client.get("/correlation", params={"catalog_id_a": REF_ID, "catalog_id_b": 1,
                                                    "metric": "egc", "method": "spearman"}).json()
        assert single["lag_samples"] == 2


class TestSaving:
    def test_cold_request_saves_every_candidate_once(self, client, db_path):
        _family(client)

        cache = _rows(db_path, "correlations_cache")
        unscored = _rows(db_path, "correlations_unscored")
        assert sorted(row[1] for row in cache) == sorted(SCORABLE)
        assert all(row[2] == REF_ID and row[10] == CORRELATION_METHOD_VERSION for row in cache)
        reasons = {row[1]: (row[6], row[7]) for row in unscored}
        assert reasons == {3: ("no_variation", N_SAMPLES), 4: ("too_few_points", 6)}

    def test_second_request_loads_and_scores_nothing(self, client, monkeypatch):
        first = _family(client).json()
        loaded = _spy_loaded_ids(monkeypatch)

        second = _family(client).json()

        assert loaded == []
        assert second == first

    def test_one_commit_per_batch(self, client, monkeypatch):
        monkeypatch.setattr(correlation_sql, "FAMILY_BATCH_SIZE", 3)
        saves = []
        real = correlation_sql._save_batch

        def spy(conn, score_rows, unscored_rows):
            saves.append(len(score_rows) + len(unscored_rows))
            return real(conn, score_rows, unscored_rows)

        monkeypatch.setattr(correlation_sql, "_save_batch", spy)
        _family(client)

        assert saves == [3, 3, 1]   # 7 candidates in batches of 3

    def test_a_failed_batch_keeps_the_earlier_batches(self, client, db_path, monkeypatch):
        monkeypatch.setattr(correlation_sql, "FAMILY_BATCH_SIZE", 3)
        real = correlation_sql.score_family_checked
        calls = {"n": 0}

        def fails_on_second_batch(ref, table, method):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("server stopped mid-family")
            return real(ref, table, method)

        monkeypatch.setattr(correlation_sql, "score_family_checked", fails_on_second_batch)
        with pytest.raises(RuntimeError):
            _family(client)
        saved_after_failure = len(_rows(db_path, "correlations_cache")) + len(_rows(db_path, "correlations_unscored"))
        assert saved_after_failure == 3

        monkeypatch.setattr(correlation_sql, "score_family_checked", real)
        loaded = _spy_loaded_ids(monkeypatch)
        body = _family(client).json()

        assert sum(len(ids) for ids in loaded) == 4   # only the 4 not saved before
        assert body["tested_count"] + body["untested_count"] == len(CANDIDATES)

    def test_a_non_finite_score_is_never_saved(self, client, db_path, monkeypatch):
        real = correlation_sql.score_family_checked

        def nan_for_first_row(ref, table, method):
            result = real(ref, table, method)
            result["r"][0] = np.nan
            return result

        monkeypatch.setattr(correlation_sql, "score_family_checked", nan_for_first_row)
        body = _family(client).json()

        assert 1 not in {row[1] for row in _rows(db_path, "correlations_cache")}
        assert 1 not in {entry["catalog_id"] for entry in body["results"]}

    def test_a_locked_database_still_returns_results(self, client, db_path, monkeypatch):
        real_connect = correlation_sql._connect

        class LockedOnWrite:
            def __init__(self, conn):
                self._real = conn

            def executemany(self, sql, rows):
                raise sqlite3.OperationalError("database is locked")

            def __getattr__(self, name):
                return getattr(self._real, name)

        monkeypatch.setattr(correlation_sql, "_connect", lambda: LockedOnWrite(real_connect()))
        body = _family(client).json()

        assert {entry["catalog_id"] for entry in body["results"]} == SCORABLE
        assert _rows(db_path, "correlations_cache") == []

    def test_saved_rows_from_an_older_version_are_rescored(self, client, db_path, monkeypatch):
        conn = sqlite3.connect(db_path)
        conn.execute("INSERT INTO correlations_cache (catalog_id_a, catalog_id_b, r, metric, method, lag_samples, "
                     "p_value, n_pairs, method_version) VALUES (1, ?, 0.123, 'egc', 'spearman', 0, 0.5, 40, ?)",
                     (REF_ID, CORRELATION_METHOD_VERSION - 1))
        conn.commit()
        conn.close()

        body = _family(client).json()

        entry = next(e for e in body["results"] if e["catalog_id"] == 1)
        assert entry["r"] != 0.123


class TestWhyCandidatesWereNotScored:
    """untested_reasons splits untested_count by why each candidate could
    not be scored: K00004 has only 6 points (too few shared timepoints),
    K00003 is constant (no variation where they overlap)."""

    EXPECTED = {"too_few_points": 1, "no_variation": 1, "other": 0}

    def test_a_cold_request_gives_the_reasons(self, client):
        body = _family(client).json()
        assert body["untested_reasons"] == self.EXPECTED
        assert sum(body["untested_reasons"].values()) == body["untested_count"]

    def test_a_cached_request_gives_the_same_reasons(self, client):
        _family(client)
        body = _family(client).json()
        assert body["untested_reasons"] == self.EXPECTED

    def test_a_score_that_could_not_be_computed_counts_as_other(self, client, monkeypatch):
        real = correlation_sql.score_family_checked

        def nan_for_first_row(ref, table, method):
            result = real(ref, table, method)
            result["r"][0] = np.nan
            return result

        monkeypatch.setattr(correlation_sql, "score_family_checked", nan_for_first_row)
        body = _family(client).json()
        assert body["untested_reasons"] == {"too_few_points": 1, "no_variation": 1, "other": 1}
        assert sum(body["untested_reasons"].values()) == body["untested_count"]

    def test_reasons_are_given_even_when_the_save_fails(self, client, monkeypatch):
        real_connect = correlation_sql._connect

        class LockedOnWrite:
            def __init__(self, conn):
                self._real = conn

            def executemany(self, sql, rows):
                raise sqlite3.OperationalError("database is locked")

            def __getattr__(self, name):
                return getattr(self._real, name)

        monkeypatch.setattr(correlation_sql, "_connect", lambda: LockedOnWrite(real_connect()))
        assert _family(client).json()["untested_reasons"] == self.EXPECTED
