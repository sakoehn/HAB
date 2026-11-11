"""
get_top_annotations_sql (the date-filtered /annotations/top path) adds up
egc/norm_egc per annotation over the chosen samples. name, parent and depth
are the same in every sample, so they come from annotation_catalog, once per
annotation, and the per-sample numbers come from the covering index alone:
reading a table row per sample just for those three columns made a 3-day
taxonomy range take 36-69 s on the live server.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.cache_sql import get_top_annotations_sql
from scripts.create_sql_indexes import INDEXES
from scripts.create_sql_schema import SCHEMA

# annotation_id -> (name, parent, depth, {sample: (egc, norm_egc)})
ANNOTATIONS = {
    "A":    ("Alpha", None, 1, {"s1": (10.0, 0.1), "s2": (30.0, 0.3), "s3": (500.0, 0.9)}),
    "A;b":  ("beta",  "A",  2, {"s1": (4.0, 0.04), "s2": (8.0, 0.08)}),
    "A;c":  ("gamma", "A",  2, {"s2": (6.0, 0.06)}),          # only in s2
    "A;d":  ("delta", "A",  2, {"s1": (6.0, 0.06)}),          # ties A;c on mean
    "A;e":  ("eps",   "A",  2, {"s3": (99.0, 0.5)}),          # outside s1/s2 only
}


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    connection.executescript(INDEXES)
    for annotation_id, (name, parent, depth, values) in ANNOTATIONS.items():
        connection.execute(
            "INSERT INTO annotation_catalog (source, annotation_id, name, parent, depth) VALUES ('taxonomy', ?, ?, ?, ?)",
            (annotation_id, name, parent, depth))
        for sample, (egc, norm_egc) in values.items():
            connection.execute(
                "INSERT INTO annotation_series (source, sample, annotation_id, name, parent, depth, egc, norm_egc) "
                "VALUES ('taxonomy', ?, ?, ?, ?, ?, ?, ?)",
                (sample, annotation_id, name, parent, depth, egc, norm_egc))
    # Same id under another source: must never be joined in.
    connection.execute(
        "INSERT INTO annotation_catalog (source, annotation_id, name, parent, depth) VALUES ('kegg', 'A', 'Wrong', NULL, 2)")
    yield connection
    connection.close()


def _by_id(rows):
    return {r["annotation_id"]: r for r in rows}


def test_averages_over_the_chosen_samples_only(conn):
    rows = _by_id(get_top_annotations_sql(conn, "taxonomy", ["s1", "s2"]))
    assert set(rows) == {"A", "A;b", "A;c", "A;d"}           # A;e is only in s3
    assert rows["A"] == {"annotation_id": "A", "name": "Alpha", "parent": None, "depth": 1,
                         "mean_egc": 20.0, "max_egc": 30.0, "mean_norm_egc": pytest.approx(0.2),
                         "max_norm_egc": 0.3, "sample_count": 2}
    assert rows["A;c"]["sample_count"] == 1
    assert rows["A;c"]["mean_egc"] == 6.0


def test_sorted_by_mean_then_id_so_ties_always_come_out_the_same_way(conn):
    rows = get_top_annotations_sql(conn, "taxonomy", ["s1", "s2"])
    assert [r["annotation_id"] for r in rows] == ["A", "A;b", "A;c", "A;d"]   # A;c and A;d tie at 6.0


def test_depth_filter(conn):
    rows = get_top_annotations_sql(conn, "taxonomy", ["s1", "s2", "s3"], depths=[2])
    assert [r["annotation_id"] for r in rows] == ["A;e", "A;b", "A;c", "A;d"]


def test_id_filter(conn):
    rows = get_top_annotations_sql(conn, "taxonomy", ["s1", "s2"], annotation_ids=["A;b", "A;e"])
    assert [r["annotation_id"] for r in rows] == ["A;b"]


def test_no_matching_samples_gives_no_rows(conn):
    assert get_top_annotations_sql(conn, "taxonomy", ["s9"]) == []


def _annotation_series_plan_steps(conn, **kwargs):
    queries = []
    conn.set_trace_callback(queries.append)
    get_top_annotations_sql(conn, "taxonomy", ["s1", "s2"], **kwargs)
    conn.set_trace_callback(None)
    assert len(queries) == 1
    steps = [row[3] for row in conn.execute("EXPLAIN QUERY PLAN " + queries[0])]
    return [s for s in steps if "annotation_series" in s]


@pytest.mark.parametrize("kwargs", [{}, {"depths": [2]}, {"annotation_ids": ["A;b"]}])
def test_reads_annotation_series_only_from_the_covering_index(conn, kwargs):
    steps = _annotation_series_plan_steps(conn, **kwargs)
    assert steps and all("COVERING INDEX idx_annotation_series_family_values" in s for s in steps), steps
