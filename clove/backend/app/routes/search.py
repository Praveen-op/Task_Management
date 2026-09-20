import re
from fastapi import APIRouter, Depends
from ..database import projects_collection, issues_collection
from ..dependencies import current_user
from .projects import serialize as serialize_project
from .issues import serialize as serialize_issue

router = APIRouter(prefix="/search", tags=["Search"])


@router.get("")
def search(q: str = "", user=Depends(current_user)):
    q = q.strip()
    if not q:
        return {"projects": [], "issues": []}

    pattern = re.compile(re.escape(q), re.IGNORECASE)

    projects = [
        serialize_project(p, user["_id"])
        for p in projects_collection.find(
            {"$or": [{"name": pattern}, {"key": pattern}]}
        ).limit(10)
    ]
    issues = [
        serialize_issue(i)
        for i in issues_collection.find({"title": pattern}).limit(10)
    ]

    return {"projects": projects, "issues": issues}
