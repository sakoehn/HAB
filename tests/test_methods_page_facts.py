"""
test_methods_page_facts.py
============================
The Methods page (frontend/src/pages/MethodsPage.tsx) states the
correlation lag window and the Correlates list limits as numbers. They live in METHODS_FACTS (methodsFacts.ts);
this checks that block against the backend's real values, so the page
can't drift from the code (the old About page said "9 lags" and "1000
random shifts" long after both had changed).

Run:
    pytest tests/test_methods_page_facts.py -v
"""
import hashlib
import inspect
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api import correlation_sql  # pylint: disable=wrong-import-position
from api.config import CORRELATION_LAGS, LAG_HOURS_PER_SAMPLE  # pylint: disable=wrong-import-position

import pytest  # pylint: disable=wrong-import-position

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "frontend" / "src" / "pages" / "methodsFacts.ts"
METHODS_PAGE = ROOT / "frontend" / "src" / "pages" / "MethodsPage.tsx"
KEG_FILES = {
    "ko00001": ROOT / "DataStructures" / "Kegg" / "ko00001.keg",
    "ko01000": ROOT / "DataStructures" / "Enzyme" / "ko01000.keg",
}


def _facts() -> dict:
    block = re.search(r"export const METHODS_FACTS = \{(.*?)\n\}", PAGE.read_text(encoding="utf-8"), re.S).group(1)

    def num(key):
        return int(re.search(rf"\b{key}:\s*(-?\d+)", block).group(1))

    lags = [int(x) for x in re.search(r"correlationLags:\s*\[([^\]]*)\]", block).group(1).split(",")]
    return {
        "lags": lags,
        "hours": num("lagHoursPerSample"),
        "limit_default": num("familyLimitDefault"),
        "limit_max": num("familyLimitMax"),
    }


def test_lag_window_matches_backend():
    assert _facts()["lags"] == CORRELATION_LAGS
    assert _facts()["hours"] == LAG_HOURS_PER_SAMPLE


def test_family_limit_matches_backend():
    src = inspect.getsource(correlation_sql)
    m = re.search(r"limit:\s*int\s*=\s*Query\((\d+),\s*ge=1,\s*le=(\d+)\)", src)
    assert (_facts()["limit_default"], _facts()["limit_max"]) == (int(m.group(1)), int(m.group(2)))


def _last_updated(keg: Path) -> str:
    """The file's own '#Last updated: May 22, 2026' line, as '22 May 2026'."""
    m = re.search(r"^#Last updated: (\w+) (\d+), (\d{4})", keg.read_text(encoding="utf-8"), re.M)
    return f"{int(m.group(2))} {m.group(1)} {m.group(3)}"


@pytest.mark.parametrize("name", sorted(KEG_FILES))
def test_kegg_release_dates_match_the_files(name):
    keg = KEG_FILES[name]
    if not keg.exists():
        pytest.skip(f"{keg} not present (data files are not in git)")
    text = re.sub(r"\s+", " ", METHODS_PAGE.read_text(encoding="utf-8"))
    assert f"KEGG BRITE {name} (KEGG release dated {_last_updated(keg)}" in text


@pytest.mark.parametrize("name", sorted(KEG_FILES))
def test_kegg_files_have_a_provenance_record(name):
    keg = KEG_FILES[name]
    if not keg.exists():
        pytest.skip(f"{keg} not present (data files are not in git)")
    meta = json.loads(keg.with_name(keg.name + ".meta.json").read_text(encoding="utf-8"))
    assert meta["source_url"].endswith(f"htext={name}.keg&format=htext")
    assert meta["fetched_at"]
    if "sha256" in meta:
        assert meta["sha256"] == hashlib.sha256(keg.read_bytes()).hexdigest()
