"""
Tests for _connect()'s busy_timeout -- found live under real concurrent
traffic: two requests writing to correlations_cache around the same time,
one got an uncaught sqlite3.OperationalError("database is locked") and
500'd, because sqlite3's default busy_timeout is 0 (fail instantly instead
of waiting for the other write to finish).

Switching the db to WAL journal mode (the deeper fix for sustained
concurrent load -- the default journal mode locks the whole file per
writer, blocking every other reader/writer) is deliberately NOT part of
_connect() or these tests -- see create_sql_schema.py's create_schema(),
where it's applied once, at setup time, with nothing else connected.
Doing it from request-handling code was tried first and was itself racy:
switching journal mode requires no OTHER connection have a write
transaction open, a stricter condition than busy_timeout's wait-and-retry
covers, so the very first request after a restart could lose that race.

Uses a real temp file db (not :memory:) with two real connections -- file
locking semantics only apply across separate connections to the same file,
an in-memory db can't reproduce this.
"""
import os
import sqlite3
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "FastAPI"))

from api.correlation_sql import _connect

SCHEMA = "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)"


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    path = str(tmp_path / "test.db")
    conn = sqlite3.connect(path)
    conn.execute(SCHEMA)
    conn.commit()
    conn.close()
    import api.correlation_sql as correlation_sql
    monkeypatch.setattr(correlation_sql, "SQLITE_DB_PATH", path)
    return path


def test_connect_sets_the_intended_busy_timeout(db_path):
    # Python's sqlite3 module actually already defaults to a 5000ms
    # busy_timeout on this machine (its own `timeout=5.0` connect() default,
    # not SQLite's C-level default of 0) -- so a bare "timeout_ms > 0" check
    # would pass even if _connect()'s explicit PRAGMA were accidentally
    # removed. Assert the specific configured value instead so this test
    # actually catches that regression rather than silently relying on an
    # ambient default that isn't guaranteed across platforms/Python builds
    # (production's failure happened on a build where it evidently wasn't
    # enough).
    conn = _connect()
    try:
        timeout_ms = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert timeout_ms == 10_000
    finally:
        conn.close()


def test_connect_commits_without_waiting_for_a_full_disk_flush(db_path):
    # synchronous = NORMAL (1): in WAL mode a commit no longer waits for
    # the disk to confirm; a power cut can lose the last few saved
    # correlation results, which are recomputed on the next request. The
    # default, FULL (2), made every per-candidate commit wait.
    conn = _connect()
    try:
        assert conn.execute("PRAGMA synchronous").fetchone()[0] == 1
    finally:
        conn.close()


def test_second_writer_waits_instead_of_erroring_immediately(db_path):
    # Note: given the ambient-default discovery above, this alone doesn't
    # prove _connect()'s specific PRAGMA is what prevented the crash for a
    # short (0.3s) hold -- Python's own 5000ms default could cover that too
    # on this platform. It's still a real, useful smoke test that a brief
    # write-write conflict resolves cleanly rather than crashing; the exact-
    # value test above is the one that actually pins the fix itself.
    # Connection A holds a write lock open (BEGIN IMMEDIATE, no commit yet).
    conn_a = sqlite3.connect(db_path)
    conn_a.execute("BEGIN IMMEDIATE")
    conn_a.execute("INSERT INTO t (v) VALUES ('a')")

    results = {}

    def writer_b():
        conn_b = _connect()
        try:
            # Without a busy_timeout this raises sqlite3.OperationalError
            # ("database is locked") immediately, not after waiting.
            conn_b.execute("INSERT INTO t (v) VALUES ('b')")
            conn_b.commit()
            results["error"] = None
        except sqlite3.OperationalError as e:
            results["error"] = e
        finally:
            conn_b.close()

    thread = threading.Thread(target=writer_b)
    t0 = time.time()
    thread.start()

    # Hold the lock open briefly -- long enough that an unpatched connection
    # (busy_timeout=0) would have already failed before this point.
    time.sleep(0.3)
    conn_a.commit()
    thread.join(timeout=15)
    elapsed = time.time() - t0

    assert results["error"] is None  # waited it out, no crash
    assert elapsed >= 0.3  # actually waited for the lock, not a lucky race

    conn_a.close()
