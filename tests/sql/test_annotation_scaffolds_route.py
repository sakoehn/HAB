"""
test_annotation_scaffolds_route.py
=====================================
Self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER (`with
TestClient(app) as client:`) rather than requiring a separately running
uvicorn server -- see tests/sql/test_samples_and_timepoints_route.py's
module docstring for why the old httpx.Client-against-a-live-server
pattern silently contributed zero coverage in every normal `pytest
tests/` run.

Run:
    pytest tests/sql/test_annotation_scaffolds_route.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import COG_DIR, SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error
from api.index import timepoint_dt_sort_key  # pylint: disable=wrong-import-position,import-error

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# Every test below takes a `client` parameter to receive this fixture's
# value -- pylint sees that as shadowing the module-level `client` name,
# but it's the standard pytest fixture-injection pattern, not a real bug.
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as c:
        yield c


def test_get_annotation_scaffolds(client):
    resp = client.get(
        "/annotations/scaffolds",
        params={"source": "cog", "annotation_id": "COG0055", "sample": 3300060358},
    )
    body = resp.json()

    with open(os.path.join(COG_DIR, "3300060358.cog.json"), encoding="utf-8") as f:
        data = json.load(f)
    entry = data["COG0055"]

    assert {row["scaffold"]: row["count"] for row in body["data"]} == entry["scaffolds"]


def test_get_annotation_scaffold_summary(client):
    resp = client.get(
        "/annotations/scaffolds/summary",
        params={"source": "cog", "annotation_id": "COG0055", "sample": 3300060358}
    )
    expected = {}
    for filename in os.listdir(COG_DIR):
        if not filename.endswith(".cog.json"):
            continue
        sample_name = filename.removesuffix(".cog.json")
        with open(os.path.join(COG_DIR, filename), encoding="utf-8") as f:
            data = json.load(f)
        entry = data.get("COG0055")
        if entry is not None:
            expected[sample_name] = entry

    resp.raise_for_status()
    row = resp.json()

    assert len(row["data"]) == len(expected)
    for r in row["data"]:
        entry = expected[r["sample"]]
        assert r["scaffold_count"] == len(entry["scaffolds"])
        assert r["gene_count"] == sum(entry["scaffolds"].values())


def test_invalid_source(client):
    resp = client.get(
        "/annotations/scaffolds",
        params={"source": "cog", "annotation_id": "INVALID_ID", "sample": 3300060358}
    )
    assert resp.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════
# Param validation + response shape -- ported from test_main_scaffolds.py
# (deleted; it only ever exercised the DATA_BACKEND=='json' branch of these
# two routes with synthetic fixture data, which the ground-truth checks
# above already cover more strongly for the real sql branch). These
# specific scenarios -- missing/invalid params, and ordering, which the
# ground-truth dict comparisons above don't check -- weren't otherwise
# covered here, so they're ported rather than dropped.
# ═══════════════════════════════════════════════════════════════════════════

def test_missing_source_returns_422(client):
    resp = client.get("/annotations/scaffolds", params={"annotation_id": "COG0055"})
    assert resp.status_code == 422


def test_missing_annotation_id_returns_422(client):
    resp = client.get("/annotations/scaffolds", params={"source": "cog"})
    assert resp.status_code == 422


def test_invalid_source_enum_returns_422(client):
    resp = client.get(
        "/annotations/scaffolds",
        params={"source": "not_a_real_source", "annotation_id": "COG0055"},
    )
    assert resp.status_code == 422


def test_envelope_fields_present(client):
    body = client.get(
        "/annotations/scaffolds",
        params={"source": "cog", "annotation_id": "COG0055", "sample": 3300060358},
    ).json()
    assert {"annotation_id", "source", "total", "data"} <= body.keys()
    assert body["total"] == len(body["data"])


def test_rows_sorted_chronologically(client):
    """Not covered by the ground-truth dict comparisons above, which are
    order-insensitive by construction. Real dates are unpadded "M/D/YY
    H:MM" strings (e.g. "6/2/21 9:00") -- a plain string sort disagrees
    with real chronological order (e.g. "6/10/21" < "6/2/21" as text), so
    this must compare via timepoint_dt_sort_key like the route itself
    does, not sort dates directly."""
    body = client.get(
        "/annotations/scaffolds",
        params={"source": "cog", "annotation_id": "COG0055"},
    ).json()
    keys = [timepoint_dt_sort_key(r["date"]) for r in body["data"] if r["date"]]
    assert keys == sorted(keys)


def test_summary_missing_source_returns_422(client):
    resp = client.get("/annotations/scaffolds/summary", params={"annotation_id": "COG0055"})
    assert resp.status_code == 422


def test_summary_missing_annotation_id_returns_422(client):
    resp = client.get("/annotations/scaffolds/summary", params={"source": "cog"})
    assert resp.status_code == 422


def test_summary_sorted_chronologically(client):
    """Same timepoint_dt_sort_key requirement as test_rows_sorted_chronologically
    above -- real dates are unpadded "M/D/YY H:MM" strings, not plain-string-sortable."""
    body = client.get(
        "/annotations/scaffolds/summary",
        params={"source": "cog", "annotation_id": "COG0055"},
    ).json()
    keys = [timepoint_dt_sort_key(r["date"]) for r in body["data"] if r["date"]]
    assert keys == sorted(keys)


# ═══════════════════════════════════════════════════════════════════════════
# Cross-endpoint consistency -- ported from test_main_scaffolds.py. Each
# route is already checked against ground truth independently above, which
# should imply agreement between them -- but that's an inference, not a
# direct check, so it's worth verifying as its own invariant too.
# ═══════════════════════════════════════════════════════════════════════════

def test_summary_and_detail_agree_on_which_samples_have_data(client):
    """COG0055 has 29,307 total scaffold rows across all 128 samples
    (confirmed via direct DB query) -- far past any single page, so the
    summary-derived sample list is cross-checked by requesting each sample
    from detail individually via the route's own `sample` filter, not by
    paginating the unfiltered combined call."""
    summary = client.get(
        "/annotations/scaffolds/summary",
        params={"source": "cog", "annotation_id": "COG0055"},
    ).json()
    summary_samples = {r["sample"] for r in summary["data"]}

    for sample in summary_samples:
        detail = client.get(
            "/annotations/scaffolds",
            params={"source": "cog", "annotation_id": "COG0055", "sample": sample},
        )
        assert detail.status_code == 200, f"sample {sample} in summary but 404 in detail"


def test_summary_gene_count_equals_sum_of_detail_counts(client):
    summary = client.get(
        "/annotations/scaffolds/summary",
        params={"source": "cog", "annotation_id": "COG0055"},
    ).json()
    for s_row in summary["data"]:
        sample = s_row["sample"]
        detail = client.get(
            "/annotations/scaffolds",
            params={"source": "cog", "annotation_id": "COG0055", "sample": sample, "page_size": 5000},
        ).json()
        detail_sum = sum(r["count"] for r in detail["data"])
        assert s_row["gene_count"] == detail_sum, (
            f"gene_count mismatch for {sample}: "
            f"summary={s_row['gene_count']}, detail_sum={detail_sum}"
        )


def test_summary_scaffold_count_equals_detail_row_count(client):
    summary = client.get(
        "/annotations/scaffolds/summary",
        params={"source": "cog", "annotation_id": "COG0055"},
    ).json()
    for s_row in summary["data"]:
        sample = s_row["sample"]
        detail = client.get(
            "/annotations/scaffolds",
            params={"source": "cog", "annotation_id": "COG0055", "sample": sample, "page_size": 5000},
        ).json()
        assert s_row["scaffold_count"] == len(detail["data"]), (
            f"scaffold_count mismatch for {sample}: "
            f"summary={s_row['scaffold_count']}, detail_rows={len(detail['data'])}"
        )
