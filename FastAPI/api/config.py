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

COG_DIR      = os.path.join(BASE_DIR, "COG")
KEGG_DIR     = os.path.join(BASE_DIR, "Kegg")
ENZYME_DIR   = os.path.join(BASE_DIR, "Enzyme")
TAXONOMY_DIR = os.path.join(BASE_DIR, "Taxonomy")
MAPPINGS_DIR = os.path.join(BASE_DIR, "Mappings_by_Sample")

TIMEPOINTS_CSV = os.path.join(BASE_DIR, "JGI_ID_Timepoints_128.csv")
TIDES_CSV      = os.path.join(BASE_DIR, "tides.csv")

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

# ── Annotation JSON cache ─────────────────────────────────────────────────────
#
# cache.load_json() caches parsed per-sample annotation files (KEGG/COG/
# Enzyme/Taxonomy) so repeat requests for the same sample are fast. Bounded
# with least-recently-used eviction because the full dataset is tens of GB
# once parsed. Set to 140 — comfortably above the 128-sample dataset so a
# single full-dataset pull (one annotation across every sample) fits without
# evicting itself mid-request. Tested: cold request ~36s, warm (repeat)
# ~0.26s, no thrashing.
JSON_CACHE_MAX_ENTRIES = 140

# ── MongoDB connection ────────────────────────────────────────────────────────
#
# Connection settings for the optional MongoDB backend (see api/db.py). Only
# used when DATA_BACKEND=mongo; the default "json" backend reads directly
# from the DataStructures files above and never touches these.

MONGO_URI     = os.getenv("MONGO_URI")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME")
DATA_BACKEND  = os.getenv("DATA_BACKEND", "json")

# ── Scaffold collection bucketing (split-schema migration) ──────────────────
#
# The new "scaffolds" collection buckets each (source, annotation_id, sample)
# scaffold map into documents of at most this many entries, instead of one
# document per scaffold. Measured 2026-07-28 against the real dataset: the
# largest existing scaffold map (taxonomy/Bacteria, 485,842 entries) produces
# a ~526 KB bucket at this cap -- ~3% of MongoDB's 16 MiB hard document limit
# -- while a fully-flattened one-doc-per-scaffold design would have created
# ~624 million documents (~100x the size of every other collection). See
# MONGODB_MIGRATION_FOLLOWUP.md Phase 3 and project memory for the full
# measurement.
SCAFFOLD_BUCKET_CAP = 10_000

# Hardcoded until the dataset_manifest "active version" pointer described in
# MONGODB_MIGRATION_FOLLOWUP.md Phase 3 is actually built -- fine for now
# since only one dataset_version exists. Revisit once a second ingestion
# run happens and something needs to choose between them.
ACTIVE_DATASET_VERSION = "2026-07-28-01"