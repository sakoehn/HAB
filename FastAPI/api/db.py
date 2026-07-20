from api.config import MONGO_URI, MONGO_DB_NAME
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
