import os

from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()

MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb://127.0.0.1:27017"
)

DATABASE_NAME = os.getenv(
    "DATABASE_NAME",
    "clove"
)

client = MongoClient(
    MONGO_URI,
    serverSelectionTimeoutMS=5000
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