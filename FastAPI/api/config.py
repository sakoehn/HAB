"""
config.py
---------
All path and location constants for the JGI backend.

Centralising these here means every other module imports from one place,
and path adjustments (e.g. moving DataStructures) only require editing
this file.
"""

import os
from dotenv import load_dotenv

_HERE = os.path.dirname(__file__)
load_dotenv(os.path.join(_HERE,"..",".env"))

# ── Data directory layout ─────────────────────────────────────────────────────

# Resolve paths relative to this file so the package works regardless of the
# working directory from which uvicorn is started.
_HERE     = os.path.dirname(__file__)
BASE_DIR  = os.path.normpath(os.path.join(_HERE, "../../DataStructures"))

# These raw source directories are no longer read by the live app (which is
# sql-only, see DATA_BACKEND below) -- they're kept for the one-time
# migration scripts (FastAPI/scripts/migrate_*_to_sql.py) that populate the
# SQLite DB from them, and for tests that verify sql results against these
# files as independent ground truth (e.g. tests/sql/test_annotation_scaffolds_route.py).
COG_DIR      = os.path.join(BASE_DIR, "COG")
KEGG_DIR     = os.path.join(BASE_DIR, "Kegg")
ENZYME_DIR   = os.path.join(BASE_DIR, "Enzyme")
TAXONOMY_DIR = os.path.join(BASE_DIR, "Taxonomy")
MAPPINGS_DIR = os.path.join(BASE_DIR, "Mappings_by_Sample")

TIMEPOINTS_CSV = os.path.join(BASE_DIR, "JGI_ID_Timepoints_128.csv")
TIDES_CSV      = os.path.join(BASE_DIR, "tides.csv")

# Metagenome_Samples/ is a repo-root sibling of DataStructures/, not nested
# inside it (e.g. Metagenome_Samples/<sample>/<sample>.a.phylodist.txt), so
# it's resolved relative to _HERE directly rather than via BASE_DIR.
METAGENOME_SAMPLES_DIR = os.path.normpath(os.path.join(_HERE, "../../Metagenome_Samples"))

# ── Frontend dist (production mode) ──────────────────────────────────────────

FRONTEND_DIST = os.path.normpath(os.path.join(_HERE, "../../frontend/dist"))

# ── Location metadata — Rosario, Orcas Island, WA ────────────────────────────
#
# NOAA CO-OPS station #9449771.
# Used for sunrise/sunset day/night shading and tide data.

LOCATION_LAT  = 48.65     # degrees North
LOCATION_LON  = -122.85   # degrees West (negative)
LOCATION_NAME = "Rosario, Orcas Island, WA"

# Sample timepoints in JGI_ID_Timepoints_128.csv are in PDT (UTC-7) for the
# May–June dataset. LOCATION_TZ_OFFSET converts sunrise/sunset times
# (computed in UTC) to the same convention.
LOCATION_TZ_OFFSET = -7   # hours from UTC (PDT, matches timepoints CSV)

# tides.csv timestamps are stored 1 hour behind the timepoints CSV convention
# (confirmed against NOAA's published tide table for station 9449771 — see
# cache.load_tides). TIDE_SHIFT_HOURS is applied at load time so /api/tides
# timestamps align directly with /timepoints with no further conversion.
TIDE_SHIFT_HOURS = 1

# ── Correlation tuning ────────────────────────────────────────────────────────

# Lag window in sample units: 0, ±1, ±2, ±3, ±6 correspond to 0–24 h at
# the dataset's 4-hour sampling cadence.
CORRELATION_LAGS    = [0, 1, -1, 2, -2, 3, -3, 6, -6]
LAG_HOURS_PER_SAMPLE = 4

PERMUTATION_N    = 1000
PERMUTATION_SEED = 42

# ── Data backend selection ────────────────────────────────────────────────────
#
# The app reads from the SQLite database below (see api/db.py,
# api/cache_sql.py). The old direct-from-JSON-files backend was retired;
# "sql" is the only supported value now.
DATA_BACKEND = os.getenv("DATA_BACKEND", "sql")

# ── SQLite connection ─────────────────────────────────────────────────────────
#
# Connection settings for the SQLite backend (see FastAPI/scripts/migrate_mappings_to_sql.py
# and FastAPI/scripts/create_sql_schema.py). Only used when DATA_BACKEND=sql.
SQLITE_DB_PATH = os.path.normpath(os.path.join(_HERE, "../../hab_mappings.db"))