"""
test_taxonomy_children_sql_route.py
======================================
Self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER (`with
TestClient(app) as client:`) rather than requiring a separately running
uvicorn server -- see tests/sql/test_samples_and_timepoints_route.py's
module docstring for why the old httpx.Client-against-a-live-server
pattern silently contributed zero coverage in every normal `pytest
tests/` run.

Run:
    pytest tests/sql/test_taxonomy_children_sql_route.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH
from test_cache_sql import EXPECTED_BACTEROIDETES_CHILDREN, BOSEA_OLD_LINEAGE, BOSEA_NEW_LINEAGE

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


def test_bare_name_no_longer_resolves(client):
    """Post-fix, a bare rank name (no longer a valid identifier on its
    own) must 404 exactly like any other unknown taxon -- proves the route
    doesn't fall back to bare-name matching under the hood."""
    resp = client.get(
        "/taxonomy/children",
        params={"parent": "Bacteroidetes"},
    )
    assert resp.status_code == 404


def test_taxon_naming_error(client):
    resp = client.get(
        "/taxonomy/children",
        params={"parent": "TAX_DOES_NOT_EXIST"},
    )
    assert resp.status_code == 404


def test_root_children_have_depth_1(client):
    """Ported from test_batch2_backend.py's deleted TestTaxonomyHierarchyRealIndex
    (tested the JSON branch's real warm index directly) -- the equivalent
    depth/root check already existed at the direct-function layer
    (test_cache_sql.py::test_root_case_returns_the_four_domains), but not
    through the actual HTTP route, which is what a real client calls."""
    resp = client.get("/taxonomy/children")
    assert resp.status_code == 200
    children = resp.json()["data"]
    assert children, "expected at least one real domain root"
    assert all(c["depth"] == 1 for c in children)


def test_leaf_taxon_returns_200_empty_list_not_error(client):
    """A real strain-level leaf must return 200 + [], not 404 or 500 --
    same contract already confirmed at the direct-function layer
    (test_cache_sql.py::test_strain_level_parent_has_no_children), checked
    here through the actual HTTP route."""
    strain_lineage = (
        "Bacteria;Bacteroidetes;Flavobacteriia;Flavobacteriales;"
        "Flavobacteriaceae;Flagellimonas;Flagellimonas pacifica;"
        "Flagellimonas pacifica DSM 25885"
    )
    resp = client.get("/taxonomy/children", params={"parent": strain_lineage})
    assert resp.status_code == 200
    assert resp.json()["data"] == []


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
