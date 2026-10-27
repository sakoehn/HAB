"""
test_series_export_route.py
===========================
Live-HTTP tests for the bulk time-series download (Explore > Bulk download):

  GET /series/export/summary  -- how many taxa/samples/rows a download
                                 would have, shown before downloading.
  GET /series/export          -- the CSV itself, one row per taxon per
                                 sample (long layout).

Taxonomy is the only source for now; the routes already take `source` so
kegg/cog/enzyme can be added without changing the API.

Uses FastAPI's TestClient as a context manager, same as
test_taxonomy_export_route.py.

Run:
    pytest tests/sql/test_series_export_route.py -v
"""

import csv
import io
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH
from test_cache_sql import BOSEA_NEW_LINEAGE, BOSEA_OLD_LINEAGE

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

GAMMA = "Bacteria;Proteobacteria;Gammaproteobacteria"
ALPHA = "Bacteria;Proteobacteria;Alphaproteobacteria"
GAMMA_FAMILIES = 76
SAMPLES = 128
HEADER = ["taxon", "rank", "lineage", "sample", "date", "egc", "norm_egc", "detected"]


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


def _rows(resp):
    reader = csv.reader(io.StringIO(resp.text))
    header = next(reader)
    assert header == HEADER
    return [dict(zip(header, r)) for r in reader]


def _gamma_family_csv(client, **params):
    return client.get("/series/export", params={"source": "taxonomy", "parent": GAMMA, "rank": "family", **params})


# ── /series/export/summary ───────────────────────────────────────────────────

def test_summary_counts_families_under_gammaproteobacteria(client):
    resp = client.get("/series/export/summary", params={"source": "taxonomy", "parent": GAMMA, "rank": "family"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["taxa"] == GAMMA_FAMILIES
    assert body["samples"] == SAMPLES
    assert body["max_rows"] == GAMMA_FAMILIES * SAMPLES
    assert body["sparse"] is False


def test_summary_flags_a_download_too_big_for_excel_as_sparse(client):
    resp = client.get("/series/export/summary", params={"source": "taxonomy", "parent": "Bacteria", "rank": "species"})
    body = resp.json()
    assert body["max_rows"] > 1_048_575
    assert body["sparse"] is True


def test_summary_without_parent_covers_the_whole_dataset(client):
    resp = client.get("/series/export/summary", params={"source": "taxonomy", "rank": "domain"})
    assert resp.status_code == 200
    assert resp.json()["taxa"] == 4


def test_summary_date_range_limits_the_samples(client):
    from api.cache import TIMEPOINTS

    expected = sum(
        1 for tp in TIMEPOINTS.values()
        if datetime.strptime(tp["datetime"], "%m/%d/%y %H:%M").date().isoformat() == "2021-06-03"
    )
    assert 0 < expected < SAMPLES
    resp = client.get("/series/export/summary", params={
        "source": "taxonomy", "parent": GAMMA, "rank": "family",
        "date_from": "2021-06-03", "date_to": "2021-06-03",
    })
    assert resp.json()["samples"] == expected


@pytest.mark.parametrize("params, status", [
    ({"source": "kegg", "rank": "family"}, 400),                         # not available yet
    ({"source": "taxonomy", "rank": "bogus"}, 400),                      # unknown rank
    ({"source": "taxonomy", "rank": "family", "parent": "Nope;Nope"}, 404),
    ({"source": "taxonomy", "rank": "class", "parent": GAMMA}, 400),     # same rank as parent
    ({"source": "taxonomy", "rank": "phylum", "parent": GAMMA}, 400),    # above parent
    ({"source": "taxonomy", "rank": "family", "date_from": "not-a-date"}, 400),
    ({"source": "taxonomy"}, 422),                                        # rank is required
])
def test_summary_rejects_bad_requests(client, params, status):
    assert client.get("/series/export/summary", params=params).status_code == status


# ── /series/export ───────────────────────────────────────────────────────────

def test_export_is_a_csv_attachment_named_after_the_request(client):
    resp = _gamma_family_csv(client)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert 'filename="Gammaproteobacteria_family_timeseries.csv"' in resp.headers["content-disposition"]


def test_export_has_every_family_in_every_sample(client):
    rows = _rows(_gamma_family_csv(client))
    assert len(rows) == GAMMA_FAMILIES * SAMPLES
    assert len({r["lineage"] for r in rows}) == GAMMA_FAMILIES
    assert all(r["rank"] == "family" for r in rows)
    assert all(r["lineage"].startswith(GAMMA + ";") for r in rows)
    assert all(r["lineage"].rsplit(";", 1)[1] == r["taxon"] for r in rows)


def test_export_fills_undetected_samples_with_explicit_zeros(client, conn):
    rows = _rows(_gamma_family_csv(client))
    detected = [r for r in rows if r["detected"] == "true"]
    missing = [r for r in rows if r["detected"] == "false"]
    lineages = sorted({r["lineage"] for r in rows})
    expected_detected = conn.execute(
        f"SELECT COUNT(*) FROM annotation_series WHERE source = 'taxonomy' "
        f"AND annotation_id IN ({','.join('?' * len(lineages))})",
        lineages,
    ).fetchone()[0]
    assert len(detected) == expected_detected
    assert len(detected) + len(missing) == len(rows)
    assert missing, "expected at least one family absent from some sample"
    assert all(r["egc"] == "0" and r["norm_egc"] == "0" for r in missing)


def test_export_values_match_the_database(client, conn):
    rows = _rows(_gamma_family_csv(client))
    row = next(r for r in rows if r["detected"] == "true")
    egc, norm = conn.execute(
        "SELECT egc, norm_egc FROM annotation_series WHERE source = 'taxonomy' AND annotation_id = ? AND sample = ?",
        (row["lineage"], row["sample"]),
    ).fetchone()
    assert float(row["egc"]) == egc
    assert float(row["norm_egc"]) == norm


def test_export_families_add_up_to_gammaproteobacteria(client, conn):
    summed = defaultdict(float)
    for r in _rows(_gamma_family_csv(client)):
        summed[r["sample"]] += float(r["egc"])
    parent = dict(conn.execute(
        "SELECT sample, egc FROM annotation_series WHERE source = 'taxonomy' AND annotation_id = ?", (GAMMA,),
    ).fetchall())
    for sample, egc in parent.items():
        assert summed[sample] == pytest.approx(egc)


def test_export_dates_are_iso_and_chronological_within_each_taxon(client):
    by_taxon = defaultdict(list)
    for r in _rows(_gamma_family_csv(client)):
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", r["date"]), r["date"]
        by_taxon[r["lineage"]].append(r["date"])
    for dates in by_taxon.values():
        assert dates == sorted(dates)


def test_export_taxa_come_in_lineage_order(client):
    lineages = [r["lineage"] for r in _rows(_gamma_family_csv(client))]
    first_seen = list(dict.fromkeys(lineages))
    assert first_seen == sorted(first_seen)


def test_export_date_range_keeps_only_samples_inside_it(client):
    resp = _gamma_family_csv(client, date_from="2021-06-03", date_to="2021-06-03")
    rows = _rows(resp)
    assert rows
    assert all(r["date"].startswith("2021-06-03") for r in rows)
    assert "2021-06-03_to_2021-06-03" in resp.headers["content-disposition"]


def test_export_keeps_homonym_genera_apart(client):
    resp = client.get("/series/export", params={"source": "taxonomy", "parent": ALPHA, "rank": "genus"})
    lineages = {r["lineage"] for r in _rows(resp)}
    assert BOSEA_OLD_LINEAGE in lineages
    assert BOSEA_NEW_LINEAGE in lineages


def test_export_can_skip_ranks(client):
    resp = client.get("/series/export", params={"source": "taxonomy", "parent": GAMMA, "rank": "species"})
    rows = _rows(resp)
    assert all(r["rank"] == "species" for r in rows)
    assert all(r["lineage"].count(";") >= 6 for r in rows)


def test_sparse_export_writes_only_detected_rows(client, monkeypatch):
    """Over the dense-row limit the file lists only detected rows -- the
    limit is lowered here so a small request exercises that path."""
    from api import routes

    monkeypatch.setattr(routes, "_EXPORT_DENSE_ROW_LIMIT", 10)
    summary = client.get("/series/export/summary", params={"source": "taxonomy", "parent": GAMMA, "rank": "family"})
    assert summary.json()["sparse"] is True
    rows = _rows(_gamma_family_csv(client))
    assert rows
    assert len(rows) < GAMMA_FAMILIES * SAMPLES
    assert all(r["detected"] == "true" for r in rows)


def test_export_rejects_bad_requests_before_streaming(client):
    assert client.get("/series/export", params={"source": "kegg", "rank": "family"}).status_code == 400
    assert client.get("/series/export", params={"source": "taxonomy", "rank": "family", "parent": "Nope"}).status_code == 404
