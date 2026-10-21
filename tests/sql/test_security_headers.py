"""
test_security_headers.py
========================
Every response -- the page, its static assets, API data and error responses
alike -- carries the browser security headers set in main.py:

- Content-Security-Policy: the page may only run its own scripts, talk to
  its own API, and load fonts/styles from itself and Google Fonts; no other
  site may frame it.
- Strict-Transport-Security: browsers that have seen the site over HTTPS
  keep using HTTPS for it.
- X-Content-Type-Options, X-Frame-Options, Referrer-Policy and
  Permissions-Policy: no MIME sniffing, no framing, no full URLs leaked to
  linked sites, no camera/microphone/location access.

Run:
    pytest tests/sql/test_security_headers.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import FRONTEND_DIST, SQLITE_DB_PATH  # pylint: disable=wrong-import-position,import-error

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as c:
        yield c


def _csp_directives(header: str) -> dict[str, list[str]]:
    directives = {}
    for part in header.split(";"):
        tokens = part.split()
        if tokens:
            directives[tokens[0]] = tokens[1:]
    return directives


PATHS = [
    "/status",
    "/api/status",
    "/api/cog/parents?ids=COG0055",
    "/api/annotations/scaffolds",  # 422: missing required params
    "/api/no-such-route",          # 404
]
if os.path.isdir(FRONTEND_DIST):
    PATHS += ["/", "/favicon.svg"]


@pytest.mark.parametrize("path", PATHS)
def test_every_response_carries_the_security_headers(client, path):
    r = client.get(path)
    h = r.headers
    assert "content-security-policy" in h, f"{path} ({r.status_code}) has no CSP"
    assert h["strict-transport-security"].startswith("max-age=")
    assert int(h["strict-transport-security"].split("=")[1].split(";")[0]) >= 15552000
    assert h["x-content-type-options"] == "nosniff"
    assert h["x-frame-options"] == "DENY"
    assert h["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "camera=()" in h["permissions-policy"]
    assert "geolocation=()" in h["permissions-policy"]
    assert "microphone=()" in h["permissions-policy"]


def test_csp_only_allows_the_site_itself_and_google_fonts(client):
    csp = _csp_directives(client.get("/status").headers["content-security-policy"])

    assert csp["default-src"] == ["'self'"]
    # Only the site's own scripts; no inline scripts or eval.
    assert csp["script-src"] == ["'self'"]
    # API calls go to the same origin only.
    assert csp["connect-src"] == ["'self'"]
    # Plotly injects <style> elements, so inline styles are allowed;
    # the stylesheet itself @imports Google Fonts.
    assert set(csp["style-src"]) == {"'self'", "'unsafe-inline'", "https://fonts.googleapis.com"}
    assert set(csp["font-src"]) == {"'self'", "data:", "https://fonts.gstatic.com"}
    # Chart PNG/SVG exports render through data:/blob: images.
    assert set(csp["img-src"]) == {"'self'", "data:", "blob:"}
    assert csp["object-src"] == ["'none'"]
    assert csp["frame-ancestors"] == ["'none'"]
    assert csp["base-uri"] == ["'self'"]
    assert csp["form-action"] == ["'self'"]
