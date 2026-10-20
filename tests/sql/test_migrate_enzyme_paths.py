"""
test_migrate_enzyme_paths.py
==============================
Tests for iter_enzyme_path_rows() in
FastAPI/scripts/migrate_enzyme_paths_to_sql.py -- the BRITE-file parser
that walks ko01000.keg and yields one row per real EC node.

Data-layer test: no database, no server -- just the parser against a
small, hand-written .keg fixture written to a temp file, same spirit as
test_migrate_annotations.py testing build_annotation_series_row().

Covers bare C-lines: a line like "C    7.2.3" (digits only, no trailing
name -- the real shape of ko01000.keg line 17308) must still be parsed.
Skipping it would leave current_at_depth stale at the PREVIOUS named
C-line, so the next D-line would inherit the wrong parent.

Run:
    pytest tests/sql/test_migrate_enzyme_paths.py -v
"""

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from scripts.migrate_enzyme_paths_to_sql import iter_enzyme_path_rows


# Minimal .keg fixture reproducing the real bug shape: a bare C-line with
# no trailing name ("7.2.3"), followed by a D-line ("7.2.3.1") that must
# attach to IT, not to the previous named C-line ("7.2.2").
BRITE_FIXTURE_BARE_C_LINE = """\
A<b>7. Translocases</b>
B  7.2  Catalysing the translocation of inorganic cations and their chelates
C    7.2.2  Linked to the hydrolysis of a nucleoside triphosphate
D      7.2.2.1  ABC-type Na+ transporter
C    7.2.3
D      7.2.3.1  ABC-type cation transporter
"""


@pytest.fixture
def keg_file(tmp_path):
    p = tmp_path / "ko01000.keg"
    p.write_text(BRITE_FIXTURE_BARE_C_LINE, encoding="utf-8")
    return str(p)


def test_bare_c_line_with_no_name_still_becomes_a_real_node(keg_file):
    rows = list(iter_enzyme_path_rows(keg_file, valid_ids={"7.2.3"}))
    assert len(rows) == 1
    assert rows[0]["c_id"] == "7.2.3"
    # No trailing name text on the real line -- falls back to the bare id.
    assert rows[0]["c_name"] == "7.2.3"
    assert rows[0]["b_id"] == "7.2"


def test_d_line_after_a_bare_c_line_attaches_to_the_bare_c_line_not_the_previous_one(keg_file):
    rows = list(iter_enzyme_path_rows(keg_file, valid_ids={"7.2.3.1"}))
    assert len(rows) == 1
    row = rows[0]
    assert row["d_id"] == "7.2.3.1"
    # The real bug: without the fix, this stayed "7.2.2" (the previous
    # NAMED C-line) instead of advancing to the new bare "7.2.3".
    assert row["c_id"] == "7.2.3"
    assert row["full_path"] == "7|7.2|7.2.3|7.2.3.1"


def test_d_line_after_a_named_c_line_is_unaffected_by_the_fix(keg_file):
    rows = list(iter_enzyme_path_rows(keg_file, valid_ids={"7.2.2.1"}))
    assert len(rows) == 1
    row = rows[0]
    assert row["d_id"] == "7.2.2.1"
    assert row["c_id"] == "7.2.2"
    assert row["c_name"] == "Linked to the hydrolysis of a nucleoside triphosphate"


def test_ids_not_in_valid_ids_are_not_yielded(keg_file):
    rows = list(iter_enzyme_path_rows(keg_file, valid_ids=set()))
    assert rows == []
