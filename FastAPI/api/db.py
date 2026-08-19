"""
db.py
=====
Connection lifecycle for the SQLite backend. Called from main.py's
lifespan() at startup/shutdown; the returned connection is stored on
app.state and consumed by api.cache_sql.
"""

import sqlite3

from api.config import SQLITE_DB_PATH

def connect_to_sql() -> sqlite3.Connection:
    """Open the SQLite database used by DATA_BACKEND=sql.

    Returns:
        A connection with check_same_thread=False -- required since this
        connection is opened once at startup and reused for every
        request, and FastAPI may hand different requests to different
        threads.
    """
    return sqlite3.connect(SQLITE_DB_PATH, check_same_thread=False)

def close_sql_connection(conn: sqlite3.Connection):
    """
    Close the SQLite connection.
    """
    conn.close()
