"""
test_taxonomy_export_route.py
==============================
Live-HTTP tests for GET /taxonomy/export -- the route wrapping
get_taxa_at_rank_sql() (see tests/sql/test_cache_sql.py for the
data-layer tests of that function directly). Same skip-if-not-running
pattern as tests/sql/test_taxonomy_children_sql_route.py.

Run:
    pytest tests/sql/test_taxonomy_export_route.py -v
"""

import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from test_cache_sql import (
    EXPECTED_DOMAIN_LIST,
    EXPECTED_ORDER_COUNT,
    EXPECTED_ORDER_FIRST,
    EXPECTED_ORDER_LAST,
    EXPECTED_PHYLUM_COUNT,
)

# Real count, independently confirmed against the live database.
EXPECTED_CLASS_COUNT = 251

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8000")


def _server_is_up() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/status", timeout=5.0)
        return r.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


def _sql_backend_active() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/sql-test", timeout=5.0)
        return r.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


sql_route_required = pytest.mark.skipif(
    not (_server_is_up() and _sql_backend_active()),
    reason=(
        f"Server not reachable at {API_BASE_URL}, or not running with "
        "DATA_BACKEND=sql. Set DATA_BACKEND=sql in FastAPI/.env, "
        "start `uvicorn main:app --reload`, then re-run."
    ),
)

# Every test below takes a `client` parameter to receive this fixture's
# value -- pylint sees that as shadowing the module-level `client` name,
# but it's the standard pytest fixture-injection pattern, not a real bug.
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def client():
    with httpx.Client(base_url=API_BASE_URL, timeout=30.0) as c:
        yield c


@sql_route_required
def test_domain_rank_returns_the_four_real_domains(client):
    resp = client.get("/taxonomy/export", params={"rank": "domain"})
    assert resp.status_code == 200
    assert sorted(resp.json()) == EXPECTED_DOMAIN_LIST


@sql_route_required
def test_order_rank_handles_the_reserved_word_column(client):
    """The one rank name that's also a SQL keyword -- exercises the
    route's column-name quoting/stripping path specifically, not just
    a generic "does the route work" check."""
    resp = client.get("/taxonomy/export", params={"rank": "order"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == EXPECTED_ORDER_COUNT
    assert sorted(data)[0]  == EXPECTED_ORDER_FIRST
    assert sorted(data)[-1] == EXPECTED_ORDER_LAST


@sql_route_required
def test_class_rank_accepts_the_clean_name_not_the_python_internal_one(client):
    """RANK_COLUMNS stores this rank's column as 'class_' (trailing
    underscore, to avoid colliding with Python's `class` keyword) --
    that's a storage detail, not part of the API contract. The route
    must accept the clean 'class', and must NOT accept the leaky
    internal 'class_' form."""
    resp = client.get("/taxonomy/export", params={"rank": "class"})
    assert resp.status_code == 200
    assert len(resp.json()) == EXPECTED_CLASS_COUNT

    leaky_resp = client.get("/taxonomy/export", params={"rank": "class_"})
    assert leaky_resp.status_code == 400


@sql_route_required
def test_phylum_rank_count_and_known_value(client):
    resp = client.get("/taxonomy/export", params={"rank": "phylum"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == EXPECTED_PHYLUM_COUNT
    assert "Bacteroidetes" in data


@sql_route_required
def test_response_is_a_flat_list_of_strings(client):
    """Regression guard matching test_cache_sql.py's equivalent check on
    the underlying function -- the route must not leak raw row tuples
    (or any other shape) through to the HTTP response."""
    resp = client.get("/taxonomy/export", params={"rank": "domain"})
    data = resp.json()
    assert isinstance(data, list)
    assert all(isinstance(v, str) for v in data)


@sql_route_required
def test_unknown_rank_returns_400_not_a_raw_error(client):
    resp = client.get("/taxonomy/export", params={"rank": "bogus_rank_xyz"})
    assert resp.status_code == 400
    assert "bogus_rank_xyz" in resp.json()["detail"]


@sql_route_required
def test_missing_rank_param_returns_422(client):
    """rank has no default, so FastAPI's own request validation should
    reject a call with no rank at all -- before the route body (and its
    own 400 path, which is for a *present but unrecognized* rank) ever
    runs."""
    resp = client.get("/taxonomy/export")
    assert resp.status_code == 422