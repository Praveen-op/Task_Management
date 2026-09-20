from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from bson import ObjectId
from .database import users_collection
from .security import decode_token

bearer = HTTPBearer()

def current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    try:
        user_id = decode_token(credentials.credentials)
        user = users_collection.find_one({"_id": ObjectId(user_id)})
    except Exception:
        user = None

    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    user["_id"] = str(user["_id"])
    return user
