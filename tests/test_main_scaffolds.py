"""
test_main_scaffolds.py
======================
Unit + integration tests for:
  - GET /annotations/scaffolds
  - GET /annotations/scaffolds/summary

These hit the REAL FastAPI app (main.app -> api.routes.annotation_scaffolds /
annotation_scaffolds_summary) with cache/routes I/O patched to synthetic
data, rather than a hand-copied mirror endpoint. A hand-copied mirror would
keep passing even if the real implementation in api/routes.py broke, since
it tests its own duplicate logic instead of the production code path.

Reflects the current flat annotation JSON format:

    {
        "COG0055": {
            "name": "COG0055",
            "category": "C",
            "egc": 7092.0,
            "norm_egc": 0.0008545976558574283,
            "scaffolds": {
                "Ga0590986_0000001": 1,
                "Ga0590986_0000003": 2,
                ...
            }
        }
    }

Run with:
    pytest tests/test_main_scaffolds.py -v

Requirements:
    pip install pytest httpx fastapi
"""

import pytest

from api.cache import AnnotationSource

# ---------------------------------------------------------------------------
# Shared fake data
# ---------------------------------------------------------------------------

# Datetimes use the "%Y-%m-%d %H:%M:%S" form, one of the three formats
# api.index._parse_any_datetime actually accepts — using an unsupported
# format here would make timepoint_dt_sort_key() silently return -1.0 for
# every row, and the "sorted chronologically" tests below would pass by
# coincidence (stable-sort on equal keys) rather than by actually exercising
# the real sort.
FAKE_TIMEPOINTS = {
    "sample_001": {"taxon_oid": "sample_001", "timepoint": "T1", "datetime": "2021-05-10 08:00:00"},
    "sample_002": {"taxon_oid": "sample_002", "timepoint": "T2", "datetime": "2021-05-10 12:00:00"},
    "sample_003": {"taxon_oid": "sample_003", "timepoint": "T3", "datetime": "2021-05-11 08:00:00"},
}

# Per-sample annotation data in the current flat format.
# sample_001: COG0055 has 3 scaffolds, COG9999 has 1
# sample_002: COG0055 has 2 scaffolds
# sample_003: COG0055 absent (tests missing-sample handling)
FAKE_COG_DATA: dict[str, dict] = {
    "sample_001": {
        "COG0055": {
            "name":     "Succinate dehydrogenase",
            "category": "C",
            "egc":      7092.0,
            "norm_egc": 0.00085,
            "scaffolds": {
                "Ga0590986_0000001": 1,
                "Ga0590986_0000003": 2,
                "Ga0590986_0000170": 1,
            },
        },
        "COG9999": {
            "name":     "Hypothetical protein",
            "category": "S",
            "egc":      100.0,
            "norm_egc": 0.00001,
            "scaffolds": {
                "Ga0590986_9999999": 3,
            },
        },
    },
    "sample_002": {
        "COG0055": {
            "name":     "Succinate dehydrogenase",
            "category": "C",
            "egc":      5000.0,
            "norm_egc": 0.00060,
            "scaffolds": {
                "Ga0590986_0000010": 4,
                "Ga0590986_0000020": 1,
            },
        },
    },
    "sample_003": {
        # COG0055 deliberately absent — tests that missing samples are skipped
        "COG9999": {
            "name":     "Hypothetical protein",
            "category": "S",
            "egc":      200.0,
            "norm_egc": 0.00002,
            "scaffolds": {
                "Ga0590986_9999998": 1,
            },
        },
    },
}


# ---------------------------------------------------------------------------
# TestClient against the real app, with cache/routes I/O patched
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client():
    import api.cache  as cache_mod
    import api.routes as routes_mod
    from fastapi.testclient import TestClient
    from main import app

    orig_timepoints = cache_mod.TIMEPOINTS
    orig_get_all = routes_mod.get_all_sample_names
    orig_load_by_source = routes_mod.load_annotations_by_source

    cache_mod.TIMEPOINTS = FAKE_TIMEPOINTS

    def _fake_get_all_samples():
        return sorted(FAKE_TIMEPOINTS.keys())

    def _fake_load_by_source(sample_name, source):
        if source == AnnotationSource.cog:
            return FAKE_COG_DATA.get(sample_name, {})
        return {}

    routes_mod.get_all_sample_names = _fake_get_all_samples
    routes_mod.load_annotations_by_source = _fake_load_by_source

    test_client = TestClient(app, raise_server_exceptions=False)
    yield test_client

    cache_mod.TIMEPOINTS = orig_timepoints
    routes_mod.get_all_sample_names = orig_get_all
    routes_mod.load_annotations_by_source = orig_load_by_source


# ---------------------------------------------------------------------------
# /annotations/scaffolds — detail endpoint
# ---------------------------------------------------------------------------

class TestScaffoldsDetail:

    def test_200_for_known_annotation(self, client):
        r = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055")
        assert r.status_code == 200

    def test_404_for_unknown_annotation(self, client):
        r = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0000")
        assert r.status_code == 404

    def test_404_for_wrong_source(self, client):
        # COG data exists but kegg loader returns nothing
        r = client.get("/annotations/scaffolds?source=kegg&annotation_id=COG0055")
        assert r.status_code == 404

    def test_422_missing_source(self, client):
        r = client.get("/annotations/scaffolds?annotation_id=COG0055")
        assert r.status_code == 422

    def test_422_missing_annotation_id(self, client):
        r = client.get("/annotations/scaffolds?source=cog")
        assert r.status_code == 422

    def test_422_invalid_source(self, client):
        r = client.get("/annotations/scaffolds?source=invalid&annotation_id=COG0055")
        assert r.status_code == 422

    # Response shape --------------------------------------------------------

    def test_envelope_fields_present(self, client):
        body = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        assert "annotation_id" in body
        assert "source" in body
        assert "total" in body
        assert "data" in body
        assert isinstance(body["data"], list)

    def test_annotation_id_echoed(self, client):
        body = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        assert body["annotation_id"] == "COG0055"

    def test_source_echoed(self, client):
        body = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        assert body["source"] == "cog"

    def test_total_matches_data_length(self, client):
        body = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        assert body["total"] == len(body["data"])

    def test_row_has_required_fields(self, client):
        body = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        row  = body["data"][0]
        assert "sample"   in row
        assert "date"     in row
        assert "scaffold" in row
        assert "count"    in row

    # Row count correctness -------------------------------------------------

    def test_correct_total_row_count(self, client):
        # sample_001: 3 scaffolds + sample_002: 2 scaffolds = 5 rows
        # sample_003 has no COG0055 entry → excluded
        body = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        assert body["total"] == 5

    def test_sample_with_no_annotation_excluded(self, client):
        body    = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        samples = {r["sample"] for r in body["data"]}
        assert "sample_003" not in samples

    def test_all_scaffolds_for_sample_001_present(self, client):
        body      = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        s1_rows   = [r for r in body["data"] if r["sample"] == "sample_001"]
        scaffolds = {r["scaffold"] for r in s1_rows}
        assert scaffolds == {"Ga0590986_0000001", "Ga0590986_0000003", "Ga0590986_0000170"}

    def test_scaffold_counts_preserved(self, client):
        body  = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        row   = next(r for r in body["data"]
                     if r["sample"] == "sample_001" and r["scaffold"] == "Ga0590986_0000003")
        assert row["count"] == 2  # stored as 2 in fake data

    def test_cog9999_only_returns_its_own_scaffolds(self, client):
        body      = client.get("/annotations/scaffolds?source=cog&annotation_id=COG9999").json()
        scaffolds = {r["scaffold"] for r in body["data"]}
        # COG0055 scaffolds must not appear
        assert "Ga0590986_0000001" not in scaffolds
        assert "Ga0590986_9999999" in scaffolds or "Ga0590986_9999998" in scaffolds

    # Ordering --------------------------------------------------------------

    def test_rows_sorted_chronologically(self, client):
        body  = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        dates = [r["date"] for r in body["data"] if r["date"]]
        assert dates == sorted(dates)

    def test_sample_001_rows_before_sample_002(self, client):
        body     = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        samples  = [r["sample"] for r in body["data"]]
        last_s1  = max(i for i, s in enumerate(samples) if s == "sample_001")
        first_s2 = min(i for i, s in enumerate(samples) if s == "sample_002")
        assert last_s1 < first_s2

    # Date resolution -------------------------------------------------------

    def test_date_resolved_from_timepoint_map(self, client):
        body     = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        s1_dates = {r["date"] for r in body["data"] if r["sample"] == "sample_001"}
        assert s1_dates == {"2021-05-10 08:00:00"}

    def test_sample_002_date_correct(self, client):
        body     = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        s2_dates = {r["date"] for r in body["data"] if r["sample"] == "sample_002"}
        assert s2_dates == {"2021-05-10 12:00:00"}


# ---------------------------------------------------------------------------
# /annotations/scaffolds/summary — aggregated endpoint
# ---------------------------------------------------------------------------

class TestScaffoldsSummary:

    def test_200_for_known_annotation(self, client):
        r = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055")
        assert r.status_code == 200

    def test_404_for_unknown_annotation(self, client):
        r = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0000")
        assert r.status_code == 404

    def test_422_missing_source(self, client):
        r = client.get("/annotations/scaffolds/summary?annotation_id=COG0055")
        assert r.status_code == 422

    def test_422_missing_annotation_id(self, client):
        r = client.get("/annotations/scaffolds/summary?source=cog")
        assert r.status_code == 422

    # Response shape --------------------------------------------------------

    def test_envelope_fields_present(self, client):
        body = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        assert "annotation_id" in body
        assert "source"        in body
        assert "total"         in body
        assert "data"          in body

    def test_row_has_required_fields(self, client):
        body = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        row  = body["data"][0]
        assert "sample"         in row
        assert "date"           in row
        assert "scaffold_count" in row
        assert "gene_count"     in row

    def test_total_matches_data_length(self, client):
        body = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        assert body["total"] == len(body["data"])

    # Aggregation correctness -----------------------------------------------

    def test_one_row_per_sample(self, client):
        # COG0055 present in sample_001 and sample_002 only
        body = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        assert body["total"] == 2

    def test_sample_003_excluded(self, client):
        body    = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        samples = {r["sample"] for r in body["data"]}
        assert "sample_003" not in samples

    def test_scaffold_count_sample_001(self, client):
        body = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        row  = next(r for r in body["data"] if r["sample"] == "sample_001")
        assert row["scaffold_count"] == 3  # 3 unique scaffolds

    def test_scaffold_count_sample_002(self, client):
        body = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        row  = next(r for r in body["data"] if r["sample"] == "sample_002")
        assert row["scaffold_count"] == 2

    def test_gene_count_sample_001(self, client):
        # scaffold counts: 1 + 2 + 1 = 4
        body = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        row  = next(r for r in body["data"] if r["sample"] == "sample_001")
        assert row["gene_count"] == 4

    def test_gene_count_sample_002(self, client):
        # scaffold counts: 4 + 1 = 5
        body = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        row  = next(r for r in body["data"] if r["sample"] == "sample_002")
        assert row["gene_count"] == 5

    def test_summary_and_detail_sample_sets_match(self, client):
        """The two endpoints must agree on which samples have data."""
        detail  = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        summary = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        detail_samples  = {r["sample"] for r in detail["data"]}
        summary_samples = {r["sample"] for r in summary["data"]}
        assert detail_samples == summary_samples

    def test_summary_gene_count_equals_sum_of_detail_counts(self, client):
        """summary.gene_count must equal the sum of detail.count for the same sample."""
        detail  = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        summary = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        for s_row in summary["data"]:
            sample     = s_row["sample"]
            detail_sum = sum(r["count"] for r in detail["data"] if r["sample"] == sample)
            assert s_row["gene_count"] == detail_sum, (
                f"gene_count mismatch for {sample}: "
                f"summary={s_row['gene_count']}, detail_sum={detail_sum}"
            )

    def test_summary_scaffold_count_equals_detail_row_count(self, client):
        """summary.scaffold_count must equal the number of detail rows for the same sample."""
        detail  = client.get("/annotations/scaffolds?source=cog&annotation_id=COG0055").json()
        summary = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        for s_row in summary["data"]:
            sample       = s_row["sample"]
            detail_count = sum(1 for r in detail["data"] if r["sample"] == sample)
            assert s_row["scaffold_count"] == detail_count, (
                f"scaffold_count mismatch for {sample}: "
                f"summary={s_row['scaffold_count']}, detail_rows={detail_count}"
            )

    # Ordering --------------------------------------------------------------

    def test_summary_sorted_chronologically(self, client):
        body  = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        dates = [r["date"] for r in body["data"] if r["date"]]
        assert dates == sorted(dates)

    def test_sample_001_before_sample_002_in_summary(self, client):
        body    = client.get("/annotations/scaffolds/summary?source=cog&annotation_id=COG0055").json()
        samples = [r["sample"] for r in body["data"]]
        assert samples.index("sample_001") < samples.index("sample_002")
