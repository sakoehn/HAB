"""
test_verify_annotations_migration.py
======================================
P6 (docs/AUDIT-2026-10-05.md): verify_annotations_migration_against_json.py
used to compare only ROW COUNTS between the source JSON and the database,
so it would print "ALL SOURCES MATCH" even if every egc/norm_egc value were
wrong. These tests pin its per-value comparison: hand-built JSON + db rows,
each with one known defect, must each be reported.

Pure in-memory fixtures -- never touches the real hab_mappings.db or the
~12GB of real source JSON.

Run:
    pytest tests/sql/test_verify_annotations_migration.py -v
"""

import json
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from scripts.verify_annotations_migration_against_json import (
    compare_values,
    count_from_json,
    values_from_sql,
)


def _json(**entries):
    """{annotation_id: {"egc": .., "norm_egc": ..}} like a real per-sample JSON."""
    return {aid: {"name": aid, "egc": egc, "norm_egc": norm, "scaffolds": {}}
            for aid, (egc, norm) in entries.items()}


def test_identical_values_report_nothing():
    data = _json(COG0001=(1.5, 0.002), COG0002=(0.0, 0.0))
    rows = {"COG0001": (1.5, 0.002), "COG0002": (0.0, 0.0)}
    assert compare_values(data, rows) == []


def test_wrong_egc_is_reported():
    data = _json(COG0001=(1.5, 0.002))
    rows = {"COG0001": (9.9, 0.002)}
    assert compare_values(data, rows) == [("COG0001", "egc", 1.5, 9.9)]


def test_wrong_norm_egc_is_reported():
    data = _json(COG0001=(1.5, 0.002))
    rows = {"COG0001": (1.5, 0.003)}
    assert compare_values(data, rows) == [("COG0001", "norm_egc", 0.002, 0.003)]


def test_annotation_missing_from_db_is_reported():
    data = _json(COG0001=(1.5, 0.002), COG0002=(2.0, 0.004))
    rows = {"COG0001": (1.5, 0.002)}
    assert compare_values(data, rows) == [("COG0002", "missing_in_sql", None, None)]


def test_annotation_extra_in_db_is_reported():
    data = _json(COG0001=(1.5, 0.002))
    rows = {"COG0001": (1.5, 0.002), "COG9999": (3.0, 0.1)}
    assert compare_values(data, rows) == [("COG9999", "missing_in_json", None, None)]


def test_none_vs_number_is_a_mismatch_but_none_vs_none_is_not():
    data = _json(COG0001=(None, 0.002), COG0002=(None, None))
    rows = {"COG0001": (0.0, 0.002), "COG0002": (None, None)}
    assert compare_values(data, rows) == [("COG0001", "egc", None, 0.0)]


def test_float_round_trip_noise_within_tolerance_is_not_a_mismatch():
    # REAL storage can differ from the JSON's decimal text by the last ulp.
    data = _json(COG0001=(0.1 + 0.2, 1e-7))
    rows = {"COG0001": (0.3, 1e-7 * (1 + 1e-12))}
    assert compare_values(data, rows) == []


def test_values_from_sql_scopes_to_one_source_and_sample():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE annotation_series (source TEXT, sample TEXT, "
        "annotation_id TEXT, egc REAL, norm_egc REAL)"
    )
    conn.executemany(
        "INSERT INTO annotation_series VALUES (?, ?, ?, ?, ?)",
        [
            ("cog", "S1", "COG0001", 1.5, 0.002),
            ("cog", "S2", "COG0001", 7.0, 0.009),   # other sample
            ("kegg", "S1", "K00001", 4.0, 0.005),   # other source
        ],
    )
    assert values_from_sql(conn, "cog", "S1") == {"COG0001": (1.5, 0.002)}


def test_values_from_sql_end_to_end_with_compare_catches_a_bad_value():
    """The two pieces wired together the way main() uses them."""
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE annotation_series (source TEXT, sample TEXT, "
        "annotation_id TEXT, egc REAL, norm_egc REAL)"
    )
    conn.execute("INSERT INTO annotation_series VALUES ('cog', 'S1', 'COG0001', 2.0, 0.002)")
    data = _json(COG0001=(1.5, 0.002))
    assert compare_values(data, values_from_sql(conn, "cog", "S1")) == [
        ("COG0001", "egc", 1.5, 2.0)
    ]


@pytest.mark.parametrize("bad", [float("nan")])
def test_nan_is_never_silently_equal(bad):
    data = _json(COG0001=(bad, 0.002))
    rows = {"COG0001": (1.5, 0.002)}
    assert len(compare_values(data, rows)) == 1


def test_count_from_json_checks_values_per_sample_file(tmp_path):
    """The file loop main() uses: sample name comes from the filename minus
    the suffix, and a wrong db value in one sample is reported against that
    sample -- not silently compared against zero rows."""
    (tmp_path / "S1.cog.json").write_text(json.dumps(_json(COG0001=(1.5, 0.002))))
    (tmp_path / "S2.cog.json").write_text(json.dumps(_json(COG0001=(7.0, 0.009))))
    (tmp_path / "notes.txt").write_text("ignored")
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE annotation_series (source TEXT, sample TEXT, "
        "annotation_id TEXT, egc REAL, norm_egc REAL)"
    )
    conn.executemany(
        "INSERT INTO annotation_series VALUES (?, ?, ?, ?, ?)",
        [("cog", "S1", "COG0001", 1.5, 0.002), ("cog", "S2", "COG0001", 7.0, 0.5)],
    )
    samples, series, scaffolds, mismatches = count_from_json(str(tmp_path), ".cog.json", conn, "cog")
    assert (samples, series, scaffolds) == (2, 2, 0)
    assert mismatches == [("S2", "COG0001", "norm_egc", 0.009, 0.5)]
