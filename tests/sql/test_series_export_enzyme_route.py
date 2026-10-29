"""
test_series_export_enzyme_route.py
==================================
Live-HTTP tests for the bulk time-series download with source=enzyme, and
for the "include the starting term's own total" option (include_parent),
which applies to every source. The taxonomy download's own behaviour is
pinned by test_series_export_route.py.

Enzyme levels: class (1), subclass (2), subsubclass (3), ec (4).

Run:
    pytest tests/sql/test_series_export_enzyme_route.py -v
"""

import csv
import io
import os
import sqlite3
import sys
from collections import defaultdict

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

SAMPLES = 128
HEADER = [
    "annotation_id", "name", "level", "lineage_ids", "lineage", "also_in_other_paths", "is_starting_term",
    "sample", "date", "egc", "norm_egc", "detected",
]
TAXONOMY_HEADER = ["taxon", "rank", "lineage", "sample", "date", "egc", "norm_egc", "detected"]
GAMMA = "Bacteria;Proteobacteria;Gammaproteobacteria"


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


def _rows(resp, header=HEADER):
    assert resp.status_code == 200, resp.text
    reader = csv.reader(io.StringIO(resp.text))
    assert next(reader) == header
    return [dict(zip(header, r)) for r in reader]


def _get(client, path, **params):
    return client.get(path, params={"source": "enzyme", **params})


# ── summary ──────────────────────────────────────────────────────────────────

def test_summary_counts_ec_numbers_under_a_sub_subclass(client):
    body = _get(client, "/series/export/summary", parent="5.6.2", rank="ec").json()
    assert body["taxa"] == 2
    assert body["samples"] == SAMPLES
    assert body["max_rows"] == 2 * SAMPLES


def test_summary_counts_the_starting_term_when_included(client):
    body = _get(client, "/series/export/summary", parent="5.6.2", rank="ec", include_parent="true").json()
    assert body["taxa"] == 2
    assert body["max_rows"] == 3 * SAMPLES


def test_summary_whole_dataset_classes(client):
    assert _get(client, "/series/export/summary", rank="class").json()["taxa"] == 7


@pytest.mark.parametrize("params, status", [
    ({"rank": "ec", "parent": "9.9.9"}, 404),          # not a real EC term
    ({"rank": "family"}, 400),                         # a taxonomy rank, not an enzyme level
    ({"rank": "subclass", "parent": "1.1.1"}, 400),    # above the starting term
    ({"rank": "subsubclass", "parent": "1.1.1"}, 400), # same level as the starting term
])
def test_summary_rejects_bad_enzyme_requests(client, params, status):
    assert _get(client, "/series/export/summary", **params).status_code == status


def test_kegg_and_cog_are_still_not_available(client):
    for source in ("kegg", "cog"):
        resp = client.get("/series/export/summary", params={"source": source, "rank": "category"})
        assert resp.status_code == 400


# ── export ───────────────────────────────────────────────────────────────────

def test_export_lists_every_ec_number_in_every_sample(client):
    resp = _get(client, "/series/export", parent="5.6.2", rank="ec")
    rows = _rows(resp)
    assert len(rows) == 2 * SAMPLES
    assert {r["annotation_id"] for r in rows} == {"5.6.2.1", "5.6.2.2"}
    assert all(r["level"] == "ec" for r in rows)
    assert all(r["is_starting_term"] == "false" and r["also_in_other_paths"] == "false" for r in rows)
    assert 'filename="enzyme_5.6.2_ec_timeseries.csv"' in resp.headers["content-disposition"]


def test_export_lineage_ids_and_names(client):
    row = next(r for r in _rows(_get(client, "/series/export", parent="1.1.1", rank="ec")) if r["annotation_id"] == "1.1.1.1")
    assert row["name"] == "alcohol dehydrogenase"
    assert row["lineage_ids"] == "1 > 1.1 > 1.1.1 > 1.1.1.1"
    assert row["lineage"].startswith("Oxidoreductases > ")
    assert row["lineage"].endswith(" > alcohol dehydrogenase")


def test_export_values_match_the_database(client, conn):
    rows = _rows(_get(client, "/series/export", parent="5.6.2", rank="ec"))
    row = next(r for r in rows if r["detected"] == "true")
    egc, norm = conn.execute(
        "SELECT egc, norm_egc FROM annotation_series WHERE source = 'enzyme' AND annotation_id = ? AND sample = ?",
        (row["annotation_id"], row["sample"]),
    ).fetchone()
    assert float(row["egc"]) == egc
    assert float(row["norm_egc"]) == norm


def test_export_can_skip_levels(client, conn):
    rows = _rows(_get(client, "/series/export", parent="1", rank="ec"))
    expected = {r[0] for r in conn.execute("SELECT DISTINCT d_id FROM enzyme_paths WHERE a_id = '1' AND d_id IS NOT NULL")}
    assert {r["annotation_id"] for r in rows} == expected
    assert len(rows) == len(expected) * SAMPLES


def test_starting_term_comes_first_and_is_marked(client):
    rows = _rows(_get(client, "/series/export", parent="5.6.2", rank="ec", include_parent="true"))
    assert len(rows) == 3 * SAMPLES
    start = rows[:SAMPLES]
    assert all(r["annotation_id"] == "5.6.2" and r["is_starting_term"] == "true" for r in start)
    assert all(r["level"] == "subsubclass" and r["lineage_ids"] == "5 > 5.6 > 5.6.2" for r in start)
    assert all(r["is_starting_term"] == "false" for r in rows[SAMPLES:])


def test_starting_term_shows_what_its_children_miss(client):
    """The reason include_parent exists: genes known only as far as 5.6.2
    (split helicase numbers) count towards 5.6.2 but no child, so the
    starting term's total is well above its children's in real samples."""
    rows = _rows(_get(client, "/series/export", parent="5.6.2", rank="ec", include_parent="true"))
    parent = {r["sample"]: float(r["egc"]) for r in rows if r["is_starting_term"] == "true"}
    children = defaultdict(float)
    for r in rows:
        if r["is_starting_term"] == "false":
            children[r["sample"]] += float(r["egc"])
    assert any(parent[s] > 2 * children[s] for s in parent)


def test_include_parent_without_a_start_changes_nothing(client):
    plain = _get(client, "/series/export", rank="class").text
    flagged = _get(client, "/series/export", rank="class", include_parent="true").text
    assert flagged == plain


# ── include_parent for taxonomy ──────────────────────────────────────────────

def test_taxonomy_starting_term_rows_come_first(client):
    resp = client.get("/series/export", params={"source": "taxonomy", "parent": GAMMA, "rank": "family", "include_parent": "true"})
    rows = _rows(resp, TAXONOMY_HEADER)
    assert len(rows) == 77 * SAMPLES
    start = rows[:SAMPLES]
    assert all(r["lineage"] == GAMMA and r["taxon"] == "Gammaproteobacteria" and r["rank"] == "class" for r in start)
    assert all(r["rank"] == "family" for r in rows[SAMPLES:])


def test_taxonomy_without_include_parent_is_unchanged(client):
    plain = client.get("/series/export", params={"source": "taxonomy", "parent": GAMMA, "rank": "family"}).text
    flagged_off = client.get(
        "/series/export", params={"source": "taxonomy", "parent": GAMMA, "rank": "family", "include_parent": "false"},
    ).text
    assert flagged_off == plain
    assert len(plain.strip().split("\n")) == 1 + 76 * SAMPLES
