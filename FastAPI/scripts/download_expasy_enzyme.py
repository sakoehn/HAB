"""
download_expasy_enzyme.py
==========================
Downloads ExPASy ENZYME's two release files -- enzclass.txt (names of the
EC classes, subclasses and sub-subclasses) and enzyme.dat (one entry per
EC number) -- into DataStructures/Enzyme/, plus a sidecar
expasy_enzyme.meta.json recording the release, fetch date and source URLs.

ExPASy ENZYME is published by the SIB Swiss Institute of Bioinformatics
under the Creative Commons Attribution (CC BY 4.0) licence; the site's
Methods page credits it.

EGC_ENZYME_TREE.ipynb and the enzyme_paths migration read the saved copies,
so a regeneration always uses a known release; re-running this script is
how you deliberately move to a newer one.

A 200 response isn't proof of a real file (an HTML error page or a
truncated body also come back as 200), so both downloads are checked
BEFORE either saved copy is replaced, and both must come from the same
release. Each is written via a temp file + os.replace() so a crash
mid-write can't leave a half-written file. The meta sidecar is only
written after both replaces succeed.

Usage (from FastAPI/):
    python scripts/download_expasy_enzyme.py
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.config import ENZYME_DIR  # pylint: disable=wrong-import-position,import-error

# Saved file name -> download URL.
FILES = {
    "enzclass.txt": "https://ftp.expasy.org/databases/enzyme/enzclass.txt",
    "enzyme.dat":   "https://ftp.expasy.org/databases/enzyme/enzyme.dat",
}
META_NAME = "expasy_enzyme.meta.json"

# The 7 top-level EC classes, in order. A new class appearing is a real
# classification change that a person should look at, so it's refused
# rather than accepted silently.
EXPECTED_CLASSES = [
    "Oxidoreductases", "Transferases", "Hydrolases", "Lyases",
    "Isomerases", "Ligases", "Translocases",
]

# Floor on ID records in enzyme.dat. The 04-Nov-2026 release has 8,503;
# this catches a truncated body without breaking on normal growth.
MIN_ENTRIES = 7000

# ExPASy stores the files in Latin-1.
ENCODING = "latin-1"


def validate_enzclass(text: str) -> str:
    """Raise ValueError unless text looks like a real enzclass.txt.

    Returns:
        The release date written in the file, e.g. "04-Nov-2026".
    """
    top = re.findall(r"^\s*\d+\.\s*-\.\s*-\.-\s+(.+?)\.?\s*$", text, flags=re.M)
    if top != EXPECTED_CLASSES:
        raise ValueError(f"enzclass.txt top-level classes don't match the expected 7: got {top[:10]!r}")
    m = re.search(r"^Release:[ \t]+(\S+)", text, flags=re.M)
    if not m:
        raise ValueError("enzclass.txt has no Release line")
    return m.group(1)


def validate_enzyme_dat(text: str) -> str:
    """Raise ValueError unless text looks like a real enzyme.dat.

    Returns:
        The release date written in the file, e.g. "04-Nov-2026".
    """
    count = len(re.findall(r"^ID   ", text, flags=re.M))
    if count < MIN_ENTRIES:
        raise ValueError(f"enzyme.dat has only {count} entries, expected >= {MIN_ENTRIES} -- looks truncated")
    m = re.search(r"^CC[ \t]+Release of[ \t]+(\S+)", text, flags=re.M)
    if not m:
        raise ValueError("enzyme.dat has no 'Release of' line")
    return m.group(1)


def download_expasy_enzyme() -> str:
    """Fetch both files, check them, and save them plus the meta sidecar.

    Returns:
        The release date of the saved files.
    """
    texts = {}
    for name, url in FILES.items():
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        texts[name] = response.text

    release = validate_enzclass(texts["enzclass.txt"])
    dat_release = validate_enzyme_dat(texts["enzyme.dat"])
    if release != dat_release:
        raise ValueError(
            f"enzclass.txt (release {release}) and enzyme.dat (release {dat_release}) "
            "come from different releases"
        )

    os.makedirs(ENZYME_DIR, exist_ok=True)
    for name, text in texts.items():
        path = os.path.join(ENZYME_DIR, name)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding=ENCODING, newline="") as f:
            f.write(text)
        os.replace(tmp_path, path)

    with open(os.path.join(ENZYME_DIR, META_NAME), "w", encoding="utf-8") as f:
        json.dump(
            {
                "release": release,
                "source_urls": list(FILES.values()),
                "license": "CC BY 4.0",
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            },
            f,
            indent=2,
        )
    return release


def main():
    """Download and save the files, then say which release was saved."""
    release = download_expasy_enzyme()
    print(f"Saved ExPASy ENZYME release {release} to {ENZYME_DIR}")


if __name__ == "__main__":
    main()
