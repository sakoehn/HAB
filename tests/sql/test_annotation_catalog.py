import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH),
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)


# Every test below takes a `conn` parameter to receive this fixture's
# value -- pylint sees that as shadowing the module-level `conn` name,
# but it's the standard pytest fixture-injection pattern, not a real bug.
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def conn():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


#======================================================================
# Tests
#======================================================================

def test_all_unique(conn):
    """Every row must be unqiue. The unqiue pair comes from source and
    annotation_id -- if multiple of same annotation term, does not reduce
    the search time. This table becomes redundant."""
    cursor = conn.execute("SELECT source, annotation_id FROM annotation_catalog")
    rows = cursor.fetchall()
    assert rows is not None
    seen = []
    has_dups = False
    for row in rows:
        key = (row[0], row[1])
        if key not in seen:
            seen.append(key)
        else:
            has_dups = True
    assert not has_dups

def test_correct_shape(conn):
    """Every column on the real table is exactly the set of fields the
    catalog is supposed to have -- source/annotation_id/name/parent plus
    the 5 aggregate stats, plus the id surrogate key. Catches a column
    typo/omission in the schema itself, not just in query results."""
    cursor = conn.execute("SELECT * FROM annotation_catalog LIMIT 1")
    row = cursor.fetchone()
    assert row is not None, "expected at least one row in annotation_catalog"
    columns = {desc[0] for desc in cursor.description}
    expected = {
        "id", "source", "annotation_id", "name", "parent",
        "mean_egc", "max_egc", "mean_norm_egc", "max_norm_egc", "sample_count",
    }
    assert columns == expected

def test_all_annotation_types_present(conn):
    """annotation_catalog must contain all annotation types (kegg, cog,
    enzyme, taxonomy) -- checks the reliability of the uniqe statement."""
    cursor = conn.execute("SELECT DISTINCT source FROM annotation_catalog")
    types = cursor.fetchall()
    assert types is not None
    expected = {"cog", "kegg", "enzyme","taxonomy"}
    result = {row[0] for row in types}
    assert result == expected

def test_matches_annotation_series_exactly(conn):
    """annotation_catalog must contain exactly the same set of
    (source, annotation_id) pairs as annotation_series -- not just a
    matching row count, which could hide a bug where one annotation was
    dropped and an unrelated one double-counted, cancelling out in the
    total."""
    series_pairs = {
        (row[0], row[1]) for row in
        conn.execute("SELECT DISTINCT source, annotation_id FROM annotation_series")
    }
    catalog_pairs = {
        (row[0], row[1]) for row in
        conn.execute("SELECT source, annotation_id FROM annotation_catalog")
    }
    assert series_pairs == catalog_pairs

def test_correct_values(conn):
    """No NULLs in any column where a real value is always expected.
    `parent` is deliberately excluded -- annotation_series documents it as
    legitimately NULL for cog (no equivalent field for that source), so a
    blanket NULL check there would fail on real, valid data, not a bug."""
    never_null_columns = [
        "source", "annotation_id", "name",
        "mean_egc", "max_egc", "mean_norm_egc", "max_norm_egc", "sample_count",
    ]
    for column in never_null_columns:
        count = conn.execute(
            f"SELECT COUNT(*) FROM annotation_catalog WHERE {column} IS NULL"
        ).fetchone()[0]
        assert count == 0, f"{column} has {count} NULL values"

    row = conn.execute("SELECT * FROM annotation_catalog LIMIT 1").fetchone()
    assert row is not None
    columns = [desc[0] for desc in conn.execute("SELECT * FROM annotation_catalog LIMIT 1").description]
    by_name = dict(zip(columns, row))

    assert isinstance(by_name["id"], int)
    assert isinstance(by_name["source"], str)
    assert isinstance(by_name["annotation_id"], str)
    assert isinstance(by_name["name"], str)
    assert isinstance(by_name["mean_egc"], float)
    assert isinstance(by_name["max_egc"], float)
    assert isinstance(by_name["mean_norm_egc"], float)
    assert isinstance(by_name["max_norm_egc"], float)
    assert isinstance(by_name["sample_count"], int)