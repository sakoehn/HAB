"""
test_series_export_cog_route.py
===============================
Live-HTTP tests for the bulk time-series download with source=cog:
levels category (1) and cog (2). A COG in several categories is only
"in several paths" when the start is the whole dataset (a single category
holds each COG once), so that is where the review list and path choices
apply. The general CSV contract for COG files is checked in
test_series_export_csv_contract.py.

Run:
    pytest tests/sql/test_series_export_cog_route.py -v
"""

import csv
import io
import json
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
WHOLE = {"source": "cog", "rank": "cog"}
COG0028 = "COG0028"  # real member of both E and H


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


def _pairs(conn, category=None):
    have = {r[0] for r in conn.execute("SELECT annotation_id FROM annotation_catalog WHERE source = 'cog'")}
    sql = "SELECT DISTINCT b_id, a_id FROM cog_paths WHERE b_id IS NOT NULL"
    params = ()
    if category:
        sql += " AND a_id = ?"
        params = (category,)
    return [(b, a) for b, a in conn.execute(sql, params) if b in have]


def test_summary_for_one_category(client, conn):
    cogs = {b for b, _ in _pairs(conn, "E")}
    body = client.get("/series/export/summary", params={"source": "cog", "parent": "E", "rank": "cog"}).json()
    assert body["taxa"] == len(cogs)
    assert body["max_rows"] == len(cogs) * SAMPLES
    assert body["multi_path_terms"] == 0  # inside one category each COG appears once


def test_summary_whole_dataset_counts_cogs_in_several_categories(client, conn):
    pairs = _pairs(conn)
    cogs = {b for b, _ in pairs}
    multi = {b for b in cogs if sum(1 for x, _ in pairs if x == b) > 1}
    body = client.get("/series/export/summary", params=WHOLE).json()
    assert body["taxa"] == len(cogs)
    assert body["max_rows"] == len(pairs) * SAMPLES
    assert body["multi_path_terms"] == len(multi) == 340


def test_categories_level(client):
    body = client.get("/series/export/summary", params={"source": "cog", "rank": "category"}).json()
    assert body["taxa"] == 25


@pytest.mark.parametrize("params, status", [
    ({"rank": "cog", "parent": COG0028}, 400),        # nothing below a COG
    ({"rank": "category", "parent": "E"}, 400),       # same level as the start
    ({"rank": "cog", "parent": "NOT_A_COG_ID"}, 404),
    ({"rank": "ko"}, 400),                            # a KEGG level, not a COG one
])
def test_rejects_bad_cog_requests(client, params, status):
    assert client.get("/series/export/summary", params={"source": "cog", **params}).status_code == status


def test_a_cog_in_two_categories_gets_a_block_per_category(client):
    rows = [r for r in _rows(client.get("/series/export", params=WHOLE)) if r["annotation_id"] == COG0028]
    assert sorted({r["lineage_ids"] for r in rows}) == ["E > COG0028", "H > COG0028"]
    assert len(rows) == 2 * SAMPLES
    assert all(r["also_in_other_paths"] == "true" and r["level"] == "cog" for r in rows)


def test_review_lists_categories_most_abundant_first(client, conn):
    terms = client.get("/series/export/review", params=WHOLE).json()["terms"]
    assert len(terms) == 340
    cog28 = next(t for t in terms if t["annotation_id"] == COG0028)
    assert {p["parent_id"] for p in cog28["paths"]} == {"E", "H"}
    means = dict(conn.execute("SELECT annotation_id, mean_egc FROM annotation_catalog WHERE source = 'cog' AND annotation_id IN ('E', 'H')"))
    assert [p["parent_id"] for p in cog28["paths"]] == sorted(means, key=lambda k: -means[k])


def test_unticking_a_category_drops_that_block(client):
    body = ("selection=" + json.dumps({"exclude": [[COG0028, "H"]]})).encode()
    rows = _rows(client.post("/series/export", params=WHOLE, content=body, headers={"Content-Type": "text/plain"}))
    cog28 = [r for r in rows if r["annotation_id"] == COG0028]
    assert {r["lineage_ids"] for r in cog28} == {"E > COG0028"}
    assert all(r["also_in_other_paths"] == "false" for r in cog28)


def test_starting_category_block(client):
    rows = _rows(client.get("/series/export", params={"source": "cog", "parent": "E", "rank": "cog", "include_parent": "true"}))
    start = rows[:SAMPLES]
    assert all(r["annotation_id"] == "E" and r["level"] == "category" and r["is_starting_term"] == "true" for r in start)
    assert start[0]["lineage"] == "Amino acid transport and metabolism"
