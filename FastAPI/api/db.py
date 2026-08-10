"""
db.py
=====
Connection lifecycle for the optional Mongo/SQLite backends. Called from
main.py's lifespan() at startup/shutdown; the returned connection/client
objects are stored on app.state and consumed by api.cache_mongo /
api.cache_sql.
"""

import sqlite3

from api.config import MONGO_URI, MONGO_DB_NAME, SQLITE_DB_PATH
from motor.motor_asyncio import AsyncIOMotorClient

def connect_to_mongo():
    """
    Connect to MongoDB using the URI and database name from the environment variables.
    Returns a (client db) tuple.
    """

    # Create a MongoClient using the URI
    client = AsyncIOMotorClient(MONGO_URI)

    # Access the specified database
    db = client[MONGO_DB_NAME]

    return client, db

def close_mongo_connection(client):
    """
    Close the MongoDB connection.
    """
    client.close()

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
