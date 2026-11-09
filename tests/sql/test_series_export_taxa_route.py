"""
test_series_export_taxa_route.py
================================
Live-HTTP tests for downloading the taxa checked on the Taxonomy page:

  POST /series/export/taxa  -- the CSV for exactly the listed taxa (any
                               mix of ranks), every sample, same columns
                               as /series/export.

The body is a text/plain form post, `selection={"taxa": [lineage, ...]}`,
the same shape the KEGG/COG path choices use.

Run:
    pytest tests/sql/test_series_export_taxa_route.py -v
"""

import csv
import io
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH
from test_cache_sql import BOSEA_NEW_LINEAGE, BOSEA_OLD_LINEAGE

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

ALPHA = "Bacteria;Proteobacteria;Alphaproteobacteria"
GAMMA = "Bacteria;Proteobacteria;Gammaproteobacteria"
CAULOBACTERACEAE = f"{ALPHA};Caulobacterales;Caulobacteraceae"
HOLOSPORACEAE = f"{ALPHA};Holosporales;Holosporaceae"
EMCIBACTERALES = f"{ALPHA};Emcibacterales"
CHECKED = [HOLOSPORACEAE, EMCIBACTERALES, CAULOBACTERACEAE]
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


def _post(client, taxa, parent=ALPHA, body=None):
    params = {"parent": parent} if parent else {}
    if body is None:
        body = "selection=" + json.dumps({"taxa": taxa}) + "\r\n"
    return client.post("/series/export/taxa", params=params, content=body,
                       headers={"Content-Type": "text/plain"})


def _rows(resp):
    assert resp.status_code == 200, resp.text
    reader = csv.reader(io.StringIO(resp.text))
    header = next(reader)
    assert header == HEADER
    return [dict(zip(header, r)) for r in reader]


@pytest.fixture(scope="module")
def checked_rows(client):
    return _rows(_post(client, CHECKED))


def test_export_is_a_csv_attachment_named_after_the_scope(client):
    resp = _post(client, CHECKED)
    assert resp.headers["content-type"].startswith("text/csv")
    assert 'filename="Alphaproteobacteria_checked_taxa_timeseries.csv"' in resp.headers["content-disposition"]


def test_export_without_a_scope_has_a_plain_name(client):
    resp = _post(client, CHECKED, parent=None)
    assert 'filename="checked_taxa_timeseries.csv"' in resp.headers["content-disposition"]


def test_export_has_exactly_the_checked_taxa_in_every_sample(checked_rows):
    assert len(checked_rows) == len(CHECKED) * SAMPLES
    by_taxon = defaultdict(set)
    for r in checked_rows:
        by_taxon[r["lineage"]].add(r["sample"])
    assert set(by_taxon) == set(CHECKED)
    assert all(len(samples) == SAMPLES for samples in by_taxon.values())


def test_export_labels_each_taxon_with_its_own_rank(checked_rows):
    ranks = {r["lineage"]: r["rank"] for r in checked_rows}
    assert ranks == {HOLOSPORACEAE: "family", CAULOBACTERACEAE: "family", EMCIBACTERALES: "order"}
    assert all(r["lineage"].rsplit(";", 1)[1] == r["taxon"] for r in checked_rows)


def test_export_values_match_the_database(checked_rows, conn):
    stored = {
        (a, s): (egc, norm)
        for a, s, egc, norm in conn.execute(
            "SELECT annotation_id, sample, egc, norm_egc FROM annotation_series "
            f"WHERE source = 'taxonomy' AND annotation_id IN ({','.join('?' * len(CHECKED))})",
            CHECKED,
        )
    }
    assert stored
    for r in checked_rows:
        key = (r["lineage"], r["sample"])
        if key in stored:
            assert r["detected"] == "true"
            assert (float(r["egc"]), float(r["norm_egc"])) == stored[key]
        else:
            assert (r["detected"], r["egc"], r["norm_egc"]) == ("false", "0", "0")
    assert sum(r["detected"] == "true" for r in checked_rows) == len(stored)


def test_export_taxa_come_in_lineage_order_with_dates_chronological(checked_rows):
    lineages = list(dict.fromkeys(r["lineage"] for r in checked_rows))
    assert lineages == sorted(CHECKED)
    by_taxon = defaultdict(list)
    for r in checked_rows:
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", r["date"]), r["date"]
        by_taxon[r["lineage"]].append(r["date"])
    for dates in by_taxon.values():
        assert dates == sorted(dates)


def test_a_taxon_listed_twice_is_written_once(client):
    rows = _rows(_post(client, [HOLOSPORACEAE, HOLOSPORACEAE]))
    assert len(rows) == SAMPLES


def test_export_keeps_homonym_genera_apart(client):
    rows = _rows(_post(client, [BOSEA_OLD_LINEAGE, BOSEA_NEW_LINEAGE]))
    assert {r["lineage"] for r in rows} == {BOSEA_OLD_LINEAGE, BOSEA_NEW_LINEAGE}
    assert len(rows) == 2 * SAMPLES


@pytest.mark.parametrize("taxa, parent, status", [
    ([], ALPHA, 400),                                  # nothing checked
    (["Bacteria;Nope"], ALPHA, 404),                   # unknown taxon
    ([GAMMA + ";Enterobacterales"], ALPHA, 400),       # outside the scope
    ([ALPHA], ALPHA, 400),                             # the scope itself
    ([HOLOSPORACEAE], "Nope;Nope", 404),               # unknown scope
    ([HOLOSPORACEAE, 5], ALPHA, 400),                  # not all strings
])
def test_export_rejects_bad_choices(client, taxa, parent, status):
    assert _post(client, taxa, parent=parent).status_code == status


@pytest.mark.parametrize("body", [
    "taxa=[]",
    "selection=not json",
    'selection={"exclude": []}',
    'selection=["a"]',
])
def test_export_rejects_a_malformed_body(client, body):
    assert _post(client, None, body=body).status_code == 400
