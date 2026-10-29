"""
test_series_export_kegg_route.py
================================
Live-HTTP tests for the bulk time-series download with source=kegg:

  * levels category (1), subcategory (2), pathway (3), ko (4);
  * a KO in several pathways inside the start gets one block of rows per
    pathway, flagged also_in_other_paths=true;
  * GET /series/export/review lists those KOs with their pathways, most
    abundant pathway first;
  * POST /series/export and POST /series/export/summary take the user's
    choices as a text/plain form body `selection={"exclude": [[ko, pathway], ...]}`
    and leave those (KO, pathway) blocks out.

The general CSV contract (header, values, samples, dates) is checked for
KEGG files in test_series_export_csv_contract.py.

Run:
    pytest tests/sql/test_series_export_kegg_route.py -v
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
CARBOHYDRATE = "09101"
METABOLISM = "09100"
GLYCOLYSIS = "00010"
HK = "K00844"
PARAMS = {"source": "kegg", "parent": CARBOHYDRATE, "rank": "ko"}


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


def _with_data(conn, rows):
    have = {r[0] for r in conn.execute("SELECT annotation_id FROM annotation_catalog WHERE source = 'kegg'")}
    return [r for r in rows if r[0] in have]


def _pairs_under(conn, subcategory):
    """(KO, pathway) pairs under a subcategory, KOs with data only."""
    return _with_data(conn, conn.execute(
        "SELECT DISTINCT d_id, c_id FROM kegg_paths WHERE b_id = ? AND d_id IS NOT NULL", (subcategory,),
    ).fetchall())


def _rows(resp):
    assert resp.status_code == 200, resp.text
    reader = csv.reader(io.StringIO(resp.text))
    header = next(reader)
    return [dict(zip(header, r)) for r in reader]


def _selection(exclude):
    return ("selection=" + json.dumps({"exclude": exclude}) + "\r\n").encode()


def _post(client, path, exclude, params=PARAMS):
    return client.post(path, params=params, content=_selection(exclude), headers={"Content-Type": "text/plain"})


# ── summary and levels ───────────────────────────────────────────────────────

def test_summary_counts_kos_paths_and_kos_with_several_paths(client, conn):
    pairs = _pairs_under(conn, CARBOHYDRATE)
    kos = {ko for ko, _ in pairs}
    multi = {ko for ko in kos if sum(1 for k, _ in pairs if k == ko) > 1}
    body = client.get("/series/export/summary", params=PARAMS).json()
    assert body["taxa"] == len(kos)
    assert body["max_rows"] == len(pairs) * SAMPLES
    assert body["multi_path_terms"] == len(multi) > 0


def test_multi_path_terms_is_zero_where_there_is_nothing_to_review(client):
    for params in (
        {"source": "kegg", "parent": GLYCOLYSIS, "rank": "ko"},
        {"source": "kegg", "parent": METABOLISM, "rank": "pathway"},
        {"source": "enzyme", "parent": "5.6.2", "rank": "ec"},
        {"source": "taxonomy", "rank": "phylum"},
    ):
        assert client.get("/series/export/summary", params=params).json()["multi_path_terms"] == 0, params


@pytest.mark.parametrize("params, status", [
    ({"rank": "ko", "parent": HK}, 400),            # nothing below a KO
    ({"rank": "pathway", "parent": GLYCOLYSIS}, 400),
    ({"rank": "ko", "parent": "NOT_A_KEGG_ID"}, 404),
    ({"rank": "ec"}, 400),                          # an enzyme level, not a KEGG one
])
def test_rejects_bad_kegg_requests(client, params, status):
    assert client.get("/series/export/summary", params={"source": "kegg", **params}).status_code == status


def test_cog_is_still_not_available(client):
    assert client.get("/series/export/summary", params={"source": "cog", "rank": "category"}).status_code == 400


# ── export ───────────────────────────────────────────────────────────────────

def test_a_ko_in_several_pathways_gets_one_block_per_pathway(client, conn):
    rows = _rows(client.get("/series/export", params=PARAMS))
    hk_rows = [r for r in rows if r["annotation_id"] == HK]
    in_scope = {c for k, c in _pairs_under(conn, CARBOHYDRATE) if k == HK}
    assert len(in_scope) > 1
    pathways = [r["lineage_ids"].split(" > ")[-2] for r in hk_rows]
    assert set(pathways) == in_scope
    assert len(hk_rows) == len(in_scope) * SAMPLES
    assert all(r["also_in_other_paths"] == "true" for r in hk_rows)


def test_a_ko_in_one_pathway_is_not_flagged(client, conn):
    pairs = _pairs_under(conn, CARBOHYDRATE)
    single = next(ko for ko, _ in pairs if sum(1 for k, _ in pairs if k == ko) == 1)
    rows = [r for r in _rows(client.get("/series/export", params=PARAMS)) if r["annotation_id"] == single]
    assert len(rows) == SAMPLES
    assert all(r["also_in_other_paths"] == "false" for r in rows)


def test_repeated_blocks_carry_identical_values(client):
    rows = [r for r in _rows(client.get("/series/export", params=PARAMS)) if r["annotation_id"] == HK]
    by_pathway = {}
    for r in rows:
        by_pathway.setdefault(r["lineage_ids"], []).append((r["sample"], r["egc"], r["norm_egc"]))
    blocks = list(by_pathway.values())
    assert all(b == blocks[0] for b in blocks[1:])


def test_starting_term_block_for_kegg(client):
    rows = _rows(client.get("/series/export", params={**PARAMS, "include_parent": "true"}))
    start = rows[:SAMPLES]
    assert all(r["annotation_id"] == CARBOHYDRATE and r["is_starting_term"] == "true" for r in start)
    assert all(r["level"] == "subcategory" and r["lineage_ids"] == f"{METABOLISM} > {CARBOHYDRATE}" for r in start)


# ── review list ──────────────────────────────────────────────────────────────

def test_review_lists_kos_with_several_paths_most_abundant_first(client):
    body = client.get("/series/export/review", params=PARAMS).json()
    summary = client.get("/series/export/summary", params=PARAMS).json()
    assert len(body["terms"]) == summary["multi_path_terms"]
    hk = next(t for t in body["terms"] if t["annotation_id"] == HK)
    means = [p["parent_mean_egc"] for p in hk["paths"]]
    assert means == sorted(means, reverse=True)
    assert hk["total_paths"] == 14


def test_review_is_empty_for_taxonomy_and_enzyme(client):
    assert client.get("/series/export/review", params={"source": "taxonomy", "rank": "family"}).json()["terms"] == []
    assert client.get("/series/export/review", params={"source": "enzyme", "rank": "ec"}).json()["terms"] == []


# ── choices sent with the download ───────────────────────────────────────────

def test_excluding_one_pathway_drops_only_that_block(client):
    full = _rows(client.get("/series/export", params=PARAMS))
    hk_pathways = sorted({r["lineage_ids"].split(" > ")[-2] for r in full if r["annotation_id"] == HK})
    dropped = hk_pathways[0]
    rows = _rows(_post(client, "/series/export", [[HK, dropped]]))
    assert len(rows) == len(full) - SAMPLES
    left = {r["lineage_ids"].split(" > ")[-2] for r in rows if r["annotation_id"] == HK}
    assert left == set(hk_pathways) - {dropped}
    summary = _post(client, "/series/export/summary", [[HK, dropped]]).json()
    assert summary["max_rows"] == len(rows)


def test_excluding_every_pathway_of_a_ko_removes_it(client):
    full = _rows(client.get("/series/export", params=PARAMS))
    hk_pathways = sorted({r["lineage_ids"].split(" > ")[-2] for r in full if r["annotation_id"] == HK})
    exclude = [[HK, p] for p in hk_pathways]
    rows = _rows(_post(client, "/series/export", exclude))
    assert HK not in {r["annotation_id"] for r in rows}
    before = client.get("/series/export/summary", params=PARAMS).json()
    after = _post(client, "/series/export/summary", exclude).json()
    assert after["taxa"] == before["taxa"] - 1


def test_a_ko_left_with_one_pathway_is_no_longer_flagged(client):
    full = _rows(client.get("/series/export", params=PARAMS))
    hk_pathways = sorted({r["lineage_ids"].split(" > ")[-2] for r in full if r["annotation_id"] == HK})
    rows = _rows(_post(client, "/series/export", [[HK, p] for p in hk_pathways[1:]]))
    hk_rows = [r for r in rows if r["annotation_id"] == HK]
    assert len(hk_rows) == SAMPLES
    assert all(r["also_in_other_paths"] == "false" for r in hk_rows)


def test_post_without_exclusions_matches_get(client):
    assert _post(client, "/series/export", []).text == client.get("/series/export", params=PARAMS).text


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
    resp = _post(client, "/series/export", [["x", "y"]], params={"source": "taxonomy", "rank": "phylum"})
    assert resp.status_code == 400
