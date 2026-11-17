"""
test_series_export_kegg_route.py
================================
Live-HTTP tests for the bulk time-series download with source=kegg.

KEGG orthologs (KOs) are a flat list -- the site does not use KEGG's
pathway hierarchy -- so the only level is "ko", there is no starting
term, every KO comes back once, and there is nothing to review.

The general CSV contract (header, values, samples, dates) is checked for
KEGG files in test_series_export_csv_contract.py; the review list and path
choices are covered for COG in test_series_export_cog_route.py.

Run:
    pytest tests/sql/test_series_export_kegg_route.py -v
"""

import csv
import io
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

SAMPLES = 128
HK = "K00844"
PARAMS = {"source": "kegg", "rank": "ko"}
# One sampling day keeps the file small.
ONE_DAY = {**PARAMS, "date_from": "2021-06-01", "date_to": "2021-06-01"}


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
    assert resp.status_code == 200, resp.text
    reader = csv.reader(io.StringIO(resp.text))
    header = next(reader)
    return [dict(zip(header, r)) for r in reader]


def test_summary_counts_every_ko_once(client, conn):
    kos = conn.execute("SELECT COUNT(*) FROM annotation_catalog WHERE source = 'kegg'").fetchone()[0]
    body = client.get("/series/export/summary", params=PARAMS).json()
    assert body["taxa"] == kos
    assert body["max_rows"] == kos * SAMPLES
    assert body["multi_path_terms"] == 0


@pytest.mark.parametrize("params, status", [
    ({"rank": "pathway"}, 400),                    # no KEGG pathway level any more
    ({"rank": "category"}, 400),
    ({"rank": "ko", "parent": HK}, 400),            # nothing below a KO
    ({"rank": "ko", "parent": "00010"}, 404),       # a KEGG pathway id is not a term here
    ({"rank": "ec"}, 400),                          # an enzyme level, not a KEGG one
])
def test_rejects_bad_kegg_requests(client, params, status):
    assert client.get("/series/export/summary", params={"source": "kegg", **params}).status_code == status


def test_every_ko_is_one_block_with_its_own_id_as_lineage(client, conn):
    rows = _rows(client.get("/series/export", params=ONE_DAY))
    names = dict(conn.execute("SELECT annotation_id, name FROM annotation_catalog WHERE source = 'kegg'"))
    hk = [r for r in rows if r["annotation_id"] == HK]
    assert len(hk) >= 1
    assert all(r["level"] == "ko" for r in rows)
    assert all(r["lineage_ids"] == r["annotation_id"] for r in rows)
    assert all(r["also_in_other_paths"] == "false" for r in rows)
    assert all(r["is_starting_term"] == "false" for r in rows)
    assert all(r["name"] == (names[r["annotation_id"]] or "") for r in rows)
    assert hk[0]["name"] == "hexokinase"


def test_review_is_empty_for_kegg(client):
    assert client.get("/series/export/review", params=PARAMS).json()["terms"] == []


@pytest.mark.parametrize("body", [
    b"not a selection",
    b"selection={not json}",
    b'selection={"exclude": [["K00844"]]}',
    b'selection={"exclude": "K00844"}',
])
def test_malformed_selection_is_rejected(client, body):
    resp = client.post("/series/export", params=PARAMS, content=body, headers={"Content-Type": "text/plain"})
    assert resp.status_code == 400


def test_taxonomy_takes_no_path_choices(client):
    body = b'selection={"exclude": [["x", "y"]]}\r\n'
    resp = client.post("/series/export", params={"source": "taxonomy", "rank": "phylum"},
                       content=body, headers={"Content-Type": "text/plain"})
    assert resp.status_code == 400
