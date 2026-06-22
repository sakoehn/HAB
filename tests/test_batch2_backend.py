"""
Tests/test_batch2_backend.py
============================
Batch 2 backend tests covering:

Item 5  — /mappings/search speed + date/time in response
Item 6  — /annotations/correlate concurrency fix
Item 8  — /api/status returns date_min / date_max

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
  _EGC_BUILD_LOCK             -> api.index._EGC_BUILD_LOCK
  _EGC_MATRIX                 -> api.index._EGC_MATRIX
  _get_egc_vectors_from_matrix-> api.index.get_egc_vectors_from_matrix
  _compute_date_range         -> api.index.compute_date_range
  get_all_sample_names        -> api.cache.get_all_sample_names
  correlate_annotations       -> api.correlation.correlate_annotations

Run with:  pytest Tests/test_batch2_backend.py -v
"""

import pytest
import time
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


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

    def test_mapping_response_has_timepoint_field(self):
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
            annotation_id=first_id,
            source=AnnotationSource.kegg,
            sample_count=10,
        )
        assert "data" in result
        if result["data"]:
            row = result["data"][0]
            assert "timepoint" in row, "Each mapping row must include 'timepoint'"

    def test_mapping_timepoint_has_datetime(self):
        """timepoint dict must contain 'datetime' key."""
        from api.routes import search_mappings
        from api.cache import AnnotationSource
        from api.index import _MAPPING_INDEX
        if not _MAPPING_INDEX.get("kegg"):
            pytest.skip("Mapping index not built yet")

        first_id = next(iter(_MAPPING_INDEX["kegg"]))
        result = search_mappings(
            annotation_id=first_id,
            source=AnnotationSource.kegg,
            sample_count=5,
        )
        for row in result.get("data", []):
            if row.get("timepoint"):
                assert "datetime" in row["timepoint"], \
                    "timepoint dict must have 'datetime' key"

    def test_mapping_rows_sorted_chronologically(self):
        """Results should be in chronological order."""
        from api.routes import search_mappings
        from api.cache import AnnotationSource
        from api.index import _MAPPING_INDEX
        if not _MAPPING_INDEX.get("kegg"):
            pytest.skip("Mapping index not built yet")

        first_id = next(iter(_MAPPING_INDEX["kegg"]))
        result = search_mappings(
            annotation_id=first_id,
            source=AnnotationSource.kegg,
            sample_count=128,
        )
        datetimes = [
            row["timepoint"]["datetime"]
            for row in result.get("data", [])
            if row.get("timepoint") and row["timepoint"].get("datetime")
        ]
        assert datetimes == sorted(datetimes), \
            "Mapping rows must be sorted chronologically"

    def test_mapping_speed_with_index(self):
        """When the index is warm, /mappings/search must complete in < 500ms."""
        from api.routes import search_mappings
        from api.cache import AnnotationSource
        from api.index import _MAPPING_INDEX
        if not _MAPPING_INDEX.get("kegg"):
            pytest.skip("Mapping index not built — speed test requires warm index")

        first_id = next(iter(_MAPPING_INDEX["kegg"]))
        start = time.perf_counter()
        search_mappings(
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
        """Each value in _MAPPING_INDEX must be a list of (sample_name, row_dict) tuples."""
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
                assert isinstance(row, dict),        "Second element must be row dict"
            break


# ─────────────────────────────────────────────────────────────────────────────
# ITEM 6 — Correlation concurrency lock
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.api
class TestCorrelationLock:
    """
    get_egc_vectors_from_matrix must serialise concurrent fallback calls.
    The lock prevents race conditions during server startup warmup.
    """

    def test_egc_build_lock_exists(self):
        """_EGC_BUILD_LOCK must be a threading.Lock instance."""
        import threading
        from api.index import _EGC_BUILD_LOCK
        assert isinstance(_EGC_BUILD_LOCK, type(threading.Lock())), \
            "_EGC_BUILD_LOCK must be a threading.Lock"

    def test_egc_matrix_has_all_sources(self):
        """_EGC_MATRIX must exist for all 4 sources."""
        from api.index import _EGC_MATRIX
        for source in ("kegg", "cog", "enzyme", "taxonomy"):
            assert source in _EGC_MATRIX, f"_EGC_MATRIX missing source '{source}'"

    def test_get_egc_vectors_returns_matrix_when_ready(self):
        """When _EGC_MATRIX is populated, get_egc_vectors_from_matrix returns it directly."""
        from api.index import _EGC_MATRIX, get_egc_vectors_from_matrix, _INDEX_READY
        from api.cache import AnnotationSource
        if not _INDEX_READY:
            pytest.skip("Index not ready")

        src = AnnotationSource.kegg
        if not _EGC_MATRIX.get(src.value):
            pytest.skip("KEGG EGC matrix not built yet")

        vecs, names, parents = get_egc_vectors_from_matrix(src)
        assert vecs is _EGC_MATRIX[src.value], \
            "get_egc_vectors_from_matrix should return the pre-built matrix directly"

    def test_concurrent_correlate_calls_do_not_raise(self):
        """Two concurrent correlation calls must not raise RuntimeError or produce empty results."""
        import threading
        from api.index import _EGC_MATRIX, _INDEX_READY, get_egc_vectors_from_matrix
        from api.cache import AnnotationSource
        if not _INDEX_READY:
            pytest.skip("Index not ready")
        if not _EGC_MATRIX.get("kegg"):
            pytest.skip("KEGG EGC matrix not built")

        errors: list[Exception] = []
        results: list[dict] = []

        def call():
            try:
                vecs, names, parents = get_egc_vectors_from_matrix(AnnotationSource.kegg)
                results.append({"vecs": len(vecs), "names": len(names)})
            except Exception as e:
                errors.append(e)

        t1 = threading.Thread(target=call)
        t2 = threading.Thread(target=call)
        t1.start(); t2.start()
        t1.join(timeout=10); t2.join(timeout=10)

        assert not errors, f"Concurrent calls raised: {errors}"
        assert len(results) == 2, "Both threads must complete successfully"
        assert results[0]["vecs"] > 0, "First thread must get non-empty vectors"
        assert results[1]["vecs"] > 0, "Second thread must get non-empty vectors"

    def test_correlation_target_source_param_accepted(self):
        """The /correlate endpoint must accept any target_source, not just taxonomy."""
        from api.correlation import correlate_annotations
        from api.index import _EGC_MATRIX, _INDEX_READY
        from api.cache import AnnotationSource
        if not _INDEX_READY:
            pytest.skip("Index not ready")
        if not _EGC_MATRIX.get("kegg") or not _EGC_MATRIX.get("cog"):
            pytest.skip("EGC matrices not built")
        if not _EGC_MATRIX["kegg"]:
            pytest.skip("No KEGG annotations in matrix")

        first_id = next(iter(_EGC_MATRIX["kegg"]))

        try:
            result = correlate_annotations(
                source=AnnotationSource.kegg,
                annotation_id=first_id,
                mode="cross",
                target_source=AnnotationSource.cog,
                skip_pvalue=True,
                limit=5,
            )
            assert "data" in result, "Correlation with target_source=cog must return data"
            assert result["target_source"] == "cog", \
                f"Expected target_source='cog' got '{result['target_source']}'"
        except Exception as e:
            pytest.fail(f"correlate_annotations with target_source=cog raised: {e}")


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

    def test_search_mappings_returns_dict(self):
        from api.routes import search_mappings
        from api.cache import AnnotationSource, get_all_sample_names
        samples = get_all_sample_names()
        if not samples:
            pytest.skip("No samples found")

        result = search_mappings(
            annotation_id="__nonexistent__",
            source=AnnotationSource.kegg,
            sample_count=1,
        )
        assert isinstance(result, dict)
        assert "data" in result
        assert "total" in result

    def test_search_mappings_unique_pairs_flag(self):
        """unique_pairs=True must still return valid structure."""
        from api.routes import search_mappings
        from api.cache import AnnotationSource
        result = search_mappings(
            annotation_id="__nonexistent__",
            source=AnnotationSource.kegg,
            sample_count=5,
            unique_pairs=True,
        )
        assert isinstance(result["data"], list)