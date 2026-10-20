"""
test_egc_api_vs_jgi.py
======================
Phase 3 — Live API validation (server must be running).

Compares EGC values from the FastAPI backend against JGI ground-truth tables,
and verifies norm_egc is present, in range, and mathematically consistent.

ID format note
--------------
JGI's own ground-truth files label KEGG entries "KO:K00001". The backend's
KEGG JSON (DataStructures/Kegg/<sample>.ko.json) and therefore the live API
use the bare "K00001" form with no prefix (confirmed against the on-disk
JSON — see test_annotation_trees.py for the authoritative format docs).
This file always queries the API with the bare form and only re-attaches
"KO:" when looking a value up in kegg_jgi_table (the JGI fixture, which
legitimately keeps JGI's own prefixed format).

Scope
-----
- Series endpoint (/series/annotations): single-copy COGs + first 10 KEGG

Removed 2026-09-24: this file used to also have a TestPerSampleStructure
class checking /samples/<id>/<source> (structure only, not value
comparison against JGI). Those 8 per-sample routes were deliberately
deleted as dead routes — this class was
never updated to match and had been failing on every run since. The one
property it checked that isn't redundant with the series tests above --
COG and KEGG per-sample entries sharing the same depth denominator -- is
covered more rigorously by tests/test_weighted_totals.py's
TestNormEgcMatchesSqlDatabase, which checks all 4 sources (not just 2)
against an independently computed ground-truth denominator, not just
against each other.

All tests skip automatically when the server is not reachable.

Run:
    pytest Tests/test_egc_api_vs_jgi.py -v
    pytest Tests/test_egc_api_vs_jgi.py -v -m api
"""

import pytest
import httpx

from conftest import (
    API_BASE_URL,
    EGC_ABS_FLOOR,
    EGC_PCT_TOLERANCE,
    NORM_TOLERANCE,
    egc_within_tolerance,
)

# Single-copy COGs — safe to compare against JGI via the series endpoint
SINGLE_COPY_COGS = [
    "COG0001", "COG0002", "COG0004", "COG0005",
    "COG0007", "COG0008", "COG0009",
]


# ── Server availability guard ─────────────────────────────────────────────────

def _server_is_up() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/status", timeout=5.0)
        return r.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


server_required = pytest.mark.skipif(
    not _server_is_up(),
    reason=(
        f"FastAPI server not reachable at {API_BASE_URL}. "
        "Start with `uvicorn main:app --reload` then re-run."
    ),
)


# ── Response helpers ──────────────────────────────────────────────────────────

def _bare_kegg(jgi_ann_id: str) -> str:
    """Strip JGI's 'KO:' prefix — the backend JSON/API use bare K##### IDs."""
    return jgi_ann_id[3:] if jgi_ann_id.startswith("KO:") else jgi_ann_id


def _series(client: httpx.Client, source: str, ann_id: str) -> dict:
    r = client.get(
        "/series/annotations",
        params={"source": source, "annotation_id": ann_id},
    )
    r.raise_for_status()
    return r.json()


def _series_egc(series: dict) -> dict[str, float]:
    return {
        row["sample"]: float(row["egc"])
        for row in series.get("data", [])
        if "sample" in row and row.get("egc") is not None
    }


def _series_rows(series: dict) -> list[dict]:
    return series.get("data", [])


def _fmt(ann: str, sid: str, backend: float, jgi: float) -> str:
    tol  = max(EGC_ABS_FLOOR, jgi * EGC_PCT_TOLERANCE)
    diff = abs(backend - jgi)
    pct  = diff / jgi * 100 if jgi else 0
    return (
        f"  {ann}/{sid}: API={backend}, JGI={jgi}, "
        f"diff={diff:.1f} ({pct:.1f}%), tol={tol:.1f}"
    )


# ── API availability ──────────────────────────────────────────────────────────

@pytest.mark.api
@server_required
class TestAPIAvailability:

    def test_status_returns_200(self, api_client):
        assert api_client.get("/status").status_code == 200

    def test_api_reports_ready(self, api_client):
        body = api_client.get("/status").json()
        ready = (
            body.get("status") == "ready"
            or body.get("ready") is True
            or body.get("index_ready") is True
        )
        assert ready, f"Backend not ready: {body}"

    def test_timepoints_returns_128_samples(self, api_client):
        r    = api_client.get("/timepoints", params={"page_size": 200})
        body = r.json()
        n    = len(body) if isinstance(body, list) else (
            body.get("total") or len(body.get("data", []))
        )
        assert n >= 128, f"Expected ≥128 timepoints, got {n}"


# ── COG: series endpoint vs JGI ──────────────────────────────────────────────

@pytest.mark.api
@server_required
class TestCOGApiSeriesVsJGI:
    """
    Validates COG EGC from /series/annotations against JGI ground truth.
    Only single-copy COGs are checked — they match JGI within tolerance.
    High-copy paralogs (COG0006, COG0010) are explicitly excluded because
    scaffold-level coverage legitimately diverges from JGI by up to ~17%.
    """

    def test_cog0001_all_samples(self, api_client, cog_jgi_table):
        jgi_row = cog_jgi_table.get("COG0001", {})
        backend = _series_egc(_series(api_client, "cog", "COG0001"))
        assert backend, "Empty series for COG0001"
        mismatches = [
            _fmt("COG0001", sid, backend[sid], jgi)
            for sid, jgi in jgi_row.items()
            if sid in backend and not egc_within_tolerance(backend[sid], jgi)
        ]
        assert not mismatches, (
            f"COG0001 mismatches ({len(mismatches)}):\n" + "\n".join(mismatches)
        )

    @pytest.mark.parametrize("ann_id", SINGLE_COPY_COGS)
    def test_single_copy_cog_all_samples(
        self, api_client, cog_jgi_table, ann_id
    ):
        jgi_row = cog_jgi_table.get(ann_id, {})
        if not jgi_row:
            pytest.skip(f"{ann_id} not in JGI table")
        backend = _series_egc(_series(api_client, "cog", ann_id))
        mismatches = [
            _fmt(ann_id, sid, backend[sid], jgi)
            for sid, jgi in jgi_row.items()
            if sid in backend and not egc_within_tolerance(backend[sid], jgi)
        ]
        assert not mismatches, (
            f"{ann_id} mismatches ({len(mismatches)}):\n"
            + "\n".join(mismatches[:10])
        )


# ── KEGG: series endpoint vs JGI ─────────────────────────────────────────────

@pytest.mark.api
@server_required
class TestKEGGApiSeriesVsJGI:
    """KEGG genes are single-copy — the full first-10 sweep is meaningful."""

    def test_k00001_all_samples(self, api_client, kegg_jgi_table):
        jgi_row = kegg_jgi_table.get("KO:K00001", {})
        backend = _series_egc(_series(api_client, "kegg", _bare_kegg("KO:K00001")))
        assert backend
        mismatches = [
            _fmt("KO:K00001", sid, backend[sid], jgi)
            for sid, jgi in jgi_row.items()
            if sid in backend and not egc_within_tolerance(backend[sid], jgi)
        ]
        assert not mismatches, (
            f"KO:K00001 mismatches ({len(mismatches)}):\n" + "\n".join(mismatches)
        )

    @pytest.mark.parametrize("ann_id", [
        "KO:K00001", "KO:K00002", "KO:K00003", "KO:K00004", "KO:K00005",
        "KO:K00006", "KO:K00007", "KO:K00008", "KO:K00009", "KO:K00010",
    ])
    def test_kegg_first_10_all_samples(
        self, api_client, kegg_jgi_table, ann_id
    ):
        jgi_row = kegg_jgi_table.get(ann_id, {})
        if not jgi_row:
            pytest.skip(f"{ann_id} not in JGI table")
        backend = _series_egc(_series(api_client, "kegg", _bare_kegg(ann_id)))
        mismatches = [
            _fmt(ann_id, sid, backend[sid], jgi)
            for sid, jgi in jgi_row.items()
            if sid in backend and not egc_within_tolerance(backend[sid], jgi)
        ]
        assert not mismatches, (
            f"{ann_id} mismatches ({len(mismatches)}):\n"
            + "\n".join(mismatches[:10])
        )


# ── norm_egc: field presence in series response ───────────────────────────────

@pytest.mark.api
@server_required
class TestNormEGCInSeriesResponse:

    def test_cog_series_has_norm_egc(self, api_client):
        rows = _series_rows(_series(api_client, "cog", "COG0001"))
        assert rows
        missing = [r.get("sample") for r in rows if "norm_egc" not in r]
        assert not missing, f"norm_egc absent from {len(missing)} COG0001 rows"

    def test_kegg_series_has_norm_egc(self, api_client):
        rows = _series_rows(_series(api_client, "kegg", "K00001"))
        assert rows
        missing = [r.get("sample") for r in rows if "norm_egc" not in r]
        assert not missing, f"norm_egc absent from {len(missing)} K00001 rows"

    def test_cog_series_norm_egc_in_range(self, api_client):
        rows = _series_rows(_series(api_client, "cog", "COG0001"))
        bad = [
            f"  {r.get('sample')}: {r['norm_egc']}"
            for r in rows if "norm_egc" in r
            and (float(r["norm_egc"]) <= 0 or float(r["norm_egc"]) > 1 + NORM_TOLERANCE)
        ]
        assert not bad, "COG0001 norm_egc out of range:\n" + "\n".join(bad)

    def test_kegg_series_norm_egc_in_range(self, api_client):
        rows = _series_rows(_series(api_client, "kegg", "K00001"))
        bad = [
            f"  {r.get('sample')}: {r['norm_egc']}"
            for r in rows if "norm_egc" in r
            and (float(r["norm_egc"]) <= 0 or float(r["norm_egc"]) > 1 + NORM_TOLERANCE)
        ]
        assert not bad, "K00001 norm_egc out of range:\n" + "\n".join(bad)