"""
test_ec_renumbered_from_parity.py
=================================
The site notes, on an enzyme node, the old EC numbers JGI's files use for
genes now credited to it (e.g. 5.6.1.10 holds what JGI calls 3.6.4.10).
That list lives in frontend/src/constants.ts as EC_RENUMBERED_FROM and must
be exactly the reverse of FastAPI/api/ec_renumbering.py's TRANSFERRED_EC,
or the note would name the wrong old number.

Run:
    pytest tests/test_ec_renumbered_from_parity.py -v
"""
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.ec_renumbering import TRANSFERRED_EC  # pylint: disable=wrong-import-position

CONSTANTS = Path(__file__).resolve().parent.parent / "frontend" / "src" / "constants.ts"


def _frontend_table() -> dict[str, list[str]]:
    text = CONSTANTS.read_text(encoding="utf-8")
    block = re.search(
        r"export const EC_RENUMBERED_FROM: Record<string, string\[\]> = \{(.*?)\n\}", text, re.S,
    )
    assert block, "EC_RENUMBERED_FROM not found in constants.ts"
    table = {}
    for new, olds in re.findall(r"'([^']+)':\s*\[([^\]]*)\]", block.group(1)):
        table[new] = re.findall(r"'([^']+)'", olds)
    return table


def test_frontend_table_is_the_reverse_of_transferred_ec():
    expected: dict[str, list[str]] = {}
    for old, new in TRANSFERRED_EC.items():
        expected.setdefault(new, []).append(old)
    frontend = _frontend_table()
    assert {k: sorted(v) for k, v in frontend.items()} == {k: sorted(v) for k, v in expected.items()}


def test_split_helicases_share_one_node():
    assert sorted(_frontend_table()["5.6.2"]) == ["3.6.4.12", "3.6.4.13"]
