"""
test_mappings_export_route.py
==============================
/mappings/export and /mappings/export/summary: the Mappings panel's
"Export all" download. The export must contain every gene record for the
annotation in the chosen date range (no 50,000-row cut-off), in date order,
or be refused outright above MAPPINGS_EXPORT_MAX_ROWS -- never a silent
partial file.

Runs against the real local database through FastAPI's TestClient.

Run:
    pytest tests/sql/test_mappings_export_route.py -v
"""

import csv
import io
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))
from api.config import SQLITE_DB_PATH
from api.index import get_timepoint, timepoint_dt_sort_key

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# pylint: disable=redefined-outer-name

EXPORT_COLUMNS = [
    "annotation_id", "source", "sample", "date", "time", "gene_id", "scaffold_id",
    "taxonomy", "kegg_id", "enzyme", "cog_id",
]


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as c:
        yield c


def _gene_count_total(source, annotation_id, samples=None):
    """SUM(gene_count) straight from annotation_series: one mapping row per
    gene per sample, so this is the number of rows a complete export holds."""
    conn = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT sample, gene_count FROM annotation_series WHERE source = ? AND annotation_id = ?",
            (source, annotation_id),
        ).fetchall()
    finally:
        conn.close()
    return sum(n for s, n in rows if samples is None or s in samples)


def _export_rows(client, **params):
    resp = client.get("/mappings/export", params=params)
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    reader = csv.reader(io.StringIO(resp.text))
    header = next(reader)
    return header, list(reader)


def test_summary_counts_every_gene_record(client):
    resp = client.get("/mappings/export/summary", params={"annotation_id": "K02112", "source": "kegg"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["rows"] == _gene_count_total("kegg", "K02112")
    assert body["samples"] == 128
    assert body["max_rows"] == 5_000_000


def test_export_of_a_leaf_has_every_row_and_the_documented_columns(client):
    header, rows = _export_rows(client, annotation_id="K02112", source="kegg")
    assert header == EXPORT_COLUMNS
    assert len(rows) == _gene_count_total("kegg", "K02112")
    assert all(r[0] == "K02112" and r[1] == "kegg" for r in rows)
    assert all(r[8] == "KO:K02112" for r in rows)
    assert all(r[5] and r[6] for r in rows), "every row names its gene and scaffold"


def test_export_goes_past_the_old_50000_row_limit(client):
    """COG0006 (one COG) and EC 1.1.99 (a sub-subclass) each have just over
    50,000 gene records. The old Export all stopped at exactly 50,000."""
    for source, annotation_id in [("cog", "COG0006"), ("enzyme", "1.1.99")]:
        expected = _gene_count_total(source, annotation_id)
        assert expected > 50_000
        _, rows = _export_rows(client, annotation_id=annotation_id, source=source)
        assert len(rows) == expected, f"{source} {annotation_id}"
        assert len({(r[2], r[5]) for r in rows}) == expected, "one row per gene per sample"


def test_export_rows_are_in_date_order_then_gene(client):
    _, rows = _export_rows(client, annotation_id="K02112", source="kegg")
    keys = [(r[3], r[4], r[2], r[5]) for r in rows]
    assert keys == sorted(keys)


def test_export_dates_match_the_sample_timepoint(client):
    _, rows = _export_rows(client, annotation_id="K02112", source="kegg")
    from datetime import datetime
    for r in rows[:500]:
        raw = get_timepoint(r[2])["datetime"]
        parsed = datetime.strptime(f"{r[3]} {r[4]}", "%Y-%m-%d %H:%M")
        assert timepoint_dt_sort_key(raw) == timepoint_dt_sort_key(parsed.strftime("%m/%d/%y %H:%M"))


def test_date_range_narrows_to_whole_samples_in_range(client):
    params = {"annotation_id": "K02112", "source": "kegg", "date_from": "2021-06-02", "date_to": "2021-06-04"}
    summary = client.get("/mappings/export/summary", params=params).json()
    _, rows = _export_rows(client, **params)
    samples_in_file = {r[2] for r in rows}
    assert 0 < summary["samples"] < 128
    assert len(samples_in_file) <= summary["samples"]
    assert all("2021-06-02" <= r[3] <= "2021-06-04" for r in rows)
    assert len(rows) == summary["rows"] == _gene_count_total("kegg", "K02112", samples_in_file)


def test_unique_pairs_keeps_one_row_per_annotation_combination(client):
    _, everything = _export_rows(client, annotation_id="K02112", source="kegg")
    _, unique = _export_rows(client, annotation_id="K02112", source="kegg", unique_pairs="true")
    combo = lambda r: (r[7], r[8], r[9], r[10])
    assert len(unique) == len({combo(r) for r in everything}) < len(everything)
    # The earliest occurrence of each combination is the one kept.
    first_seen = {}
    for r in everything:
        first_seen.setdefault(combo(r), r)
    assert all(first_seen[combo(r)] == r for r in unique)


def test_export_over_the_ceiling_is_refused_not_cut_short(client):
    summary = client.get("/mappings/export/summary", params={"annotation_id": "Bacteria", "source": "taxonomy"}).json()
    assert summary["rows"] > summary["max_rows"]
    resp = client.get("/mappings/export", params={"annotation_id": "Bacteria", "source": "taxonomy"})
    assert resp.status_code == 413
    assert "5,000,000" in resp.json()["detail"]


def test_unknown_id_is_404(client):
    for path in ("/mappings/export", "/mappings/export/summary"):
        resp = client.get(path, params={"annotation_id": "COG0006", "source": "kegg"})
        assert resp.status_code == 404


def test_bad_date_is_400(client):
    resp = client.get(
        "/mappings/export/summary",
        params={"annotation_id": "K02112", "source": "kegg", "date_from": "June 2"},
    )
    assert resp.status_code == 400
