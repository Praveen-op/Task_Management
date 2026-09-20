from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from ..dependencies import current_user
from ..database import users_collection

router = APIRouter(prefix="/users", tags=["Users"])


class RoleUpdate(BaseModel):
    role: str


class ProfileUpdate(BaseModel):
    name: str = Field(min_length=2, max_length=80)


@router.get("")
def list_users(user=Depends(current_user)):
    return [
        {"id": str(x["_id"]), "name": x["name"], "email": x["email"], "role": x.get("role", "member")}
        for x in users_collection.find({}, {"password": 0})
    ]


@router.get("/me")
def get_me(user=Depends(current_user)):
    if not users_collection.find_one({"role": "admin"}):
        users_collection.update_one({"_id": ObjectId(user["_id"])}, {"$set": {"role": "admin"}})
        user["role"] = "admin"
    return {"id": user["_id"], "name": user["name"], "email": user["email"], "role": user.get("role", "member")}


@router.put("/me")
def update_me(data: ProfileUpdate, user=Depends(current_user)):
    users_collection.update_one({"_id": ObjectId(user["_id"])}, {"$set": {"name": data.name.strip()}})
    return {"id": user["_id"], "name": data.name.strip(), "email": user["email"], "role": user.get("role", "member")}


@router.put("/{user_id}/role")
def update_user_role(user_id: str, data: RoleUpdate, user=Depends(current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Only admins can change user roles")
    role = data.role.lower().strip()
    if role not in ["admin", "developer", "member"]:
        raise HTTPException(status_code=400, detail="Invalid role. Must be admin, developer, or member")
    
    target_oid = ObjectId(user_id) if ObjectId.is_valid(user_id) else None
    if not target_oid or not users_collection.find_one({"_id": target_oid}):
        raise HTTPException(status_code=404, detail="User not found")
        
    # Prevent removing the last admin
    if role != "admin" and str(user["_id"]) == user_id:
        admin_count = users_collection.count_documents({"role": "admin"})
        if admin_count <= 1:
            raise HTTPException(status_code=400, detail="Cannot change the role of the only workspace admin")
            
    users_collection.update_one({"_id": target_oid}, {"$set": {"role": role}})
    return {"status": "ok", "user_id": user_id, "role": role}

