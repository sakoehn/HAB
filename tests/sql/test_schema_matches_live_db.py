"""
test_schema_matches_live_db.py
================================
P5 (docs/AUDIT-2026-10-05.md): create_sql_schema.py is the blueprint for a
from-scratch rebuild, but the real hab_mappings.db picked up later changes
(ALTER TABLE backfills, column re-adds) the blueprint never recorded. This
builds a fresh in-memory database from the blueprint and compares every
table's columns (name, type, NOT NULL, primary key, AND position) against
the real database's PRAGMA table_info.

Position matters, not just the set of names: any INSERT ... VALUES / SELECT *
that relies on column order would silently put values in the wrong columns
on a fresh build if the order drifted.

The only difference allowed is listed in ALLOWED_NOTNULL_DRIFT, on purpose.

Run:
    pytest tests/sql/test_schema_matches_live_db.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH
from scripts.create_sql_schema import SCHEMA

pytestmark = pytest.mark.skipif(
    not os.path.exists(SQLITE_DB_PATH) or os.path.getsize(SQLITE_DB_PATH) == 0,
    reason=f"{SQLITE_DB_PATH} not found -- run migrate_mappings_to_sql.py first",
)

# gene_cog.sample / gene_enzyme.sample were added to the live db after the
# fact by scripts/backfill_gene_cog_sample_column.py (ALTER TABLE ADD COLUMN
# can't add a NOT NULL column without a default), so the live columns are
# nullable. The blueprint deliberately keeps NOT NULL so a fresh build gets
# the stricter, intended rule -- 0 real NULLs exist in either live table.
ALLOWED_NOTNULL_DRIFT = {("gene_cog", "sample"), ("gene_enzyme", "sample")}


def _table_info(connection, table):
    """[(name, TYPE, notnull, pk), ...] in declared column order."""
    return [
        (row[1], row[2].upper(), bool(row[3]), bool(row[5]))
        for row in connection.execute(f"PRAGMA table_info({table})")
    ]


def _tables(connection):
    return {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    }


@pytest.fixture(scope="module")
def fresh():
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def live():
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


# pylint: disable=redefined-outer-name

def test_same_set_of_tables(fresh, live):
    assert _tables(fresh) == _tables(live)


@pytest.mark.parametrize("table", [
    "taxon_paths", "kegg_paths", "enzyme_paths", "cog_paths", "mappings",
    "gene_cog", "gene_enzyme", "annotation_series", "annotation_catalog",
    "scaffolds", "correlations_cache",
])
def test_columns_match_live_db_in_order(fresh, live, table):
    fresh_cols = _table_info(fresh, table)
    live_cols = _table_info(live, table)

    # Same names in the same positions.
    assert [c[0] for c in fresh_cols] == [c[0] for c in live_cols]

    for f, l in zip(fresh_cols, live_cols):
        name, f_type, f_notnull, f_pk = f
        _, l_type, l_notnull, l_pk = l
        assert (f_type, f_pk) == (l_type, l_pk), f"{table}.{name}"
        if (table, name) in ALLOWED_NOTNULL_DRIFT:
            # The allowed drift is one-directional: blueprint stricter
            # than live, never the other way round.
            assert f_notnull and not l_notnull, f"{table}.{name}"
        else:
            assert f_notnull == l_notnull, f"{table}.{name}"


def test_cog_parent_and_depth_match_schema_comments(live):
    """The schema comments describe cog's parent/depth -- pin what the real
    catalog actually holds so the comments can't silently go stale again:
    parent is NULL only for the category roots (depth 1), every COG leaf
    (depth 2) carries its category letter as parent, depth is never NULL."""
    rows = live.execute(
        "SELECT depth, parent IS NULL, COUNT(*) FROM annotation_catalog "
        "WHERE source = 'cog' GROUP BY depth, parent IS NULL"
    ).fetchall()
    by_key = {(depth, bool(is_null)): n for depth, is_null, n in rows}
    assert set(by_key) == {(1, True), (2, False)}
