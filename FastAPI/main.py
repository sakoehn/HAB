"""
main.py
-------
FastAPI application entry point.

Responsibilities (only)
~~~~~~~~~~~~~~~~~~~~~~~
- Create the FastAPI app instance.
- Register CORS middleware and the browser security headers.
- Mount the frontend static files (production mode).
- Define the lifespan hook that opens the SQLite connection and validates
  the sample time axis on startup.
- Include routers from api/routes.py and api/correlation_sql.py.

All business logic lives in the api/ package.

Usage
~~~~~
    uvicorn main:app --reload            # development
    uvicorn main:app --host 127.0.0.1    # production, behind nginx
"""

import logging
import sqlite3

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from api.config import FRONTEND_DIST
from api import index as index_module
from api import routes, correlation_sql
from api.correlation_loaders import assert_sample_order_is_trustworthy, load_sample_order
from api.cache_sql import get_all_sample_names_sql
from api.db import connect_to_sql, close_sql_connection

import os

logger = logging.getLogger(__name__)


# ── Lifespan ──────────────────────────────────────────────────────────────────

def _delete_old_correlation_versions() -> None:
    """Free the space held by correlation results from an older version of
    the math (they are already ignored). Best-effort: a locked database
    just leaves them for the next start."""
    conn = correlation_sql._connect()
    try:
        deleted = correlation_sql.delete_old_correlation_versions(conn)
        if deleted:
            logger.info("Deleted %d correlation results from older method versions", deleted)
    except sqlite3.OperationalError as error:
        logger.warning("Skipped deleting old correlation results: %s", error)
    finally:
        conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the SQLite connection and validate the sample time axis on startup."""
    app.state.sql_conn = connect_to_sql()
    index_module._INDEX_READY = True
    # Fail loudly at boot if the real sample time axis is broken
    # (a sample with no resolvable timepoint, or two samples colliding
    # on the same one) rather than silently scrambling every
    # correlation's lag_samples with no visible symptom.
    assert_sample_order_is_trustworthy(load_sample_order(app.state.sql_conn))
    index_module.assert_date_range_matches_samples(get_all_sample_names_sql(app.state.sql_conn))
    _delete_old_correlation_versions()

    yield

    close_sql_connection(app.state.sql_conn)


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="JGI Metagenomics API",
    description="Time-series annotation explorer for Rosario, Orcas Island EGC data.",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow the Vite dev server during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Browser security headers on every response. The CSP lets the page run only
# its own scripts and call only its own API; styles may be inline because
# Plotly injects <style> elements, and fonts come from Google Fonts (the
# stylesheet @imports them). Chart exports render through data:/blob: images.
CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
])
SECURITY_HEADERS = {
    "Content-Security-Policy":   CONTENT_SECURITY_POLICY,
    # Only takes effect over HTTPS; nginx terminates TLS in production.
    "Strict-Transport-Security": "max-age=31536000",
    "X-Content-Type-Options":    "nosniff",
    "X-Frame-Options":           "DENY",
    "Referrer-Policy":           "strict-origin-when-cross-origin",
    "Permissions-Policy":        "camera=(), microphone=(), geolocation=()",
}


@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    return response

# ── Routers ───────────────────────────────────────────────────────────────────
# Must be included before the static-files mount so API routes are matched
# first — a "/" mount catches every path, including /status, /timepoints, etc.

app.include_router(routes.router)
app.include_router(correlation_sql.router)

# Also register both under /api — the frontend's apiFetch always calls
# /api/*. In dev, Vite's proxy strips that prefix before forwarding here
# (see vite.config.ts), so the unprefixed routes above handle it. In
# production (this server serving the built frontend directly, no proxy
# in between), the browser hits /api/* unstripped, so it needs a matching
# route too.
app.include_router(routes.router, prefix="/api")
app.include_router(correlation_sql.router, prefix="/api")

# Serve built frontend if present (production mode).
if os.path.exists(FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
