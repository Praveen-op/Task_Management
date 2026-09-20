from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from bson import ObjectId
from ..database import comments_collection, issues_collection
from ..schemas import CommentCreate
from ..dependencies import current_user

router = APIRouter(prefix="/comments", tags=["Comments"])

@router.post("")
def create_comment(data: CommentCreate, user=Depends(current_user)):
    try:
        issue = issues_collection.find_one({"_id": ObjectId(data.issue_id)})
    except Exception:
        issue = None
    if not issue:
        raise HTTPException(404, "Issue not found")

    doc = {
        "issue_id": ObjectId(data.issue_id),
        "user_id": user["_id"],
        "body": data.body.strip(),
        "created_at": datetime.now(timezone.utc),
    }
    result = comments_collection.insert_one(doc)
    return {"id": str(result.inserted_id), "issue_id": data.issue_id, "user_id": user["_id"], "body": doc["body"]}

@router.get("/{issue_id}")
def list_comments(issue_id: str, user=Depends(current_user)):
    try:
        oid = ObjectId(issue_id)
    except Exception:
        raise HTTPException(400, "Invalid issue id")
    result = []
    for x in comments_collection.find({"issue_id": oid}).sort("created_at", 1):
        result.append({
            "id": str(x["_id"]),
            "issue_id": str(x["issue_id"]),
            "user_id": x["user_id"],
            "body": x["body"],
            "created_at": x["created_at"],
        })
    return result
