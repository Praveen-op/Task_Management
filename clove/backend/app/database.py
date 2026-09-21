import os

from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()
# Connected to MongoDB Atlas Cloud Database


MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb://127.0.0.1:27017"
)

DATABASE_NAME = os.getenv(
    "DATABASE_NAME",
    "clove"
)

client_kwargs = {
    "serverSelectionTimeoutMS": 5000
}

if "mongodb+srv" in MONGO_URI or "tls=true" in MONGO_URI:
    try:
        import certifi
        client_kwargs["tlsCAFile"] = certifi.where()
    except Exception:
        pass
    client_kwargs["tlsAllowInvalidCertificates"] = True


client = MongoClient(
    MONGO_URI,
    **client_kwargs
)

db = client[DATABASE_NAME]


users_collection = db["users"]
projects_collection = db["projects"]
issues_collection = db["issues"]
comments_collection = db["comments"]
notifications_collection = db["notifications"]
invitations_collection = db["invitations"]


def check_database():
    try:
        client.admin.command("ping")
        return True
    except Exception as error:
        print("MongoDB connection error:", error)
        return False