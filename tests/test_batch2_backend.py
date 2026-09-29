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
  _INDEX_READY                -> api.index._INDEX_READY
  _compute_date_range         -> api.index.compute_date_range

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

# TestMappingSearch tested /mappings/search against the JSON backend's
# pre-built _MAPPING_INDEX; TestLoadTsvHeaderHandling regression-tested a
# bug in that same JSON-only load_tsv()/_TSV_CACHE path; TestTaxonomyHierarchyRealIndex
# tested /taxonomy/children's JSON branch (_ANN_META) against the real warm
# index. All three were removed along with that code. Real, always-on
# equivalents: tests/sql/test_mappings_search_route.py (mapping search
# shape/sort/speed via the real sql route) and
# tests/sql/test_taxonomy_children_sql_route.py (real taxonomy hierarchy).


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


# ─────────────────────────────────────────────────────────────────────────────
# GET /sql-test -- found completely untested by a post-JSON-removal coverage
# pass. Uses the same sql_request fixture as the mapping-search tests above
# (a real sql_conn, not a live server).
# ─────────────────────────────────────────────────────────────────────────────

class TestSqlTestRoute:

    def test_returns_a_row_from_annotation_series(self, sql_request):
        from api.routes import sql_test
        rows = sql_test(sql_request)
        assert isinstance(rows, list)
        assert len(rows) == 1

    def test_raises_500_not_a_raw_exception_on_a_bad_connection(self, monkeypatch):
        """Real robustness check, not hypothetical: sql_test wraps its
        query in try/except specifically so a broken connection surfaces
        as a clean 500, not an unhandled exception escaping the route.

        sql_test opens its own connection via connect_to_sql() (2026-09-25
        fix -- see routes.py's module docstring: a single connection
        shared across every request/thread caused real production hangs
        and corruption) instead of reading one off request.app.state, so
        the exploding connection is injected by patching connect_to_sql
        itself rather than via _FakeRequest.
        """
        from fastapi import HTTPException
        import api.routes as routes_mod

        class _ExplodingConn:
            def execute(self, *_a, **_kw):
                raise RuntimeError("connection lost")
            def close(self):
                pass

        monkeypatch.setattr(routes_mod, "connect_to_sql", lambda: _ExplodingConn())

        with pytest.raises(HTTPException) as exc_info:
            routes_mod.sql_test(_FakeRequest(None))
        assert exc_info.value.status_code == 500


# ─────────────────────────────────────────────────────────────────────────────
# The 6 "SQL backend only" 501 guards on /kegg,enzyme,cog/children,path --
# found untested by the same coverage pass (DATA_BACKEND is fixed to 'sql'
# for the whole real test run via FastAPI/.env, so the "not sql" branch
# never fires without monkeypatching it directly, same gotcha
# TestTaxonomyChildrenJsonBranchDirect's own comments used to document
# before that class was deleted along with the json branch it tested).
# ─────────────────────────────────────────────────────────────────────────────

class TestHierarchyRoutesRejectNonSqlBackend:

    @pytest.fixture(autouse=True)
    def _patch_non_sql_backend(self):
        import api.routes as routes_mod
        orig = routes_mod.DATA_BACKEND
        routes_mod.DATA_BACKEND = 'not_sql'
        yield
        routes_mod.DATA_BACKEND = orig

    async def _assert_501(self, coro_fn, **kwargs):
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            await coro_fn(request=None, **kwargs)
        assert exc_info.value.status_code == 501

    async def test_kegg_children_rejects(self):
        from api.routes import kegg_children
        await self._assert_501(kegg_children, parent=None)

    async def test_kegg_path_rejects(self):
        from api.routes import kegg_path
        await self._assert_501(kegg_path, id='K00844')

    async def test_enzyme_children_rejects(self):
        from api.routes import enzyme_children
        await self._assert_501(enzyme_children, parent=None)

    async def test_enzyme_path_rejects(self):
        from api.routes import enzyme_path
        await self._assert_501(enzyme_path, id='1.1.1.1')

    async def test_cog_children_rejects(self):
        from api.routes import cog_children
        await self._assert_501(cog_children, parent=None)

    async def test_cog_path_rejects(self):
        from api.routes import cog_path
        await self._assert_501(cog_path, id='COG0001')