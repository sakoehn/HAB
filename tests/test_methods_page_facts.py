"""
test_methods_page_facts.py
============================
The Methods page (frontend/src/pages/MethodsPage.tsx) states the
correlation lag window, the circular-shift prescreen size and the
Correlates list limits as numbers. They live in METHODS_FACTS (methodsFacts.ts);
this checks that block against the backend's real values, so the page
can't drift from the code (the old About page said "9 lags" and "1000
random shifts" long after both had changed).

Run:
    pytest tests/test_methods_page_facts.py -v
"""
import inspect
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api import correlation_sql  # pylint: disable=wrong-import-position
from api.config import CORRELATION_LAGS, LAG_HOURS_PER_SAMPLE  # pylint: disable=wrong-import-position

PAGE = Path(__file__).resolve().parent.parent / "frontend" / "src" / "pages" / "methodsFacts.ts"


def _facts() -> dict:
    block = re.search(r"export const METHODS_FACTS = \{(.*?)\n\}", PAGE.read_text(encoding="utf-8"), re.S).group(1)

    def num(key):
        return int(re.search(rf"\b{key}:\s*(-?\d+)", block).group(1))

    lags = [int(x) for x in re.search(r"correlationLags:\s*\[([^\]]*)\]", block).group(1).split(",")]
    return {
        "lags": lags,
        "hours": num("lagHoursPerSample"),
        "top_n": num("circularShiftScreenTopN"),
        "limit_default": num("familyLimitDefault"),
        "limit_max": num("familyLimitMax"),
    }


def test_lag_window_matches_backend():
    assert _facts()["lags"] == CORRELATION_LAGS
    assert _facts()["hours"] == LAG_HOURS_PER_SAMPLE


def test_prescreen_size_matches_backend():
    assert _facts()["top_n"] == correlation_sql.CIRCULAR_SHIFT_SCREEN_TOP_N


def test_family_limit_matches_backend():
    src = inspect.getsource(correlation_sql)
    m = re.search(r"limit:\s*int\s*=\s*Query\((\d+),\s*ge=1,\s*le=(\d+)\)", src)
    assert (_facts()["limit_default"], _facts()["limit_max"]) == (int(m.group(1)), int(m.group(2)))
