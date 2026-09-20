import re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from bson import ObjectId
from ..database import projects_collection, issues_collection
from ..schemas import ProjectCreate
from ..dependencies import current_user

router = APIRouter(prefix="/projects", tags=["Projects"])


def user_accessible_filter(user_id: str):
    user_oids = [ObjectId(user_id)] if ObjectId.is_valid(user_id) else []
    user_match_ids = [user_id] + user_oids
    return {
        "$or": [
            {"owner_id": {"$in": user_match_ids}},
            {"members": {"$in": user_match_ids}},
            {"members.user_id": {"$in": user_match_ids}},
        ]
    }


def serialize(p, user_id):
    raw_members = p.get("members", [])
    members_list = []
    for m in raw_members:
        if isinstance(m, dict):
            members_list.append(str(m.get("user_id", "")))
        else:
            members_list.append(str(m))

    return {
        "id": str(p["_id"]),
        "name": p["name"],
        "key": p["key"],
        "description": p.get("description", ""),
        "owner_id": str(p.get("owner_id", "")),
        "members": members_list,
        "starred": user_id in [str(x) for x in p.get("starred_by", [])],
        "completed": bool(p.get("completed", False)),
    }


@router.post("")
def create_project(data: ProjectCreate, user=Depends(current_user)):
    name = data.name.strip()
    key = data.key.strip().upper()
    user_id = str(user["_id"])

    if not name or len(name) < 2:
        raise HTTPException(400, "Project name must be at least 2 characters long")
    if not key or len(key) < 2:
        raise HTTPException(400, "Project key must be at least 2 characters long")

    # Enforce unique project name among user's accessible projects
    existing_name = projects_collection.find_one({
        "$and": [
            {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}},
            user_accessible_filter(user_id)
        ]
    })
    if existing_name:
        raise HTTPException(409, f"A project named '{name}' already exists. Project names must be unique.")

    # Enforce unique project key among user's accessible projects
    existing_key = projects_collection.find_one({
        "$and": [
            {"key": {"$regex": f"^{re.escape(key)}$", "$options": "i"}},
            user_accessible_filter(user_id)
        ]
    })
    if existing_key:
        raise HTTPException(409, f"Project key '{key}' already exists. Project keys must be unique.")

    doc = {
        "name": name,
        "key": key,
        "description": data.description or "",
        "owner_id": user_id,
        "members": [user_id],
        "starred_by": [],
        "issue_counter": 0,
        "created_at": datetime.now(timezone.utc),
    }
    result = projects_collection.insert_one(doc)
    doc["_id"] = result.inserted_id
    return serialize(doc, user_id)


@router.get("")
def list_projects(user=Depends(current_user)):
    user_id = str(user["_id"])
    query = user_accessible_filter(user_id)
    return [serialize(p, user_id) for p in projects_collection.find(query).sort("created_at", -1)]


@router.get("/{project_id}")
def get_project(project_id: str, user=Depends(current_user)):
    try:
        p = projects_collection.find_one({"_id": ObjectId(project_id)})
    except Exception:
        p = None
    if not p:
        raise HTTPException(404, "Project not found")

    user_id = str(user["_id"])
    owner_id = str(p.get("owner_id", ""))
    raw_members = p.get("members", [])
    member_ids = [str(m.get("user_id") if isinstance(m, dict) else m) for m in raw_members]

    if user_id != owner_id and user_id not in member_ids and user.get("role") != "admin":
        raise HTTPException(403, "Access denied. You are not a member of this project.")

    return serialize(p, user_id)


@router.post("/{project_id}/star")
def toggle_star(project_id: str, user=Depends(current_user)):
    try:
        oid = ObjectId(project_id)
    except Exception:
        raise HTTPException(400, "Invalid project id")
    p = projects_collection.find_one({"_id": oid})
    if not p:
        raise HTTPException(404, "Project not found")

    user_id = str(user["_id"])
    owner_id = str(p.get("owner_id", ""))
    raw_members = p.get("members", [])
    member_ids = [str(m.get("user_id") if isinstance(m, dict) else m) for m in raw_members]

    if user_id != owner_id and user_id not in member_ids and user.get("role") != "admin":
        raise HTTPException(403, "Access denied. You are not a member of this project.")

    starred_by = [str(x) for x in p.get("starred_by", [])]
    if user_id in starred_by:
        projects_collection.update_one({"_id": oid}, {"$pull": {"starred_by": user_id}})
        starred = False
    else:
        projects_collection.update_one({"_id": oid}, {"$addToSet": {"starred_by": user_id}})
        starred = True

    return {"id": project_id, "starred": starred}


@router.delete("/{project_id}")
def delete_project(project_id: str, user=Depends(current_user)):
    try:
        oid = ObjectId(project_id)
    except Exception:
        raise HTTPException(400, "Invalid project id")

    p = projects_collection.find_one({"_id": oid})
    if not p:
        raise HTTPException(404, "Project not found")

    user_id = str(user["_id"])
    owner_id = str(p.get("owner_id", ""))

    if user_id != owner_id and user.get("role") != "admin":
        raise HTTPException(403, "Only the project owner can delete this project.")

    # Delete all associated issues
    issues_collection.delete_many({"project_id": oid})
    # Delete the project
    projects_collection.delete_one({"_id": oid})

    return {"message": "Project deleted successfully", "id": project_id}
