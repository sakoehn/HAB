import os, sys, sqlite3, time
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = "/home/mriffle/dev/sophie-metatrace/HAB"
sys.path.insert(0, os.path.join(REPO, "FastAPI"))
DB_PATH = os.path.join(HERE, "bench.db")
from api import correlation_sql  # noqa
from api import correlation_loaders  # noqa
correlation_sql.SQLITE_DB_PATH = DB_PATH  # _connect() reads this module global


def clear_cache():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM correlations_cache")
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()


def ref_and_candidates(conn, ref_source, ref_annotation_id, target_source):
    ref_catalog_id = conn.execute(
        "SELECT id FROM annotation_catalog WHERE source = ? AND annotation_id = ?",
        (ref_source, ref_annotation_id)).fetchone()[0]
    cands = correlation_sql.get_family_candidates(conn, ref_catalog_id, target_source)
    return ref_catalog_id, cands
