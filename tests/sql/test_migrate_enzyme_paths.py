"""
test_migrate_enzyme_paths.py
==============================
Tests for iter_enzyme_path_rows() in
FastAPI/scripts/migrate_enzyme_paths_to_sql.py, which yields one
enzyme_paths row per real EC node from the enzyme tree's nodes (built from
ExPASy ENZYME by api.expasy_enzyme.build_ec_nodes, the same nodes
EGC_ENZYME_TREE.ipynb uses).

Data-layer test: no database, no server -- small hand-written ExPASy-style
snippets only.

Run:
    pytest tests/sql/test_migrate_enzyme_paths.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.expasy_enzyme import build_ec_nodes, parse_enzclass, parse_enzyme_dat  # noqa: E402
from scripts.migrate_enzyme_paths_to_sql import iter_enzyme_path_rows  # noqa: E402

ENZCLASS = """\
7. -. -.-  Translocases.
7. 2. -.-   Catalysing the translocation of inorganic cations.
7. 2. 2.-    Linked to the hydrolysis of a nucleoside triphosphate.
7. 2. 3.-    Linked to the hydrolysis of a diphosphate.
"""

ENZYME_DAT = """\
ID   7.2.2.1
DE   ABC-type Na(+) transporter.
//
ID   7.2.3.1
DE   H(+)-exporting diphosphatase.
//
"""


@pytest.fixture
def nodes():
    return build_ec_nodes(parse_enzclass(ENZCLASS), parse_enzyme_dat(ENZYME_DAT), extra={})


def test_full_ec_number_row_carries_every_level(nodes):
    rows = list(iter_enzyme_path_rows(nodes, valid_ids={"7.2.3.1"}))
    assert rows == [{
        "a_id": "7", "a_name": "Translocases",
        "b_id": "7.2", "b_name": "Catalysing the translocation of inorganic cations",
        "c_id": "7.2.3", "c_name": "Linked to the hydrolysis of a diphosphate",
        "d_id": "7.2.3.1", "d_name": "H(+)-exporting diphosphatase",
        "full_path": "7|7.2|7.2.3|7.2.3.1",
    }]


def test_class_level_row_leaves_deeper_levels_empty(nodes):
    rows = list(iter_enzyme_path_rows(nodes, valid_ids={"7.2.2"}))
    assert len(rows) == 1
    assert rows[0]["c_id"] == "7.2.2"
    assert rows[0]["d_id"] is None and rows[0]["d_name"] is None
    assert rows[0]["full_path"] == "7|7.2|7.2.2"


def test_one_row_per_valid_id_in_id_order(nodes):
    rows = list(iter_enzyme_path_rows(nodes, valid_ids={"7.2.3.1", "7", "7.2.2.1"}))
    assert [r["full_path"] for r in rows] == ["7", "7|7.2|7.2.2|7.2.2.1", "7|7.2|7.2.3|7.2.3.1"]


def test_ids_not_in_valid_ids_are_not_yielded(nodes):
    assert list(iter_enzyme_path_rows(nodes, valid_ids=set())) == []


def test_a_valid_id_that_is_not_a_node_is_refused(nodes):
    # Every enzyme id in annotation_catalog comes from the notebook, which
    # only ever credits real nodes -- anything else means the two are out
    # of step (e.g. a different ExPASy release).
    with pytest.raises(ValueError, match="9.9.9.9"):
        list(iter_enzyme_path_rows(nodes, valid_ids={"9.9.9.9"}))
