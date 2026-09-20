from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from bson import ObjectId
from .database import users_collection, invitations_collection
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

    user_id_str = str(user["_id"])
    user["_id"] = user_id_str

    # Ensure user has an isolated team_id
    if not user.get("team_id"):
        inv = invitations_collection.find_one({"accepted_by": user_id_str, "status": "accepted"})
        if inv and inv.get("team_id"):
            team_id = inv["team_id"]
        else:
            team_id = user_id_str
            # A user who registered on their own is the Admin of their own team
            user["role"] = "admin"
        user["team_id"] = team_id
        users_collection.update_one(
            {"_id": ObjectId(user_id_str)},
            {"$set": {"team_id": team_id, "role": user.get("role", "member")}}
        )

    return user
