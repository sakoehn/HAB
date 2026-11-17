"""
test_series_export_undetected_parent.py
=======================================
include_parent for a kegg/cog/enzyme starting term that is in the
hierarchy but was never detected (no annotation_catalog row). The real
database has no such term today, so this uses a small in-memory database
built from the real schema: one EC sub-subclass, 1.1.1, whose EC number
1.1.1.1 was detected while 1.1.1 itself was not.

Run:
    pytest tests/sql/test_series_export_undetected_parent.py -v
"""

import os
import sqlite3
import sys

import pytest
from fastapi import HTTPException

_FASTAPI = os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI")
sys.path.insert(0, _FASTAPI)
sys.path.insert(0, os.path.join(_FASTAPI, "scripts"))

from create_sql_schema import SCHEMA  # noqa: E402
from api import cache_sql, routes  # noqa: E402
from api.cache import AnnotationSource  # noqa: E402

# pylint: disable=redefined-outer-name


@pytest.fixture
def conn(monkeypatch):
    # The sample list is cached per process; keep this database's empty
    # list out of the other tests.
    monkeypatch.setattr(cache_sql, "_ALL_SAMPLES_SQL_CACHE", None)
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    connection.execute(
        "INSERT INTO enzyme_paths(a_id,a_name,b_id,b_name,c_id,c_name,d_id,d_name,full_path) "
        "VALUES ('1','Oxidoreductases','1.1','Acting on the CH-OH group of donors',"
        "'1.1.1','With NAD(+) or NADP(+) as acceptor','1.1.1.1','alcohol dehydrogenase','1|1.1|1.1.1|1.1.1.1')"
    )
    connection.execute(
        "INSERT INTO annotation_catalog(source,annotation_id,name,parent,mean_egc,max_egc,"
        "mean_norm_egc,max_norm_egc,sample_count,depth) "
        "VALUES ('enzyme','1.1.1.1','alcohol dehydrogenase','1.1.1',1,1,0.1,0.1,1,4)"
    )
    connection.commit()
    yield connection
    connection.close()


def _plan(conn, parent, include_parent):
    return routes._series_export_plan(conn, AnnotationSource.enzyme, parent, "ec", None, None, include_parent)


def test_undetected_starting_term_is_a_404_not_a_crash(conn):
    with pytest.raises(HTTPException) as err:
        _plan(conn, "1.1.1", include_parent=True)
    assert err.value.status_code == 404
    assert "1.1.1" in err.value.detail
    assert "never detected" in err.value.detail


def test_undetected_starting_term_without_include_parent_still_lists_its_children(conn):
    plan = _plan(conn, "1.1.1", include_parent=False)
    assert [e["annotation_id"] for e in plan["entries"]] == ["1.1.1.1"]
    assert plan["start"] is None


def test_detected_starting_term_is_still_added(conn):
    conn.execute(
        "INSERT INTO annotation_catalog(source,annotation_id,name,parent,mean_egc,max_egc,"
        "mean_norm_egc,max_norm_egc,sample_count,depth) "
        "VALUES ('enzyme','1.1.1','With NAD(+) or NADP(+) as acceptor','1.1',1,1,0.1,0.1,1,3)"
    )
    plan = _plan(conn, "1.1.1", include_parent=True)
    assert plan["start"]["annotation_id"] == "1.1.1"
