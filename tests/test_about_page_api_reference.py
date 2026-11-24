"""
test_about_page_api_reference.py
================================
The About page's API Reference (frontend/src/pages/AboutPage.tsx) lists
every public /api endpoint with an example URL -- GET routes, and the
POST-only bulk downloads (their example URL shows the query string; the
body is described in the text). These tests keep that list in step with
the routes the app really serves:

- every listed path is a real route, and every real route is listed;
- every query parameter in an example is one the route accepts, and every
  parameter the route requires appears in its example;
- the time-series example asks for enough rows to cover all 128 samples
  (its default page size is 100).

Run:
    pytest tests/test_about_page_api_reference.py -v
"""

import os
import re
import sys
from urllib.parse import parse_qsl, urlsplit

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "FastAPI"))

ABOUT_PAGE = os.path.join(ROOT, "frontend", "src", "pages", "AboutPage.tsx")


def _listed_examples() -> dict[str, str]:
    """Path -> example URL, from the API Reference rows ['/api/...', '...']."""
    with open(ABOUT_PAGE, encoding="utf-8") as f:
        source = f.read()
    urls = re.findall(r"\[\s*'(/api/[^']*)'", source)
    assert urls, "no API Reference rows found in AboutPage.tsx"
    return {urlsplit(u).path: u for u in urls}


@pytest.fixture(scope="module")
def routes():
    """Every GET or POST /api path the app serves -> {query parameter:
    required?} (the GET's when it has both), from the app's own OpenAPI
    schema (version-stable: newer FastAPI keeps included routers bundled in
    app.routes rather than listing each route)."""
    from main import app

    found = {}
    for path, ops in app.openapi()["paths"].items():
        method = "get" if "get" in ops else "post" if "post" in ops else None
        if path.startswith("/api/") and method:
            found[path] = {
                p["name"]: p.get("required", False)
                for p in ops[method].get("parameters", [])
                if p.get("in") == "query"
            }
    assert len(found) > 20  # really found the routes
    return found


def test_every_listed_endpoint_is_a_real_route(routes):
    missing = sorted(set(_listed_examples()) - set(routes))
    assert not missing, f"About page lists endpoints the app doesn't serve: {missing}"


def test_every_route_is_listed(routes):
    unlisted = sorted(set(routes) - set(_listed_examples()))
    assert not unlisted, f"About page is missing these endpoints: {unlisted}"


def test_example_query_parameters_match_the_route(routes):
    problems = []
    for path, url in _listed_examples().items():
        route = routes.get(path)
        if route is None:
            continue  # reported by test_every_listed_endpoint_is_a_real_route
        accepted = route  # {query parameter: required?}
        given = {k for k, _ in parse_qsl(urlsplit(url).query, keep_blank_values=True)}
        for name in sorted(given - set(accepted)):
            problems.append(f"{path}: example uses unknown parameter {name!r}")
        for name, required in sorted(accepted.items()):
            if required and name not in given:
                problems.append(f"{path}: example omits required parameter {name!r}")
    assert not problems, "\n".join(problems)


def test_series_example_covers_all_128_samples():
    url = _listed_examples()["/api/series/annotations"]
    page_size = dict(parse_qsl(urlsplit(url).query)).get("page_size")
    assert page_size is not None and int(page_size) >= 128, (
        f"{url} returns only the default 100 of 128 samples"
    )
