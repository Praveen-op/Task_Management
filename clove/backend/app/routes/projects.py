from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from bson import ObjectId
from ..database import projects_collection
from ..schemas import ProjectCreate
from ..dependencies import current_user

router = APIRouter(prefix="/projects", tags=["Projects"])


def serialize(p, user_id):
    return {
        "id": str(p["_id"]),
        "name": p["name"],
        "key": p["key"],
        "description": p.get("description", ""),
        "owner_id": p.get("owner_id"),
        "members": [str(m) for m in p.get("members", [])],
        "starred": user_id in p.get("starred_by", []),
    }


@router.post("")
def create_project(data: ProjectCreate, user=Depends(current_user)):
    key = data.key.upper()
    if projects_collection.find_one({"key": key}):
        raise HTTPException(409, "Project key already exists")
    doc = {
        "name": data.name.strip(),
        "key": key,
        "description": data.description,
        "owner_id": user["_id"],
        "members": [user["_id"]],
        "starred_by": [],
        "created_at": datetime.now(timezone.utc),
    }
    result = projects_collection.insert_one(doc)
    doc["_id"] = result.inserted_id
    return serialize(doc, user["_id"])


@router.get("")
def list_projects(user=Depends(current_user)):
    return [serialize(p, user["_id"]) for p in projects_collection.find().sort("created_at", -1)]


@router.get("/{project_id}")
def get_project(project_id: str, user=Depends(current_user)):
    try:
        p = projects_collection.find_one({"_id": ObjectId(project_id)})
    except Exception:
        p = None
    if not p:
        raise HTTPException(404, "Project not found")
    return serialize(p, user["_id"])


@router.post("/{project_id}/star")
def toggle_star(project_id: str, user=Depends(current_user)):
    try:
        oid = ObjectId(project_id)
    except Exception:
        raise HTTPException(400, "Invalid project id")
    p = projects_collection.find_one({"_id": oid})
    if not p:
        raise HTTPException(404, "Project not found")

    starred_by = p.get("starred_by", [])
    if user["_id"] in starred_by:
        projects_collection.update_one({"_id": oid}, {"$pull": {"starred_by": user["_id"]}})
        starred = False
    else:
        projects_collection.update_one({"_id": oid}, {"$addToSet": {"starred_by": user["_id"]}})
        starred = True

    return {"id": project_id, "starred": starred}
