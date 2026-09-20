from fastapi import APIRouter, HTTPException
from bson import ObjectId
from ..database import users_collection, invitations_collection
from ..schemas import SignupRequest, LoginRequest
from ..security import hash_password, verify_password, create_access_token

router = APIRouter(prefix="/auth", tags=["Authentication"])

@router.post("/signup")
def signup(data: SignupRequest):
    email = data.email.lower().strip()
    if users_collection.find_one({"email": email}):
        raise HTTPException(409, "Email already registered")

    # Direct signup creates an independent workspace/team where this user is the Admin
    doc = {
        "name": data.name.strip(),
        "email": email,
        "password": hash_password(data.password),
        "role": "admin",
    }
    result = users_collection.insert_one(doc)
    user_id = str(result.inserted_id)
    users_collection.update_one({"_id": result.inserted_id}, {"$set": {"team_id": user_id}})
    doc["team_id"] = user_id

    return {
        "message": "Signup successful",
        "user": {
            "id": user_id,
            "name": doc["name"],
            "email": doc["email"],
            "role": "admin",
            "team_id": user_id,
        },
    }

@router.post("/login")
def login(data: LoginRequest):
    user = users_collection.find_one({"email": data.email.lower().strip()})
    if not user or not verify_password(data.password, user["password"]):
        raise HTTPException(401, "Invalid email or password")

    user_id = str(user["_id"])
    team_id = user.get("team_id")
    role = user.get("role", "member")

    if not team_id:
        inv = invitations_collection.find_one({"accepted_by": user_id, "status": "accepted"})
        if inv and inv.get("team_id"):
            team_id = inv["team_id"]
        else:
            team_id = user_id
            role = "admin"
        users_collection.update_one({"_id": user["_id"]}, {"$set": {"team_id": team_id, "role": role}})
        user["team_id"] = team_id
        user["role"] = role

    token = create_access_token(user_id)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user_id,
            "name": user["name"],
            "email": user["email"],
            "role": user.get("role", "admin"),
            "team_id": team_id,
        },
    }
