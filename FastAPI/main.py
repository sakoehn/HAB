"""
main.py
-------
FastAPI application entry point.

Responsibilities (only)
~~~~~~~~~~~~~~~~~~~~~~~
- Create the FastAPI app instance.
- Register CORS middleware.
- Mount the frontend static files (production mode).
- Define the lifespan hook that warms caches and builds indexes.
- Include routers from api/routes.py and api/correlation_sql.py.

All business logic lives in the api/ package.

Usage
~~~~~
    uvicorn main:app --reload            # development
    uvicorn main:app --host 0.0.0.0      # production
"""

import logging
import threading

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from api.cache import (
    get_all_sample_names,
    load_tsv,
)
from api.config import FRONTEND_DIST, DATA_BACKEND
from api.index import build_mapping_index, build_search_index
from api import index as index_module
from api import routes, correlation_sql
from api.correlation_loaders import assert_sample_order_is_trustworthy, load_sample_order
from api.db import connect_to_sql, close_sql_connection

import os

logger = logging.getLogger(__name__)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Warm the JSON / TSV caches and build all in-memory indexes on startup.

    Runs in a background daemon thread so the application becomes available
    immediately and /status can be polled to check index readiness.
    """
    if DATA_BACKEND == 'json':
        def _warm() -> None:
            try:
                samples = get_all_sample_names()
                for sample in samples:
                    load_tsv(sample)
                build_search_index()
                build_mapping_index()
                logger.info("Startup warmup complete (%d samples).", len(samples))
            except Exception:
                logger.exception("Startup warmup FAILED — index_ready will remain False.")

        thread = threading.Thread(target=_warm, daemon=True, name="cache-warmup")
        thread.start()
    else: # DATA_BACKEND == "sql"
        app.state.sql_conn = connect_to_sql()
        index_module._INDEX_READY = True
        # CR6: fail loudly at boot if the real sample time axis is broken
        # (a sample with no resolvable timepoint, or two samples colliding
        # on the same one) rather than silently scrambling every
        # correlation's lag_samples with no visible symptom.
        assert_sample_order_is_trustworthy(load_sample_order(app.state.sql_conn))

    yield

    if DATA_BACKEND == "sql":
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
