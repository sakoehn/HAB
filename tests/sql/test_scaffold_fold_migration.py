"""
test_scaffold_fold_migration.py
=================================
Tests for FastAPI/scripts/migrate_scaffold_fold_to_sql.py, which stores each
scaffold's AvgFold (from <sample>.a.depth.txt) and each sample's norm_egc
denominator, so EGC can be split by taxon at download time.

The first group uses an in-memory database and small depth files written to
tmp_path. The last group checks the real hab_mappings.db: adding up AvgFold
over every KO's genes must give back the KO's stored egc, and the stored
denominator must equal egc / norm_egc. It is skipped until the migration has
been run.

Run:
    pytest tests/sql/test_scaffold_fold_migration.py -v
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

from api.config import SQLITE_DB_PATH  # noqa: E402
from scripts.create_sql_schema import SCHEMA  # noqa: E402
from scripts.migrate_scaffold_fold_to_sql import load_sample, read_depth_file  # noqa: E402


# pylint: disable=redefined-outer-name

@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    connection.commit()
    yield connection
    connection.close()


def write_depth(tmp_path, lines):
    path = tmp_path / "s1.a.depth.txt"
    path.write_text("ID\tAvgFold\n" + "".join(line + "\n" for line in lines))
    return path


def add_genes(conn, sample, scaffolds):
    for i, scaffold in enumerate(scaffolds):
        conn.execute(
            "INSERT INTO mappings (sample, gene_id, scaffold_id) VALUES (?, ?, ?)",
            (sample, f"{scaffold}_{i}_{i + 10}", scaffold),
        )
    conn.commit()


# ── read_depth_file ───────────────────────────────────────────────────────────

def test_read_depth_file_reads_scaffold_values(tmp_path):
    path = write_depth(tmp_path, ["Ga01_0000001\t86", "Ga01_0000002\t141.5"])
    assert read_depth_file(path) == {"Ga01_0000001": 86.0, "Ga01_0000002": 141.5}


def test_read_depth_file_skips_blank_and_comment_lines(tmp_path):
    path = write_depth(tmp_path, ["", "# note", "Ga01_0000001\t3"])
    assert read_depth_file(path) == {"Ga01_0000001": 3.0}


def test_read_depth_file_keeps_first_value_like_all_coverages(tmp_path):
    # All_Coverages.py keeps the first value it sees for a scaffold; a
    # gene-level ID on the same scaffold must not overwrite it.
    path = write_depth(tmp_path, ["Ga01_0000001\t5", "Ga01_0000001_10_200\t9"])
    assert read_depth_file(path) == {"Ga01_0000001": 5.0}


def test_read_depth_file_rejects_unexpected_line(tmp_path):
    path = write_depth(tmp_path, ["Ga01_0000001\t5", "garbage line"])
    with pytest.raises(ValueError):
        read_depth_file(path)


# ── load_sample ───────────────────────────────────────────────────────────────

def test_load_sample_stores_only_mapped_scaffolds(conn, tmp_path):
    add_genes(conn, "s1", ["Ga01_0000001", "Ga01_0000001", "Ga01_0000002"])
    path = write_depth(tmp_path, ["Ga01_0000001\t10", "Ga01_0000002\t4", "Ga01_0000003\t99"])

    load_sample(conn, "s1", path)

    rows = conn.execute(
        "SELECT scaffold_id, avg_fold FROM scaffold_fold WHERE sample = 's1' ORDER BY scaffold_id"
    ).fetchall()
    assert rows == [("Ga01_0000001", 10.0), ("Ga01_0000002", 4.0)]


def test_load_sample_total_counts_each_gene(conn, tmp_path):
    # Two genes on scaffold 1 (fold 10) + one on scaffold 2 (fold 4):
    # 2*10 + 1*4 = 24, the weighted_totals.py formula.
    add_genes(conn, "s1", ["Ga01_0000001", "Ga01_0000001", "Ga01_0000002"])
    path = write_depth(tmp_path, ["Ga01_0000001\t10", "Ga01_0000002\t4"])

    load_sample(conn, "s1", path)

    total = conn.execute("SELECT weighted_total FROM sample_totals WHERE sample = 's1'").fetchone()[0]
    assert total == 24.0


def test_load_sample_rerun_replaces_rows(conn, tmp_path):
    add_genes(conn, "s1", ["Ga01_0000001"])
    load_sample(conn, "s1", write_depth(tmp_path, ["Ga01_0000001\t10"]))
    load_sample(conn, "s1", write_depth(tmp_path, ["Ga01_0000001\t7"]))

    assert conn.execute("SELECT avg_fold FROM scaffold_fold").fetchall() == [(7.0,)]
    assert conn.execute("SELECT weighted_total FROM sample_totals").fetchall() == [(7.0,)]


def test_load_sample_leaves_other_samples_alone(conn, tmp_path):
    add_genes(conn, "s1", ["Ga01_0000001"])
    add_genes(conn, "s2", ["Ga01_0000001"])
    load_sample(conn, "s2", write_depth(tmp_path, ["Ga01_0000001\t3"]))
    load_sample(conn, "s1", write_depth(tmp_path, ["Ga01_0000001\t10"]))

    assert conn.execute(
        "SELECT avg_fold FROM scaffold_fold WHERE sample = 's2'"
    ).fetchall() == [(3.0,)]


def test_load_sample_fails_when_mapped_scaffold_has_no_depth(conn, tmp_path):
    # Same rule as weighted_totals.py: a gene whose scaffold has no depth
    # must stop the build, not quietly count as 0.
    add_genes(conn, "s1", ["Ga01_0000001", "Ga01_0000009"])
    path = write_depth(tmp_path, ["Ga01_0000001\t10"])

    with pytest.raises(KeyError):
        load_sample(conn, "s1", path)
    assert conn.execute("SELECT COUNT(*) FROM scaffold_fold").fetchone()[0] == 0


# ── Real database ─────────────────────────────────────────────────────────────

def _real_db_has_tables():
    if not os.path.exists(SQLITE_DB_PATH) or os.path.getsize(SQLITE_DB_PATH) == 0:
        return False
    real = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    try:
        names = {r[0] for r in real.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    finally:
        real.close()
    return {"scaffold_fold", "sample_totals"} <= names


# First, a middle and the last sample, so a bad load anywhere in the run shows up.
REAL_SAMPLES = ["3300060358", "3300060426", "3300068252"]


@pytest.fixture(scope="module")
def real_conn():
    if not _real_db_has_tables():
        pytest.skip("scaffold_fold / sample_totals not built -- run migrate_scaffold_fold_to_sql.py")
    connection = sqlite3.connect(f"file:{SQLITE_DB_PATH}?mode=ro", uri=True)
    yield connection
    connection.close()


def test_real_every_sample_has_a_total(real_conn):
    mapped = {r[0] for r in real_conn.execute("SELECT DISTINCT sample FROM annotation_series")}
    totals = {r[0] for r in real_conn.execute("SELECT sample FROM sample_totals")}
    assert mapped == totals


@pytest.mark.parametrize("sample", REAL_SAMPLES)
def test_real_ko_sums_match_stored_egc(real_conn, sample):
    rebuilt = dict(real_conn.execute(
        """
        SELECT substr(m.kegg_id, 4), SUM(f.avg_fold)
        FROM mappings m
        JOIN scaffold_fold f ON f.sample = m.sample AND f.scaffold_id = m.scaffold_id
        WHERE m.sample = ? AND m.kegg_id IS NOT NULL
        GROUP BY m.kegg_id
        """,
        (sample,),
    ))
    stored = dict(real_conn.execute(
        "SELECT annotation_id, egc FROM annotation_series WHERE source = 'kegg' AND sample = ?",
        (sample,),
    ))
    assert stored, f"no kegg rows stored for {sample}"
    assert rebuilt.keys() == stored.keys()
    wrong = [k for k in stored if rebuilt[k] != pytest.approx(stored[k], rel=1e-9)]
    assert not wrong, f"{len(wrong)} KOs differ, e.g. {wrong[:5]}"


@pytest.mark.parametrize("sample", REAL_SAMPLES)
def test_real_total_is_the_norm_egc_denominator(real_conn, sample):
    total = real_conn.execute(
        "SELECT weighted_total FROM sample_totals WHERE sample = ?", (sample,)
    ).fetchone()[0]
    for source in ("kegg", "cog", "enzyme", "taxonomy"):
        egc, norm = real_conn.execute(
            "SELECT egc, norm_egc FROM annotation_series "
            "WHERE source = ? AND sample = ? AND norm_egc > 0 ORDER BY egc DESC LIMIT 1",
            (source, sample),
        ).fetchone()
        assert egc / norm == pytest.approx(total, rel=1e-9), source
