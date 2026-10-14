"""
download_enzyme_brite.py
=========================
Downloads KEGG's EC (Enzyme) BRITE hierarchy file, ko01000.keg, and saves
it locally to DataStructures/Enzyme/ko01000.keg, plus a sidecar
ko01000.keg.meta.json recording the fetch date and source URL.

Why this exists: EGC_ENZYME_TREE.ipynb used to re-fetch this file live
from KEGG's website on every run, with nothing saved locally -- no record
of which version of KEGG's classification produced a given regeneration,
and no fallback if the site is unreachable. It now reads the local copy
this script saves; re-running this script is how you deliberately refresh
that copy. KEGG's EC classification does
change over time (EC class 7, Translocases, is a comparatively recent
addition -- for most of EC's history there were only 6 top-level classes),
so re-running without a pinned local copy risks silently different results
between runs with no way to trace why. ko00001.keg (KEGG's own hierarchy)
already gets this same local-copy treatment; this brings Enzyme in line.

Standalone utility -- it only fetches and saves the file; both
EGC_ENZYME_TREE.ipynb and migrate_enzyme_paths_to_sql.py read the saved
copy.

P9 (docs/AUDIT-2026-10-05.md): a 200 response isn't proof of a real file
(an HTML error page or a truncated body also come back as 200), so the
download is checked by validate_brite_text() BEFORE it replaces the good
cached copy, and written via a temp file + os.replace() so a crash mid-
write can't leave a half-written file either. The meta sidecar is only
updated after a successful replace.

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

# The 7 top-level EC classes, in order, exactly as KEGG writes them. A new
# class appearing is a real classification change that should be looked at
# by a person (it's exactly what this pinned copy exists to track), so it's
# refused rather than accepted silently.
EXPECTED_A_LINES = [
    "A<b>1. Oxidoreductases</b>",
    "A<b>2. Transferases</b>",
    "A<b>3. Hydrolases</b>",
    "A<b>4. Lyases</b>",
    "A<b>5. Isomerases</b>",
    "A<b>6. Ligases</b>",
    "A<b>7. Translocases</b>",
]

# Floor on EC-number (D-level) lines. The 2026-09-14 copy has 6,972; this
# catches a truncated body without breaking on normal growth/shrinkage.
MIN_D_LINES = 5000


def validate_brite_text(text: str) -> None:
    """Raise ValueError unless text looks like a real ko01000.keg.

    Args:
        text: The downloaded response body.
    """
    lines = text.splitlines()
    a_lines = [line.rstrip() for line in lines if line.startswith("A")]
    if a_lines != EXPECTED_A_LINES:
        raise ValueError(
            f"ko01000.keg top-level classes don't match the expected 7: got {a_lines[:10]!r}"
        )
    d_count = sum(1 for line in lines if line.startswith("D"))
    if d_count < MIN_D_LINES:
        raise ValueError(
            f"ko01000.keg has only {d_count} EC (D-level) lines, expected >= {MIN_D_LINES} "
            "-- looks truncated"
        )


def download_enzyme_brite() -> str:
    """Fetch ko01000.keg from KEGG and save it, plus a fetch-date sidecar
    file, to OUTPUT_PATH.

    Returns:
        The saved .keg file's path.
    """
    response = requests.get(BRITE_URL, timeout=30)
    response.raise_for_status()
    validate_brite_text(response.text)

    os.makedirs(ENZYME_DIR, exist_ok=True)
    tmp_path = OUTPUT_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(response.text)
    os.replace(tmp_path, OUTPUT_PATH)

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
