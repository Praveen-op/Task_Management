from fastapi import APIRouter, HTTPException
from ..database import users_collection
from ..schemas import SignupRequest, LoginRequest
from ..security import hash_password, verify_password, create_access_token

router = APIRouter(prefix="/auth", tags=["Authentication"])

@router.post("/signup")
def signup(data: SignupRequest):
    if users_collection.find_one({"email": data.email.lower()}):
        raise HTTPException(409, "Email already registered")
    doc = {"name": data.name.strip(), "email": data.email.lower(), "password": hash_password(data.password), "role": "member"}
    result = users_collection.insert_one(doc)
    return {"message": "Signup successful", "user": {"id": str(result.inserted_id), "name": doc["name"], "email": doc["email"]}}

@router.post("/login")
def login(data: LoginRequest):
    user = users_collection.find_one({"email": data.email.lower()})
    if not user or not verify_password(data.password, user["password"]):
        raise HTTPException(401, "Invalid email or password")
    token = create_access_token(str(user["_id"]))
    return {"access_token": token, "token_type": "bearer", "user": {"id": str(user["_id"]), "name": user["name"], "email": user["email"], "role": user.get("role", "member")}}
