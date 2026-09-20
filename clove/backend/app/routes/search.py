import re
from bson import ObjectId
from fastapi import APIRouter, Depends
from ..database import projects_collection, issues_collection
from ..dependencies import current_user
from .projects import serialize as serialize_project, user_accessible_filter
from .issues import serialize as serialize_issue

router = APIRouter(prefix="/search", tags=["Search"])


@router.get("")
def search(q: str = "", user=Depends(current_user)):
    q = q.strip()
    if not q:
        return {"projects": [], "issues": []}

    pattern = re.compile(re.escape(q), re.IGNORECASE)
    user_id = str(user["_id"])
    access_filter = user_accessible_filter(user_id)

    proj_query = {
        "$and": [
            {"$or": [{"name": pattern}, {"key": pattern}]},
            access_filter
        ]
    }
    accessible_projects = list(projects_collection.find(proj_query).limit(10))
    projects = [serialize_project(p, user_id) for p in accessible_projects]

    accessible_proj_ids = [p["_id"] for p in projects_collection.find(access_filter, {"_id": 1})]
    if not accessible_proj_ids and user.get("role") != "admin":
        return {"projects": projects, "issues": []}

    issue_query = {
        "$and": [
            {"$or": [{"title": pattern}, {"key": pattern}]},
            {"project_id": {"$in": accessible_proj_ids}}
        ]
    }
    issues = [
        serialize_issue(i)
        for i in issues_collection.find(issue_query).limit(10)
    ]

    return {"projects": projects, "issues": issues}
