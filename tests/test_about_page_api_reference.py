"""
test_about_page_api_reference.py
================================
The About page's API Reference (frontend/src/pages/AboutPage.tsx) lists
every public GET /api endpoint with an example URL. These tests keep that
list in step with the routes the app really serves:

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
    from fastapi.routing import APIRoute
    from main import app

    return {
        r.path: r
        for r in app.routes
        if isinstance(r, APIRoute) and "GET" in r.methods and r.path.startswith("/api/")
    }


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
        accepted = {p.alias or p.name: p for p in route.dependant.query_params}
        given = {k for k, _ in parse_qsl(urlsplit(url).query, keep_blank_values=True)}
        for name in sorted(given - set(accepted)):
            problems.append(f"{path}: example uses unknown parameter {name!r}")
        for name, param in sorted(accepted.items()):
            if param.field_info.is_required() and name not in given:
                problems.append(f"{path}: example omits required parameter {name!r}")
    assert not problems, "\n".join(problems)


def test_series_example_covers_all_128_samples():
    url = _listed_examples()["/api/series/annotations"]
    page_size = dict(parse_qsl(urlsplit(url).query)).get("page_size")
    assert page_size is not None and int(page_size) >= 128, (
        f"{url} returns only the default 100 of 128 samples"
    )
