"""
test_methods_page_facts.py
============================
The Methods page (frontend/src/pages/MethodsPage.tsx) states the
correlation lag window and the Correlates list limits as numbers. They live in METHODS_FACTS (methodsFacts.ts);
this checks that block against the backend's real values, so the page
can't drift from the code (the old About page said "9 lags" and "1000
random shifts" long after both had changed). It also checks the page cites
the ExPASy ENZYME release the enzyme names come from, and no longer cites
KEGG's hierarchy files, which the site does not use.

Run:
    pytest tests/test_methods_page_facts.py -v
"""
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
EXPASY_META = ROOT / "DataStructures" / "Enzyme" / "expasy_enzyme.meta.json"


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


def test_expasy_release_matches_the_downloaded_files():
    if not EXPASY_META.exists():
        pytest.skip(f"{EXPASY_META} not present (data files are not in git)")
    meta = json.loads(EXPASY_META.read_text(encoding="utf-8"))
    text = METHODS_PAGE.read_text(encoding="utf-8")
    assert f"ExPASy ENZYME (release {meta['release']}" in text
    assert meta["license"] in text


def test_methods_page_cites_no_kegg_hierarchy_file():
    text = METHODS_PAGE.read_text(encoding="utf-8")
    for gone in ("ko00001", "ko01000", "KEGG BRITE", "BRITE table", "KEGG group"):
        assert gone not in text, gone
