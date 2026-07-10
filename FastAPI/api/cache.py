"""
cache.py
--------
All file I/O for the JGI backend.

Responsibilities
~~~~~~~~~~~~~~~~
- Load and cache JSON annotation files (KEGG, COG, Enzyme, Taxonomy).
- Load and cache mapping TSV files.
- Load timepoints CSV and tide CSV (once at import time).
- Provide sample-name enumeration and timepoint lookup helpers.
- Expose annotation-extraction utilities used across multiple modules.

Nothing in this module starts background threads or builds derived indexes —
that is handled by index.py and astronomy.py.  All other modules that need
raw data import from here rather than touching the filesystem directly.
"""

import csv
import json
import logging
import os
from collections import OrderedDict
from enum import Enum
from typing import NamedTuple

from .config import (
    COG_DIR,
    ENZYME_DIR,
    JSON_CACHE_MAX_ENTRIES,
    KEGG_DIR,
    MAPPINGS_DIR,
    TAXONOMY_DIR,
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
    Parse tides.csv into a list of {time, predicted_wl, tide_event} dicts.

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
            "tide_event":   (row.get("tide_event") or "").strip() or None,
        })

    return rows


# Loaded once at import time.
TIDES: list[dict] = load_tides()


# ── JSON annotation cache ─────────────────────────────────────────────────────

# Ordered for LRU eviction — move_to_end() on hit, popitem(last=False) to
# evict the least-recently-used entry once over JSON_CACHE_MAX_ENTRIES.
_JSON_CACHE: "OrderedDict[str, dict]" = OrderedDict()


def load_json(folder: str, filename: str) -> dict:
    """
    Load a JSON file by stem name, caching the result in memory.

    The cache key is ``folder::filename`` so the same stem in different
    directories never collides. Bounded to JSON_CACHE_MAX_ENTRIES with
    least-recently-used eviction — see that constant in config.py for why
    an unbounded cache isn't safe here. Code that needs to read every sample
    once (e.g. the startup index build) should use load_json_uncached
    instead, so a one-time scan doesn't permanently evict everything else
    out of this cache.
    """
    cache_key = f"{folder}::{filename}"
    if cache_key in _JSON_CACHE:
        _JSON_CACHE.move_to_end(cache_key)
        return _JSON_CACHE[cache_key]

    data = load_json_uncached(folder, filename)

    _JSON_CACHE[cache_key] = data
    if len(_JSON_CACHE) > JSON_CACHE_MAX_ENTRIES:
        _JSON_CACHE.popitem(last=False)
    return data


def load_json_uncached(folder: str, filename: str) -> dict:
    """
    Load a JSON file by stem name without touching _JSON_CACHE.

    For one-time, full-dataset scans (e.g. index.build_search_index()'s
    startup pass, which reads every sample × source exactly once to build
    the derived indexes and never needs the raw dict again) — caching
    those reads would just thrash _JSON_CACHE's LRU and evict data that
    live requests actually want to keep warm.
    """
    path = os.path.join(folder, f"{filename}.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r") as f:
        return json.load(f)


def load_cog(sample_name: str) -> dict:
    return load_json(COG_DIR, f"{sample_name}.cog")


def load_kegg(sample_name: str) -> dict:
    return load_json(KEGG_DIR, f"{sample_name}.ko")


def load_enzyme(sample_name: str) -> dict:
    return load_json(ENZYME_DIR, f"{sample_name}.enzyme")


def load_taxonomy(sample_name: str) -> dict:
    return load_json(TAXONOMY_DIR, f"{sample_name}.tax")


def load_annotations_by_source(sample_name: str, source: AnnotationSource) -> dict:
    """Dispatch the correct loader for an AnnotationSource enum value."""
    loaders = {
        AnnotationSource.kegg:     load_kegg,
        AnnotationSource.cog:      load_cog,
        AnnotationSource.enzyme:   load_enzyme,
        AnnotationSource.taxonomy: load_taxonomy,
    }
    return loaders[source](sample_name)


_UNCACHED_DIRS = {
    AnnotationSource.kegg:     (KEGG_DIR,     "ko"),
    AnnotationSource.cog:      (COG_DIR,      "cog"),
    AnnotationSource.enzyme:   (ENZYME_DIR,   "enzyme"),
    AnnotationSource.taxonomy: (TAXONOMY_DIR, "tax"),
}


def load_annotations_by_source_uncached(sample_name: str, source: AnnotationSource) -> dict:
    """Uncached counterpart to load_annotations_by_source — see load_json_uncached."""
    folder, ext = _UNCACHED_DIRS[source]
    return load_json_uncached(folder, f"{sample_name}.{ext}")


# ── TSV mapping cache ─────────────────────────────────────────────────────────

class MappingRow(NamedTuple):
    """
    One gene-mapping row. A NamedTuple rather than a dict: the mapping TSVs
    total ~10GB raw across 128 samples, and with tens of millions of rows,
    per-row dict overhead alone (CPython dicts run ~300+ bytes even before
    counting content) pushed resident memory to ~3.5x that just to hold
    _TSV_CACHE — a NamedTuple's per-instance overhead is a fraction of that.
    _asdict() is used at API response boundaries so client-facing JSON shape
    is unchanged.
    """
    gene_id:   str | None
    contig_id: str | None
    taxonomy:  str | None
    kegg_id:   str | None
    enzyme:    str | None
    cog_id:    str | None


_TSV_CACHE: dict[str, list[MappingRow]] = {}


def load_tsv(sample_name: str) -> list[MappingRow]:
    """
    Load the gene-mapping TSV for a sample, caching the result in memory.

    Each row is normalised to a fixed-shape MappingRow regardless of column
    count, with missing columns set to None.
    """
    if sample_name in _TSV_CACHE:
        return _TSV_CACHE[sample_name]

    path = os.path.join(MAPPINGS_DIR, f"{sample_name}_mapping.tsv")
    if not os.path.exists(path):
        return []

    rows: list[MappingRow] = []
    with open(path, "r") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            if len(row) < 2:
                continue
            rows.append(MappingRow(
                gene_id=row[0] or None,
                contig_id=row[1] or None,
                taxonomy=row[2] if len(row) > 2 and row[2] else None,
                kegg_id=row[3] if len(row) > 3 and row[3] else None,
                enzyme=row[4] if len(row) > 4 and row[4] else None,
                cog_id=row[5] if len(row) > 5 and row[5] else None,
            ))

    _TSV_CACHE[sample_name] = rows
    return rows


# ── Sample enumeration ────────────────────────────────────────────────────────

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


# ── Annotation field extraction ───────────────────────────────────────────────

def extract_annotation_name(value) -> str | None:
    """Return the human-readable name from an annotation JSON value.

    Note: for Taxonomy the name IS the dict key, not inside the value.
    Call sites that know the annotation_id should use it directly for taxonomy
    rather than calling this function.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return (
            value.get("name")
            or value.get("category")
            or value.get("label")
        )
    return None


def extract_parent(value, source: str) -> str | None:
    """
    Extract the parent / grouping label for an annotation.

    Per-source rules (new JSON format)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    - KEGG:     parent_name → parent_id → category
    - COG:      category letter (flat — no hierarchy)
    - Enzyme:   parent_name → parent_id
    - Taxonomy: parent (string taxon name, or null for roots)
    """
    if not isinstance(value, dict):
        return None

    def _first(v) -> str | None:
        if isinstance(v, list):
            return next((s for s in v if isinstance(s, str) and s.strip()), None)
        if isinstance(v, str) and v.strip():
            return v.strip()
        return None

    if source == "kegg":
        return (
            _first(value.get("parent_name"))
            or _first(value.get("parent_id"))
            or _first(value.get("category"))
        )
    if source == "cog":
        return _first(value.get("category"))
    if source == "enzyme":
        return (
            _first(value.get("parent_name"))
            or _first(value.get("parent_id"))
        )
    if source == "taxonomy":
        return _first(value.get("parent"))
    return None


def extract_egc(value) -> float | None:
    """Extract the raw EGC value from an annotation JSON value."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        # Use explicit None check so egc=0 is returned as 0.0, not skipped.
        raw = value.get("egc")
        if raw is None:
            raw = value.get("EGC")
        if isinstance(raw, (int, float)):
            return float(raw)
    return None


def extract_norm_egc(value) -> float | None:
    """Extract the depth-normalised EGC (norm_egc) from an annotation JSON value."""
    if isinstance(value, dict):
        # Use explicit None check so norm_egc=0 is returned as 0.0, not skipped.
        raw = value.get("norm_egc")
        if raw is None:
            raw = value.get("NORM_EGC")
        if isinstance(raw, (int, float)):
            return float(raw)
    return None