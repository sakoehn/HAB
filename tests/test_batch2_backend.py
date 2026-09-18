"""
Tests/test_batch2_backend.py
============================
Batch 2 backend tests covering:

Item 5  — /mappings/search speed + date/time in response
Item 8  — /api/status returns date_min / date_max

(Item 6, /annotations/correlate concurrency fix, tested the now-deleted
api/correlation.py -- an unregistered, orphaned module superseded by
correlation_sql.py before this file was even written. Removed along with
its tests as part of the JSON-backend-retirement scoping work; see
project memory "json-backend-retirement-scope" for the full inventory.)

REFACTORED FOR MODULE SPLIT
----------------------------
All imports now reference the split api.* modules instead of a flat main.py.
Public names that moved:

  OLD (main.py)                  NEW location
  ─────────────────────────────────────────────────────
  api_status                  -> api.routes.api_status  (via routes.router)
  search_mappings             -> api.routes.search_mappings
  AnnotationSource            -> api.cache.AnnotationSource
  TIMEPOINTS                  -> api.cache.TIMEPOINTS
  _TSV_CACHE                  -> api.cache._TSV_CACHE
  _MAPPING_INDEX              -> api.index._MAPPING_INDEX
  _INDEX_READY                -> api.index._INDEX_READY
  _compute_date_range         -> api.index.compute_date_range
  get_all_sample_names        -> api.cache.get_all_sample_names

Run with:  pytest Tests/test_batch2_backend.py -v
"""

import pytest
import time
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ── Stand-in Request for calling DATA_BACKEND=sql routes directly ───────────
# search_mappings() (and other sql-backed routes) reads the SQLite connection
# main.py's lifespan() normally stores at request.app.state.sql_conn. Calling
# the route function directly -- not through a live server or the
# patched_client fixture (which only patches JSON-backend internals, see
# test_unit_backend.py's TestRoutesViaTestClient) -- needs a minimal stand-in
# exposing that one attribute path instead of a full ASGI Request.

class _FakeAppState:
    def __init__(self, sql_conn):
        self.sql_conn = sql_conn


class _FakeApp:
    def __init__(self, sql_conn):
        self.state = _FakeAppState(sql_conn)


class _FakeRequest:
    def __init__(self, sql_conn):
        self.app = _FakeApp(sql_conn)


@pytest.fixture
def sql_request():
    from api.config import SQLITE_DB_PATH
    if not os.path.exists(SQLITE_DB_PATH):
        pytest.skip(f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first")
    from api.db import connect_to_sql, close_sql_connection
    conn = connect_to_sql()
    yield _FakeRequest(conn)
    close_sql_connection(conn)


# ─────────────────────────────────────────────────────────────────────────────
# ITEM 8 — /api/status date range
# ─────────────────────────────────────────────────────────────────────────────

class TestStatusDateRange:
    """
    /api/status must return date_min and date_max as ISO YYYY-MM-DD strings
    derived from the timepoints CSV at startup.
    """

    def test_status_has_date_min_field(self):
        from api.routes import api_status
        result = api_status()
        assert "date_min" in result, "/api/status must include date_min"

    def test_status_has_date_max_field(self):
        from api.routes import api_status
        result = api_status()
        assert "date_max" in result, "/api/status must include date_max"

    def test_status_has_index_ready_field(self):
        from api.routes import api_status
        result = api_status()
        assert "index_ready" in result

    def test_date_min_is_string_or_none(self):
        from api.routes import api_status
        result = api_status()
        assert result["date_min"] is None or isinstance(result["date_min"], str)

    def test_date_max_is_string_or_none(self):
        from api.routes import api_status
        result = api_status()
        assert result["date_max"] is None or isinstance(result["date_max"], str)

    def test_date_min_format_when_present(self):
        """date_min must be YYYY-MM-DD when timepoints data exists."""
        from api.routes import api_status
        from api.cache import TIMEPOINTS
        if not TIMEPOINTS:
            pytest.skip("No timepoints CSV found — skipping format test")
        result = api_status()
        if result["date_min"] is not None:
            import re
            assert re.match(r"^\d{4}-\d{2}-\d{2}$", result["date_min"]), \
                f"date_min '{result['date_min']}' is not YYYY-MM-DD format"

    def test_date_max_format_when_present(self):
        """date_max must be YYYY-MM-DD when timepoints data exists."""
        from api.routes import api_status
        from api.cache import TIMEPOINTS
        if not TIMEPOINTS:
            pytest.skip("No timepoints CSV found — skipping format test")
        result = api_status()
        if result["date_max"] is not None:
            import re
            assert re.match(r"^\d{4}-\d{2}-\d{2}$", result["date_max"]), \
                f"date_max '{result['date_max']}' is not YYYY-MM-DD format"

    def test_date_min_before_date_max(self):
        """date_min must be chronologically before date_max."""
        from api.routes import api_status
        from api.cache import TIMEPOINTS
        if not TIMEPOINTS:
            pytest.skip("No timepoints data")
        result = api_status()
        if result["date_min"] and result["date_max"]:
            assert result["date_min"] <= result["date_max"], \
                f"date_min ({result['date_min']}) is after date_max ({result['date_max']})"

    def test_compute_date_range_with_known_datetimes(self):
        """Unit test compute_date_range() directly with a patched TIMEPOINTS."""
        import api.cache as cache_mod
        import api.index as index_mod

        original_tp = cache_mod.TIMEPOINTS
        original_min = index_mod.DATA_DATE_MIN
        original_max = index_mod.DATA_DATE_MAX

        cache_mod.TIMEPOINTS = {
            "sample_a": {"datetime": "05/27/21 08:00", "taxon_oid": "a", "timepoint": "1"},
            "sample_b": {"datetime": "06/17/21 20:00", "taxon_oid": "b", "timepoint": "2"},
            "sample_c": {"datetime": "06/01/21 12:00", "taxon_oid": "c", "timepoint": "3"},
        }
        try:
            date_min, date_max = index_mod.compute_date_range()
            assert date_min == "2021-05-27", f"Expected 2021-05-27 got {date_min}"
            assert date_max == "2021-06-17", f"Expected 2021-06-17 got {date_max}"
        finally:
            cache_mod.TIMEPOINTS = original_tp
            index_mod.DATA_DATE_MIN = original_min
            index_mod.DATA_DATE_MAX = original_max


# ─────────────────────────────────────────────────────────────────────────────
# ITEM 5 — /mappings/search speed + timepoint in response
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.api
class TestMappingSearch:
    """
    /mappings/search must:
    - Return each row with a 'timepoint' dict (has 'datetime')
    - Use the pre-built _MAPPING_INDEX when available
    - Be fast (< 500ms) for any annotation when index is warm
    """

    def test_mapping_response_has_timepoint_field(self, sql_request):
        """Every row in the mapping response must have a timepoint field."""
        from api.routes import search_mappings
        from api.cache import AnnotationSource, _TSV_CACHE, TIMEPOINTS
        from api.index import _MAPPING_INDEX
        if not _TSV_CACHE and not TIMEPOINTS:
            pytest.skip("No TSV cache or timepoints — run after warmup")
        if not _MAPPING_INDEX.get("kegg"):
            pytest.skip("Mapping index not built yet")

        first_id = next(iter(_MAPPING_INDEX["kegg"]))
        result = search_mappings(
            sql_request,
            annotation_id=first_id,
            source=AnnotationSource.kegg,
            sample_count=10,
        )
        assert "data" in result
        if result["data"]:
            row = result["data"][0]
            assert "timepoint" in row, "Each mapping row must include 'timepoint'"

    def test_mapping_timepoint_has_datetime(self, sql_request):
        """timepoint dict must contain 'datetime' key."""
        from api.routes import search_mappings
        from api.cache import AnnotationSource
        from api.index import _MAPPING_INDEX
        if not _MAPPING_INDEX.get("kegg"):
            pytest.skip("Mapping index not built yet")

        first_id = next(iter(_MAPPING_INDEX["kegg"]))
        result = search_mappings(
            sql_request,
            annotation_id=first_id,
            source=AnnotationSource.kegg,
            sample_count=5,
        )
        for row in result.get("data", []):
            if row.get("timepoint"):
                assert "datetime" in row["timepoint"], \
                    "timepoint dict must have 'datetime' key"

    def test_mapping_rows_sorted_chronologically(self, sql_request):
        """Results should be in chronological order.

        Regression note: this used to assert `datetimes == sorted(datetimes)`
        -- plain lexicographic string sort. The raw datetime strings are
        unpadded ("M/D/YY H:MM", e.g. "5/28/21 1:00"), so a plain string
        sort orders "5/28/21 13:00" before "5/28/21 1:00" (':' > '3'
        byte-wise) -- backwards from real chronological order. This exact
        unpadded-format footgun is already called out in api/index.py's
        is_within_date_range() docstring. The route itself sorts correctly
        via timepoint_dt_sort_key (real datetime parsing, not string
        comparison) -- confirmed by comparing keys() below, the same
        convention tests/sql/test_mappings_search_route.py's
        test_results_sorted_chronologically already uses. Only the test's
        own comparison was wrong, not the route."""
        from api.routes import search_mappings
        from api.cache import AnnotationSource
        from api.index import _MAPPING_INDEX, timepoint_dt_sort_key
        if not _MAPPING_INDEX.get("kegg"):
            pytest.skip("Mapping index not built yet")

        first_id = next(iter(_MAPPING_INDEX["kegg"]))
        result = search_mappings(
            sql_request,
            annotation_id=first_id,
            source=AnnotationSource.kegg,
            sample_count=128,
        )
        datetimes = [
            row["timepoint"]["datetime"]
            for row in result.get("data", [])
            if row.get("timepoint") and row["timepoint"].get("datetime")
        ]
        keys = [timepoint_dt_sort_key(dt) for dt in datetimes]
        assert keys == sorted(keys), \
            "Mapping rows must be sorted chronologically"

    def test_mapping_speed_with_index(self, sql_request):
        """When the index is warm, /mappings/search must complete in < 500ms."""
        from api.routes import search_mappings
        from api.cache import AnnotationSource
        from api.index import _MAPPING_INDEX
        if not _MAPPING_INDEX.get("kegg"):
            pytest.skip("Mapping index not built — speed test requires warm index")

        first_id = next(iter(_MAPPING_INDEX["kegg"]))
        start = time.perf_counter()
        search_mappings(
            sql_request,
            annotation_id=first_id,
            source=AnnotationSource.kegg,
            sample_count=128,
        )
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 500, \
            f"Mapping search took {elapsed_ms:.0f}ms — must be < 500ms with warm index"

    def test_mapping_index_built_at_startup(self):
        """_MAPPING_INDEX must be populated for all 4 sources after warmup."""
        from api.index import _MAPPING_INDEX, _INDEX_READY
        if not _INDEX_READY:
            pytest.skip("Index not ready — run after server warmup")
        for source in ("kegg", "cog", "enzyme", "taxonomy"):
            assert len(_MAPPING_INDEX[source]) > 0, \
                f"_MAPPING_INDEX['{source}'] is empty after index build"

    def test_mapping_index_values_are_sample_row_tuples(self):
        """Each value in _MAPPING_INDEX must be a list of (sample_name, row)
        tuples, where row is a MappingRow NamedTuple (api/cache.py) -- NOT a
        dict. NamedTuple was a deliberate memory-optimisation (see
        MappingRow's own docstring); routes.py's search_mappings() already
        calls row._asdict() at the API-response boundary to keep the JSON
        shape unchanged. This assertion used to say `isinstance(row, dict)`,
        which was already wrong even before the header-row bug below was
        found (a plain assertion against the real, intended row type)."""
        from api.cache import MappingRow
        from api.index import _MAPPING_INDEX
        for source, index in _MAPPING_INDEX.items():
            if not index:
                continue
            first_key = next(iter(index))
            entries = index[first_key]
            assert isinstance(entries, list), \
                f"_MAPPING_INDEX['{source}'][...] must be a list"
            if entries:
                sample_name, row = entries[0]
                assert isinstance(sample_name, str), "First element must be sample_name string"
                assert isinstance(row, MappingRow),  "Second element must be a MappingRow"
            break


class TestLoadTsvHeaderHandling:
    """
    Regression test found incidentally while re-verifying W12's fix (running
    TestMappingSearch against real data for the first time surfaced this):
    load_tsv() (api/cache.py) used a plain csv.reader with no header skip,
    so every sample mapping TSV's own header line
    ("gene_id\\tscaffold_id\\ttaxonomy\\tkegg\\tenzyme\\tcog") was parsed as
    if it were a real data row -- MappingRow(gene_id='gene_id',
    contig_id='scaffold_id', taxonomy='taxonomy', kegg_id='kegg',
    enzyme='enzyme', cog_id='cog') became _TSV_CACHE[sample][0] for every
    one of the 128 samples. That polluted build_mapping_index() with 4 bogus
    entries per source (_MAPPING_INDEX['kegg']['kegg'],
    _MAPPING_INDEX['cog']['cog'], etc.), each falsely "matching" every
    single sample under a literal column-name string instead of a real
    annotation ID.

    Confirmed the SQL analog does NOT have this bug: migrate_mappings_to_sql.py
    reads the same TSVs with csv.DictReader, which treats the first row as
    field names, not data. This bug is confined entirely to the JSON
    backend's load_tsv(), with a trivial one-line fix (skip the header row)
    -- in scope per this audit's standing JSON-retirement precedent for
    trivial, confined fixes.
    """

    def test_header_row_is_not_included_as_a_data_row(self, tmp_path, monkeypatch):
        import api.cache as cache_mod
        monkeypatch.setattr(cache_mod, "MAPPINGS_DIR", str(tmp_path))
        monkeypatch.setattr(cache_mod, "_TSV_CACHE", {})

        (tmp_path / "synthetic_header_sample_mapping.tsv").write_text(
            "gene_id\tscaffold_id\ttaxonomy\tkegg\tenzyme\tcog\n"
            "gene1\tscaf1\tBacteria\tK00001\t1.1.1.1\tCOG0001\n"
        )

        rows = cache_mod.load_tsv("synthetic_header_sample")

        assert len(rows) == 1, (
            f"expected exactly 1 real data row (header row must be excluded), "
            f"got {len(rows)}: {rows}"
        )
        assert rows[0].gene_id == "gene1", f"unexpected first row: {rows[0]!r}"
        assert rows[0].kegg_id == "K00001", f"unexpected first row: {rows[0]!r}"


# ─────────────────────────────────────────────────────────────────────────────
# /taxonomy/children — real, warm-index integration check
#
# test_unit_backend.py::TestTaxonomyChildrenEndpoint already exercises the
# /taxonomy/children contract against a small hand-built 2-level fixture.
# These tests instead run the same endpoint against the real, warm
# _ANN_META['taxonomy'] index built from the actual dataset at startup, to
# catch mismatches the synthetic fixture can't (e.g. a real taxon whose
# 'parent' pointer doesn't round-trip correctly through the lazy-load API).
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.api
class TestTaxonomyHierarchyRealIndex:

    def test_domain_roots_present_in_real_index(self):
        """Calling with no parent must return at least one real domain root."""
        from api.routes import taxonomy_children
        from api.index import _INDEX_READY
        if not _INDEX_READY:
            pytest.skip("Index not ready")

        result = taxonomy_children(parent=None)
        assert result["data"], "No domain roots returned from real taxonomy index"
        for root in result["data"]:
            assert root["depth"] == 1, f"Domain root '{root['annotation_id']}' has depth != 1"

    def test_children_of_real_root_are_registered_in_ann_meta(self):
        """Every child returned for a real root must be a real, known taxon
        whose recorded parent matches the root that was queried."""
        from api.routes import taxonomy_children
        from api.index import _ANN_META, _INDEX_READY
        if not _INDEX_READY:
            pytest.skip("Index not ready")

        meta = _ANN_META["taxonomy"]
        if not meta:
            pytest.skip("Taxonomy index not built")

        roots = taxonomy_children(parent=None)["data"]
        if not roots:
            pytest.skip("No domain roots in real index")

        root_id = roots[0]["annotation_id"]
        children = taxonomy_children(parent=root_id)["data"]
        for child in children:
            child_id = child["annotation_id"]
            assert child_id in meta, \
                f"Child '{child_id}' not present in _ANN_META['taxonomy']"
            assert meta[child_id].get("parent") == root_id, (
                f"'{child_id}' parent mismatch: endpoint nested it under "
                f"'{root_id}' but the index says '{meta[child_id].get('parent')}'"
            )

    def test_leaf_taxon_returns_empty_not_error(self):
        """A real taxon with no children must return an empty list, not raise
        or 404 — matches the contract test_unit_backend.py checks on the
        synthetic fixture, verified here against the real dataset."""
        from api.routes import taxonomy_children
        from api.index import _ANN_META, _INDEX_READY
        if not _INDEX_READY:
            pytest.skip("Index not ready")

        meta = _ANN_META["taxonomy"]
        if not meta:
            pytest.skip("Taxonomy index not built")

        parent_ids = {rec.get("parent") for rec in meta.values() if rec.get("parent")}
        leaf_id = next((tid for tid in meta if tid not in parent_ids), None)
        if leaf_id is None:
            pytest.skip("No leaf taxon found in real index")

        result = taxonomy_children(parent=leaf_id)
        assert result["data"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Smoke tests
# ─────────────────────────────────────────────────────────────────────────────

class TestSmokePatched:
    """Quick sanity checks that patched functions still return valid shapes."""

    def test_status_returns_dict(self):
        from api.routes import api_status
        result = api_status()
        assert isinstance(result, dict)

    def test_status_index_ready_is_bool(self):
        from api.routes import api_status
        result = api_status()
        assert isinstance(result["index_ready"], bool)

    def test_search_mappings_returns_dict(self, sql_request):
        from api.routes import search_mappings
        from api.cache import AnnotationSource, get_all_sample_names
        samples = get_all_sample_names()
        if not samples:
            pytest.skip("No samples found")

        result = search_mappings(
            sql_request,
            annotation_id="__nonexistent__",
            source=AnnotationSource.kegg,
            sample_count=1,
        )
        assert isinstance(result, dict)
        assert "data" in result
        assert "total" in result

    def test_search_mappings_unique_pairs_flag(self, sql_request):
        """unique_pairs=True must still return valid structure."""
        from api.routes import search_mappings
        from api.cache import AnnotationSource
        result = search_mappings(
            sql_request,
            annotation_id="__nonexistent__",
            source=AnnotationSource.kegg,
            sample_count=5,
            unique_pairs=True,
        )
        assert isinstance(result["data"], list)