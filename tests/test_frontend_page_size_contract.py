"""
test_frontend_page_size_contract.py
=====================================
A6 (4c5b19d) added an upper bound (Query(le=...)) to every paginated
route's page_size, but the frontend was already requesting more than three
of those bounds -- /search/annotations (5000 > 2000), /series/annotations
(5000 > 500) and /mappings/search (200_000 > 50_000) all started returning
422, breaking Analyze search, every time-series chart and the Mappings
panel. Nothing caught it: frontend tests mock fetch, backend tests don't
know what the frontend sends.

This pins the contract between the two sides: every page_size the
frontend's real source sends (a literal, or a `const NAME = <number>` in
the same file) must be within the backend route's real bounds, read from
FastAPI's own OpenAPI schema -- not a hand-copied number.

Run:
    pytest tests/test_frontend_page_size_contract.py -v
"""
import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from main import app  # pylint: disable=wrong-import-position

FRONTEND_SRC = Path(__file__).resolve().parent.parent / "frontend" / "src"
# Not part of the build (tsconfig.app.json excludes both).
EXCLUDED = {"App_old.tsx"}

API_PATH_RE = re.compile(r"/api(/[A-Za-z0-9_/\-]+)")
PAGE_SIZE_RE = re.compile(r"page_size=(\$\{([A-Za-z_][A-Za-z0-9_]*)\}|[0-9_]+)")
# How far back from a page_size= to look for the URL's /api/<route> (the
# scaffold modals split one URL across two concatenated template strings).
LOOKBACK_CHARS = 300


def _route_page_size_bounds() -> dict[str, tuple[int | None, int | None]]:
    """{route path: (minimum, maximum)} for every route with a page_size param."""
    bounds = {}
    for path, ops in app.openapi()["paths"].items():
        for param in ops.get("get", {}).get("parameters", []):
            if param["name"] == "page_size":
                schema = param["schema"]
                bounds[path] = (schema.get("minimum"), schema.get("maximum"))
    return bounds


def _frontend_page_size_requests() -> list[tuple[str, int, str, int]]:
    """[(file, line, route, page_size)] for every page_size the frontend sends."""
    requests = []
    for path in sorted(FRONTEND_SRC.rglob("*.ts*")):
        if "tests" in path.relative_to(FRONTEND_SRC).parts or path.name in EXCLUDED:
            continue
        text = path.read_text(encoding="utf-8")
        consts = {
            m.group(1): int(m.group(2).replace("_", ""))
            for m in re.finditer(r"const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([0-9_]+)\b", text)
        }
        for m in PAGE_SIZE_RE.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            # Skip mentions inside a // comment -- not a real request.
            line_start = text.rfind("\n", 0, m.start()) + 1
            if "//" in text[line_start:m.start()]:
                continue
            routes =API_PATH_RE.findall(text[max(0, m.start() - LOOKBACK_CHARS):m.start()])
            assert routes, f"{path.name}:{line}: page_size= with no /api/<route> before it"
            if m.group(2):
                assert m.group(2) in consts, (
                    f"{path.name}:{line}: page_size uses {m.group(2)}, not a numeric const in this file"
                )
                value = consts[m.group(2)]
            else:
                value = int(m.group(1).replace("_", ""))
            requests.append((path.name, line, routes[-1], value))
    return requests


REQUESTS = _frontend_page_size_requests()
BOUNDS = _route_page_size_bounds()


def test_scanner_finds_the_known_callers():
    """Guard against the scan silently finding nothing (a vacuous pass)."""
    routes = {route for _, _, route, _ in REQUESTS}
    assert {"/search/annotations", "/series/annotations", "/mappings/search",
            "/annotations/scaffolds", "/timepoints", "/samples"} <= routes


@pytest.mark.parametrize(
    "file, line, route, page_size", REQUESTS,
    ids=[f"{f}:{l}" for f, l, _, _ in REQUESTS],
)
def test_frontend_page_size_within_backend_bounds(file, line, route, page_size):
    assert route in BOUNDS, f"{file}:{line}: {route} has no page_size param on the backend"
    low, high = BOUNDS[route]
    assert low is None or page_size >= low, f"{file}:{line}: {route} page_size={page_size} < {low}"
    assert high is None or page_size <= high, (
        f"{file}:{line}: {route} page_size={page_size} exceeds the backend's le={high} -- "
        "the request would be rejected with a 422"
    )
