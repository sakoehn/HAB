"""
download_enzyme_brite.py
=========================
Downloads KEGG's EC (Enzyme) BRITE hierarchy file, ko01000.keg, and saves
it locally to DataStructures/Enzyme/ko01000.keg, plus a sidecar
ko01000.keg.meta.json recording the fetch date and source URL.

Why this exists: EGC_ENZYME_TREE.ipynb currently re-fetches this file live
from KEGG's website on every run, with nothing saved locally -- no record
of which version of KEGG's classification produced a given regeneration,
and no fallback if the site is unreachable. KEGG's EC classification does
change over time (EC class 7, Translocases, is a comparatively recent
addition -- for most of EC's history there were only 6 top-level classes),
so re-running without a pinned local copy risks silently different results
between runs with no way to trace why. ko00001.keg (KEGG's own hierarchy)
already gets this same local-copy treatment; this brings Enzyme in line.

Standalone utility -- independent of migrate_kegg_paths_to_sql.py and of
EGC_ENZYME_TREE.ipynb, it only fetches and saves the file. Meant to feed a
future migrate_enzyme_paths_to_sql.py (mirroring migrate_kegg_paths_to_sql.py
reading ko00001.keg) and, if the notebook's own live-fetch cell is later
updated to match, EGC_ENZYME_TREE.ipynb too.

Usage (from FastAPI/):
    python scripts/download_enzyme_brite.py
"""

import json
import os
import sys
from datetime import datetime, timezone

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import ENZYME_DIR  # pylint: disable=wrong-import-position,import-error

BRITE_URL   = "https://www.kegg.jp/kegg-bin/download_htext?htext=ko01000.keg&format=htext"
OUTPUT_PATH = os.path.join(ENZYME_DIR, "ko01000.keg")
META_PATH   = OUTPUT_PATH + ".meta.json"


def download_enzyme_brite() -> str:
    """Fetch ko01000.keg from KEGG and save it, plus a fetch-date sidecar
    file, to OUTPUT_PATH.

    Returns:
        The saved .keg file's path.
    """
    response = requests.get(BRITE_URL, timeout=30)
    response.raise_for_status()

    os.makedirs(ENZYME_DIR, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(response.text)

    # A sidecar file, not a header line prepended into the .keg file
    # itself -- the downstream BRITE parser (this notebook's and
    # migrate_kegg_paths_to_sql.py's alike) only ever looks at lines
    # starting with A-K, so an extra line wouldn't break parsing, but
    # keeping metadata physically separate from KEGG's own file format
    # is simpler to reason about than relying on every parser silently
    # ignoring an unexpected first line forever.
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "source_url": BRITE_URL,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "line_count": response.text.count("\n") + 1,
            },
            f,
            indent=2,
        )

    return OUTPUT_PATH


def main():
    """Download and save the file, then print where it and its fetch
    metadata ended up."""
    path = download_enzyme_brite()
    print(f"Saved KEGG EC BRITE hierarchy to {path}")
    print(f"Fetch metadata recorded in {META_PATH}")


if __name__ == "__main__":
    main()
