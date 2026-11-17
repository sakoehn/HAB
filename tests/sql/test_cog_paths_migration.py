"""
test_cog_paths_migration.py
=============================
Tests for iter_cog_path_rows() (FastAPI/scripts/migrate_cog_paths_to_sql.py),
which builds cog_paths rows from DataStructures/COG/cog_categories.json.

A COG id can belong to more than one of NCBI's 26 categories (400 of
~5,000 COGs, e.g. COG0028 is listed under both category E and category H).
annotation_catalog.parent is a single TEXT column that can only express
one, so the script reads cog_categories.json directly to express real
multi-category membership.

Data-layer test: no database, no server -- just the row-generation
function in isolation, against a synthetic cog_categories.json.

Run:
    pytest tests/sql/test_cog_paths_migration.py -v
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from scripts.migrate_cog_paths_to_sql import iter_cog_path_rows  # noqa: E402


def _write_categories_file(tmp_path, rows):
    path = tmp_path / "cog_categories.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f)
    return str(path)


# A COG genuinely listed on two of NCBI's category pages (mirrors the real
# COG0028 case: E and H).
MULTI_CATEGORY_ROWS = [
    {"a_id": "E", "a_name": "Amino acid transport and metabolism",
     "b_id": "COG0028", "b_name": "Thiamine pyrophosphate-binding protein"},
    {"a_id": "H", "a_name": "Coenzyme transport and metabolism",
     "b_id": "COG0028", "b_name": "Thiamine pyrophosphate-binding protein"},
    {"a_id": "E", "a_name": "Amino acid transport and metabolism",
     "b_id": "COG0031", "b_name": "Cysteine synthase"},
]


def test_multi_category_cog_produces_one_row_per_membership(tmp_path):
    path = _write_categories_file(tmp_path, MULTI_CATEGORY_ROWS)
    valid_leaf_ids = {"COG0028", "COG0031"}

    rows = list(iter_cog_path_rows(path, valid_leaf_ids))

    cog0028_rows = [r for r in rows if r["b_id"] == "COG0028"]
    assert len(cog0028_rows) == 2, \
        "COG0028 belongs to 2 real NCBI categories -- must produce 2 rows, not 1"
    assert {r["a_id"] for r in cog0028_rows} == {"E", "H"}


def test_single_category_cog_produces_exactly_one_row(tmp_path):
    path = _write_categories_file(tmp_path, MULTI_CATEGORY_ROWS)
    valid_leaf_ids = {"COG0028", "COG0031"}

    rows = list(iter_cog_path_rows(path, valid_leaf_ids))

    cog0031_rows = [r for r in rows if r["b_id"] == "COG0031"]
    assert len(cog0031_rows) == 1
    assert cog0031_rows[0]["a_id"] == "E"


def test_ids_not_in_annotation_catalog_are_dropped(tmp_path):
    # COG0031 is a real membership in the file but not a real leaf in this
    # dataset (e.g. absent from the reference file, or from a stale
    # scrape) -- must not
    # appear in cog_paths.
    path = _write_categories_file(tmp_path, MULTI_CATEGORY_ROWS)
    valid_leaf_ids = {"COG0028"}

    rows = list(iter_cog_path_rows(path, valid_leaf_ids))

    assert all(r["b_id"] == "COG0028" for r in rows)
    assert len(rows) == 2


def test_full_path_is_unique_per_category_cog_pair(tmp_path):
    path = _write_categories_file(tmp_path, MULTI_CATEGORY_ROWS)
    valid_leaf_ids = {"COG0028", "COG0031"}

    rows = list(iter_cog_path_rows(path, valid_leaf_ids))
    full_paths = [r["full_path"] for r in rows]

    assert len(full_paths) == len(set(full_paths)), \
        "full_path must be unique per row (cog_paths.full_path has a UNIQUE constraint)"
    assert "E|COG0028" in full_paths
    assert "H|COG0028" in full_paths
