"""
cache.py
--------
File I/O for data shared across backends.

Responsibilities
~~~~~~~~~~~~~~~~
- Load timepoints CSV and tide CSV (once at import time).
- Provide timepoint lookup helpers.

Nothing in this module starts background threads or builds derived indexes —
that is handled by index.py and astronomy.py.  All other modules that need
raw data import from here rather than touching the filesystem directly.
"""

import csv
import logging
import os
from enum import Enum

from .config import (
    MAPPINGS_DIR,
    TIDE_SHIFT_HOURS,
    TIDES_CSV,
    TIMEPOINTS_CSV,
)

logger = logging.getLogger(__name__)


# ── Annotation source enum ────────────────────────────────────────────────────

class AnnotationSource(str, Enum):
    kegg     = "kegg"
    cog      = "cog"
    enzyme   = "enzyme"
    taxonomy = "taxonomy"


# ── Timepoints ────────────────────────────────────────────────────────────────

def load_timepoints() -> dict:
    """
    Parse JGI_ID_Timepoints_128.csv into a dict keyed by taxon_oid.

    Returns {} with a warning if the file is missing — callers should handle
    the empty-dict case gracefully (time-series charts will have no date axis).
    """
    if not os.path.exists(TIMEPOINTS_CSV):
        logger.warning(
            "Timepoints CSV not found at %s — all timepoint lookups will return None. "
            "Time-series charts will have no date axis.",
            TIMEPOINTS_CSV,
        )
        return {}

    timepoints: dict = {}
    with open(TIMEPOINTS_CSV, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sample = row["taxon_oid"]
            timepoints[sample] = {
                "taxon_oid": row["taxon_oid"],
                "timepoint": row["Timepoint"],
                "datetime":  row["DateTime"],
            }
    return timepoints


# Loaded once at import time; treated as read-only everywhere else.
TIMEPOINTS: dict = load_timepoints()


def get_timepoint(sample_name: str) -> dict | None:
    """Return timepoint metadata for a sample, or None if not found."""
    return TIMEPOINTS.get(sample_name)


# ── Tide data ─────────────────────────────────────────────────────────────────

def load_tides() -> list[dict]:
    """
    Parse tides.csv into a list of {time, predicted_wl} dicts.

    The file's tide_event column is left out: it marks a high or low only
    when one lands exactly on a 6-minute reading, so most are unlabelled.

    The file has 7 leading '#' comment lines before the header row.

    TIMEZONE SHIFT: tides.csv timestamps are stored 1 hour behind the
    convention used in JGI_ID_Timepoints_128.csv (confirmed by
    cross-referencing NOAA's published tide table for station 9449771 —
    e.g. tides.csv "2021-06-03 11:36 High" corresponds to NOAA's published
    "2021/06/03 12:36 PM High"). TIDE_SHIFT_HOURS is applied here so
    /api/tides timestamps align directly with /timepoints and EGC sample
    timestamps with no further conversion required by callers.

    Returns [] with a warning if the file is missing.
    """
    if not os.path.exists(TIDES_CSV):
        logger.warning(
            "Tides CSV not found at %s — tide shading will be unavailable.",
            TIDES_CSV,
        )
        return []

    from datetime import datetime as _dt, timedelta as _td

    with open(TIDES_CSV, "r") as f:
        lines = [line for line in f if not line.startswith("#")]

    reader = csv.DictReader(lines)
    rows: list[dict] = []

    for row in reader:
        wl = (row.get("predicted_wl") or "").strip()
        if not wl:
            continue
        try:
            predicted_wl = float(wl)
        except ValueError:
            continue

        try:
            t = _dt.strptime(row["time"].strip(), "%Y-%m-%d %H:%M")
            shifted_time = (t + _td(hours=TIDE_SHIFT_HOURS)).strftime("%Y-%m-%d %H:%M")
        except ValueError:
            shifted_time = row["time"].strip()

        rows.append({
            "time":         shifted_time,
            "predicted_wl": predicted_wl,
        })

    return rows


# Loaded once at import time.
TIDES: list[dict] = load_tides()


# ── Sample enumeration ────────────────────────────────────────────────────────
# Not used by the live app (which enumerates samples from the SQLite DB via
# get_all_sample_names_sql instead) -- kept only for the one-time migration
# scripts (FastAPI/scripts/migrate_mappings_to_sql.py) that read the raw
# mapping TSVs to populate that DB in the first place.

def get_all_sample_names() -> list[str]:
    """
    Return every sample name derived from mapping TSV filenames, sorted
    lexicographically.  The TSV filenames are the canonical source of truth
    for which samples exist.
    """
    if not os.path.exists(MAPPINGS_DIR):
        return []
    return sorted(
        f.replace("_mapping.tsv", "")
        for f in os.listdir(MAPPINGS_DIR)
        if f.endswith("_mapping.tsv")
    )

