"""
A correlation family reads every candidate's values in one go
(load_family_matrix). On the live server that read was most of a cold
family's time: one table-row lookup per value, scattered across the file.
The covering index in create_sql_indexes.py holds the values themselves,
so the read never leaves the index. This checks that a database built
from the real SCHEMA and INDEXES answers the real query from that index.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.correlation_loaders import load_family_matrix
from scripts.create_sql_indexes import INDEXES
from scripts.create_sql_schema import SCHEMA


def _plans_of_family_read(metric):
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    conn.executescript(INDEXES)
    queries = []
    conn.set_trace_callback(queries.append)
    load_family_matrix(conn, "taxonomy", ["Bacteria", "Archaea"], ["s1", "s2"], metric)
    conn.set_trace_callback(None)
    family_reads = [q for q in queries if "FROM annotation_series" in q]
    assert family_reads, "load_family_matrix ran no annotation_series query"
    return [row[3] for q in family_reads for row in conn.execute("EXPLAIN QUERY PLAN " + q)]


def test_egc_family_read_uses_the_covering_index():
    plans = _plans_of_family_read("egc")
    assert plans and all("COVERING INDEX idx_annotation_series_family_values" in p for p in plans), plans


def test_norm_egc_family_read_uses_the_covering_index():
    plans = _plans_of_family_read("norm_egc")
    assert plans and all("COVERING INDEX idx_annotation_series_family_values" in p for p in plans), plans
