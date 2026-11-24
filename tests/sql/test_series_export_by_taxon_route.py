"""
test_series_export_by_taxon_route.py
======================================
Live-HTTP tests for downloading KOs split by taxon:

  POST /series/export/by-taxon/summary -- size of the download first
  POST /series/export/by-taxon         -- the CSV

The body is a text/plain form post, `selection={"kos": [ko, ...]}`, like
the other bulk downloads. Long format (default) has one row per KO, taxon
and timepoint, with undetected timepoints written as 0 (detected=false);
wide has one row per KO and taxon and one column per timepoint.

Run:
    pytest tests/sql/test_series_export_by_taxon_route.py -v
"""

import csv
import io
import json
import os
import sqlite3
import sys
from collections import defaultdict

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH  # noqa: E402

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

LONG_HEADER = ["ko", "ko_name", "taxon", "rank", "lineage", "sample", "date", "time", "egc", "norm_egc", "detected"]
WIDE_FIXED = ["ko", "ko_name", "taxon", "rank", "lineage"]
SAMPLES = 128


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


@pytest.fixture(scope="module")
def kos(conn):
    """Two KOs detected in some but not all samples, so zero rows show up."""
    return [r[0] for r in conn.execute(
        "SELECT annotation_id FROM annotation_catalog WHERE source = 'kegg' "
        "AND sample_count BETWEEN 20 AND 60 ORDER BY annotation_id LIMIT 2"
    )]


@pytest.fixture(scope="module")
def dates(client):
    """sample -> (date, time), from the same source the site's charts use."""
    from api.db import connect_to_sql
    from api.routes import _export_samples

    db = connect_to_sql()
    try:
        return {s: tuple(d.split(" ")) for s, d in _export_samples(db, None, None)}
    finally:
        db.close()


def _post(client, kos, path="/series/export/by-taxon", body=None, **params):
    params.setdefault("rank", "genus")
    if body is None:
        body = "selection=" + json.dumps({"kos": kos}) + "\r\n"
    return client.post(path, params=params, content=body, headers={"Content-Type": "text/plain"})


def _csv(resp):
    assert resp.status_code == 200, resp.text
    reader = csv.reader(io.StringIO(resp.text))
    header = next(reader)
    return header, list(reader)


def _long(client, kos, **params):
    header, rows = _csv(_post(client, kos, **params))
    assert header == LONG_HEADER
    return [dict(zip(header, r)) for r in rows]


def _stored(conn, ko):
    return {
        sample: (egc, norm)
        for sample, egc, norm in conn.execute(
            "SELECT sample, egc, norm_egc FROM annotation_series WHERE source = 'kegg' AND annotation_id = ?",
            (ko,),
        )
    }


# ── Long format ───────────────────────────────────────────────────────────────

def test_long_is_the_default_and_every_taxon_gets_every_timepoint(client, kos):
    rows = _long(client, kos[:1])
    taxa = {r["lineage"] for r in rows}
    assert len(rows) == len(taxa) * SAMPLES
    assert {r["rank"] for r in rows} == {"genus"}


def test_long_taxa_add_up_to_the_kos_series(client, conn, kos):
    rows = _long(client, kos[:1])
    egc, norm = defaultdict(float), defaultdict(float)
    for r in rows:
        egc[r["sample"]] += float(r["egc"])
        norm[r["sample"]] += float(r["norm_egc"])
    stored = _stored(conn, kos[0])
    for sample in egc:
        want_egc, want_norm = stored.get(sample, (0.0, 0.0))
        assert egc[sample] == pytest.approx(want_egc, rel=1e-9, abs=1e-12), sample
        assert norm[sample] == pytest.approx(want_norm, rel=1e-9, abs=1e-15), sample


def test_long_undetected_timepoints_are_zero_and_flagged(client, kos):
    rows = _long(client, kos[:1])
    zeros = [r for r in rows if r["detected"] == "false"]
    assert zeros, "this KO should be missing from some samples"
    assert all(r["egc"] == "0" and r["norm_egc"] == "0" for r in zeros)
    assert all(float(r["egc"]) > 0 for r in rows if r["detected"] == "true")


def test_long_date_and_time_are_separate_columns_in_date_order(client, kos, dates):
    rows = _long(client, kos[:1])
    first_taxon = rows[0]["lineage"]
    block = [r for r in rows if r["lineage"] == first_taxon]
    assert [(r["date"], r["time"]) for r in block] == sorted(dates.values())
    assert all((r["date"], r["time"]) == dates[r["sample"]] for r in rows)


def test_long_taxa_sorted_by_total_egc_within_each_ko(client, kos):
    rows = _long(client, kos)
    assert [r["ko"] for r in rows] == sorted(r["ko"] for r in rows)
    for ko in kos:
        totals = {}
        for r in rows:
            if r["ko"] == ko:
                totals[r["lineage"]] = totals.get(r["lineage"], 0.0) + float(r["egc"])
        order = list(totals)
        assert order == sorted(order, key=lambda t: -totals[t])


def test_long_names_the_ko(client, conn, kos):
    name = conn.execute(
        "SELECT name FROM annotation_catalog WHERE source = 'kegg' AND annotation_id = ?", (kos[0],)
    ).fetchone()[0]
    rows = _long(client, kos[:1])
    assert {r["ko_name"] for r in rows} == {name or ""}


def test_ko_prefix_is_accepted(client, kos):
    assert _long(client, [f"KO:{kos[0]}"]) == _long(client, kos[:1])


def test_date_range_limits_the_timepoints(client, kos, dates):
    rows = _long(client, kos[:1], date_from="2021-06-01", date_to="2021-06-05")
    days = {r["date"] for r in rows}
    assert days and all("2021-06-01" <= d <= "2021-06-05" for d in days)
    assert len({r["sample"] for r in rows}) == sum(1 for d, _ in dates.values() if "2021-06-01" <= d <= "2021-06-05")


def test_rank_changes_the_grouping(client, kos):
    rows = _long(client, kos[:1], rank="phylum")
    assert {r["rank"] for r in rows} == {"phylum"}
    assert all(r["lineage"].count(";") == 1 for r in rows if r["lineage"])


# ── Wide format ───────────────────────────────────────────────────────────────

def test_wide_has_one_column_per_timepoint(client, kos, dates):
    header, rows = _csv(_post(client, kos[:1], format="wide"))
    assert header == WIDE_FIXED + [f"{d} {t}" for d, t in sorted(dates.values())]
    assert all(len(r) == len(header) for r in rows)


@pytest.mark.parametrize("metric", ["egc", "norm_egc"])
def test_wide_matches_long(client, kos, metric):
    long_rows = _long(client, kos)
    header, wide_rows = _csv(_post(client, kos, format="wide", metric=metric))
    want = {(r["ko"], r["lineage"], f"{r['date']} {r['time']}"): r[metric] for r in long_rows}
    got = {
        (row[0], row[4], col): value
        for row in wide_rows
        for col, value in zip(header[5:], row[5:])
    }
    assert got == want
    assert [(r[0], r[4]) for r in wide_rows] == list(dict.fromkeys((r["ko"], r["lineage"]) for r in long_rows))


# ── Summary ───────────────────────────────────────────────────────────────────

def test_summary_counts_genes_and_lists_unknown_kos(client, conn, kos):
    resp = _post(client, [*kos, "K99999"], path="/series/export/by-taxon/summary")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    genes = conn.execute(
        "SELECT COUNT(*) FROM mappings WHERE kegg_id IN (?, ?)", tuple(f"KO:{k}" for k in kos)
    ).fetchone()[0]
    assert body["kos"] == len(kos)
    assert body["unknown_kos"] == ["K99999"]
    assert body["samples"] == SAMPLES
    assert body["genes"] == genes
    assert body["max_genes"] > 0


def test_unknown_kos_are_left_out_of_the_download(client, kos):
    assert _long(client, [kos[0], "K99999"]) == _long(client, kos[:1])


# ── Bad requests ──────────────────────────────────────────────────────────────

def test_only_unknown_kos_is_404(client):
    assert _post(client, ["K99999"]).status_code == 404


def test_no_kos_is_400(client):
    assert _post(client, []).status_code == 400


def test_bad_body_is_400(client):
    assert _post(client, None, body="selection=not json").status_code == 400
    assert _post(client, None, body='selection={"kos": "K00001"}').status_code == 400


@pytest.mark.parametrize("params", [
    {"rank": "kingdom"},
    {"format": "tall"},
    {"format": "wide", "metric": "reads"},
    {"date_from": "not a date"},
])
def test_bad_parameters_are_400(client, kos, params):
    assert _post(client, kos[:1], **params).status_code == 400


def test_over_the_gene_limit_is_refused(client, kos, monkeypatch):
    from api import routes

    monkeypatch.setattr(routes, "_BY_TAXON_MAX_GENES", 1)
    resp = _post(client, kos[:1])
    assert resp.status_code == 413
    assert "limit" in resp.json()["detail"]
