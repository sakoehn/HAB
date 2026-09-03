import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from test_cache_sql import EXPECTED_BACTEROIDETES_CHILDREN, BOSEA_OLD_LINEAGE, BOSEA_NEW_LINEAGE

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
def test_get_children(client):
    """`parent` must be the full lineage-prefix now (see
    taxonomy_egc_homonym_bug) -- a bare rank name like "Bacteroidetes" is
    no longer a valid identifier, see test_bare_name_no_longer_resolves."""
    resp = client.get(
        "/taxonomy/children",
        params={"parent": "Bacteria;Bacteroidetes"},
    )
    children = resp.json()['data']
    assert sorted(c["name"] for c in children) == EXPECTED_BACTEROIDETES_CHILDREN
    assert all(c["annotation_id"] == f"Bacteria;Bacteroidetes;{c['name']}" for c in children)


@sql_route_required
def test_bare_name_no_longer_resolves(client):
    """Post-fix, a bare rank name (no longer a valid identifier on its
    own) must 404 exactly like any other unknown taxon -- proves the route
    doesn't fall back to bare-name matching under the hood."""
    resp = client.get(
        "/taxonomy/children",
        params={"parent": "Bacteroidetes"},
    )
    assert resp.status_code == 404


@sql_route_required
def test_taxon_naming_error(client):
    resp = client.get(
        "/taxonomy/children",
        params={"parent": "TAX_DOES_NOT_EXIST"},
    )
    assert resp.status_code == 404


@sql_route_required
def test_homonym_lineages_return_disjoint_children(client):
    """Real, confirmed cross-lineage homonym (see
    tests/sql/test_cache_sql.py's BOSEA_OLD_LINEAGE/BOSEA_NEW_LINEAGE) --
    both lineages share the bare genus name "Bosea" but must resolve to
    completely separate children through this route, not get merged or
    have one shadow the other."""
    old_resp = client.get("/taxonomy/children", params={"parent": BOSEA_OLD_LINEAGE})
    new_resp = client.get("/taxonomy/children", params={"parent": BOSEA_NEW_LINEAGE})
    assert old_resp.status_code == 200
    assert new_resp.status_code == 200

    old_ids = {c["annotation_id"] for c in old_resp.json()["data"]}
    new_ids = {c["annotation_id"] for c in new_resp.json()["data"]}
    assert old_ids, "expected BOSEA_OLD_LINEAGE to have real children"
    assert new_ids, "expected BOSEA_NEW_LINEAGE to have real children"
    assert old_ids.isdisjoint(new_ids)
