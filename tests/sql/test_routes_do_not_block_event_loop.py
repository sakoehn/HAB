"""
test_routes_do_not_block_event_loop.py
=======================================
Every route does its work with blocking sqlite3 calls, so every route must
be a plain `def`. FastAPI runs an `async def` route directly on the event
loop, so while one waits on a slow query (a date-filtered /annotations/top
can take 10-50s) every other request to the server waits with it. A plain
`def` route runs in FastAPI's threadpool, so other requests keep being
served.

Run:
    pytest tests/sql/test_routes_do_not_block_event_loop.py -v
"""

import inspect
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)


def test_no_route_is_a_coroutine():
    """None of the routes await anything; all of their work is blocking
    sqlite3 calls, so every one of them must be a plain `def`."""
    from fastapi.routing import APIRoute
    from api import correlation_sql, routes

    # Read from the routers themselves: newer FastAPI versions keep included
    # routers bundled in app.routes rather than listing each route there.
    all_routes = [r for r in routes.router.routes + correlation_sql.router.routes if isinstance(r, APIRoute)]
    assert len(all_routes) > 20  # really found the routes
    async_routes = sorted(
        f"{route.path} -> {route.endpoint.__name__}"
        for route in all_routes
        if inspect.iscoroutinefunction(route.endpoint)
    )
    assert async_routes == []


def test_slow_query_does_not_stall_other_requests(monkeypatch):
    """Make one route's db call artificially slow and check /status still
    answers promptly while it runs."""
    from fastapi.testclient import TestClient
    import api.routes as routes_mod
    from main import app

    slow_seconds = 3.0

    def _slow_children(_db, _parent):
        time.sleep(slow_seconds)
        return []

    monkeypatch.setattr(routes_mod, "get_cog_children_sql", _slow_children)

    with TestClient(app) as client:
        slow = threading.Thread(target=lambda: client.get("/cog/children"))
        slow.start()
        time.sleep(0.5)  # let the slow request get going first

        started = time.monotonic()
        resp = client.get("/status")
        status_elapsed = time.monotonic() - started
        slow.join()

    assert resp.status_code == 200
    assert status_elapsed < 1.0, (
        f"/status took {status_elapsed:.1f}s while a {slow_seconds:.0f}s query was running "
        "-- the slow route is blocking the event loop"
    )
