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
- Include routers from api/routes.py and api/correlation.py.

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
    load_cog,
    load_enzyme,
    load_kegg,
    load_taxonomy,
    load_tsv,
)
from api.config import FRONTEND_DIST
from api.index import build_mapping_index, build_search_index
from api import routes, correlation

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
    def _warm() -> None:
        try:
            samples = get_all_sample_names()
            for sample in samples:
                load_kegg(sample)
                load_cog(sample)
                load_enzyme(sample)
                load_taxonomy(sample)
                load_tsv(sample)
            build_search_index()
            build_mapping_index()
            logger.info("Startup warmup complete (%d samples).", len(samples))
        except Exception:
            logger.exception("Startup warmup FAILED — index_ready will remain False.")

    thread = threading.Thread(target=_warm, daemon=True, name="cache-warmup")
    thread.start()
    yield


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

# Serve built frontend if present (production mode).
if os.path.exists(FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")

# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(routes.router)
app.include_router(correlation.router)
