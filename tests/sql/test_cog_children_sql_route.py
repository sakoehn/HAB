"""
test_cog_children_sql_route.py
================================
Live-HTTP tests for /cog/children under DATA_BACKEND=sql -- same spirit
as test_kegg_children_sql_route.py / test_enzyme_children_sql_route.py,
but self-contained: uses FastAPI's TestClient AS A CONTEXT MANAGER
(`with TestClient(app) as client:`) instead of requiring a separately
running uvicorn server.

Why not the live-server pattern its siblings use: TestClient only runs
main.py's lifespan() (which sets up app.state.sql_conn) when entered as a
context manager. tests/test_unit_backend.py's patched_client fixture
skips that step, which is the exact root cause of a large pre-existing
gap where every DATA_BACKEND=sql route 500s under that fixture. Using the context-manager
form here means this test always actually runs -- no server to remember
to start, no silent skip if one isn't up.

Found and fixed a real bug while writing this file: cog_paths was
completely empty (0 rows) -- migrate_cog_paths_to_sql.py existed but had
never been run. Re-ran it (4,612 rows) before writing these tests.

Run:
    pytest tests/sql/test_cog_children_sql_route.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH

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


def test_root_case_returns_the_25_real_categories(client):
    resp = client.get("/cog/children")
    assert resp.status_code == 200
    body = resp.json()
    assert body["parent"] is None
    assert body["count"] == 25
    ids = {c["annotation_id"] for c in body["data"]}
    assert "H" in ids
    assert "Y" not in ids  # COG's own lettering skips Y


def test_get_children_depth_auto_resolves(client):
    """No `depth` query param exposed on this route at all -- the route
    always lets get_cog_children_sql derive it, so this doubles as
    confirmation that path works through the full HTTP layer, not just
    the direct function call already covered in test_cache_sql.py."""
    resp = client.get("/cog/children", params={"parent": "H"})
    assert resp.status_code == 200
    ids = {c["annotation_id"] for c in resp.json()["data"]}
    assert "COG0001" in ids


def test_leaf_cog_id_returns_200_with_empty_data(client):
    """A real leaf (COG0001) is a valid node with zero children -- must be
    200 + empty data, not 404 (404 means the id itself doesn't exist)."""
    resp = client.get("/cog/children", params={"parent": "COG0001"})
    assert resp.status_code == 200
    assert resp.json()["data"] == []


def test_unknown_id_returns_404(client):
    resp = client.get("/cog/children", params={"parent": "NOT_A_REAL_COG_ID"})
    assert resp.status_code == 404


def test_explicitly_empty_parent_returns_the_same_roots_as_omitting_it(client):
    """parent="" (a real, explicitly empty string) must be treated the
    same as omission, not 404 as an unknown node."""
    omitted = client.get("/cog/children")
    empty   = client.get("/cog/children", params={"parent": ""})
    assert omitted.status_code == 200
    assert empty.status_code == 200
    assert empty.json()["count"] == omitted.json()["count"]
    assert empty.json()["count"] > 0
