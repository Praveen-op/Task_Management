import re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from bson import ObjectId
from ..database import comments_collection, issues_collection, notifications_collection, users_collection
from ..schemas import CommentCreate
from ..dependencies import current_user
from ..websocket_manager import ws_manager

router = APIRouter(prefix="/comments", tags=["Comments"])


def serialize_comment(x):
    created = x.get("created_at")
    if isinstance(created, datetime):
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        created_str = created.isoformat()
    elif created:
        created_str = str(created)
        if not created_str.endswith("Z") and "+" not in created_str:
            created_str += "Z"
    else:
        created_str = datetime.now(timezone.utc).isoformat()

    return {
        "id": str(x["_id"]),
        "issue_id": str(x["issue_id"]),
        "user_id": x["user_id"],
        "body": x.get("body", ""),
        "created_at": created_str,
        "attachment": x.get("attachment")
    }


@router.post("")
async def create_comment(data: CommentCreate, user=Depends(current_user)):
    try:
        issue = issues_collection.find_one({"_id": ObjectId(data.issue_id)})
    except Exception:
        issue = None
    if not issue:
        raise HTTPException(404, "Issue not found")

    body = (data.body or "").strip()
    if not body and not data.attachment:
        raise HTTPException(400, "Comment cannot be empty")

    doc = {
        "issue_id": ObjectId(data.issue_id),
        "user_id": user["_id"],
        "body": body,
        "attachment": data.attachment if isinstance(data.attachment, dict) else None,
        "created_at": datetime.now(timezone.utc),
    }
    result = comments_collection.insert_one(doc)
    doc["_id"] = result.inserted_id

    serialized = serialize_comment(doc)

    # Detect mentions in comment body and send notifications
    if body:
        try:
            actor_name = user.get("name") or "A team member"
            issue_title = issue.get("title", "a task")
            all_users = list(users_collection.find({}))
            notified_ids = set()

            for u in all_users:
                u_id_str = str(u["_id"])
                if u_id_str == str(user["_id"]):
                    continue  # Do not notify self

                u_name = (u.get("name") or "").strip()
                u_email = (u.get("email") or "").strip()

                is_mentioned = False
                if u_name and re.search(rf"@\b{re.escape(u_name)}\b", body, re.IGNORECASE):
                    is_mentioned = True
                elif u_email:
                    handle = u_email.split("@")[0]
                    if handle and re.search(rf"@\b{re.escape(handle)}\b", body, re.IGNORECASE):
                        is_mentioned = True

                if is_mentioned and u_id_str not in notified_ids:
                    notified_ids.add(u_id_str)
                    snippet = body if len(body) <= 50 else f"{body[:47]}..."
                    notif_msg = f"{actor_name} mentioned you in \"{issue_title}\": \"{snippet}\""
                    notif_doc = {
                        "user_id": u_id_str,
                        "message": notif_msg,
                        "issue_id": str(issue["_id"]),
                        "read": False,
                        "created_at": datetime.now(timezone.utc),
                    }
                    notifications_collection.insert_one(notif_doc)

                    # Send realtime mention notification via WebSocket
                    if "project_id" in issue and issue["project_id"]:
                        try:
                            await ws_manager.broadcast_to_project(str(issue["project_id"]), {
                                "type": "user_mentioned",
                                "target_user_id": u_id_str,
                                "message": notif_msg,
                                "issue_id": str(issue["_id"])
                            })
                        except Exception:
                            pass
        except Exception as e:
            print(f"Error handling comment mentions: {e}")

    # Real-time WebSocket broadcast to project channel
    if "project_id" in issue and issue["project_id"]:
        try:
            await ws_manager.broadcast_to_project(str(issue["project_id"]), {
                "type": "comment_created",
                "issue_id": str(issue["_id"]),
                "comment": serialized
            })
        except Exception:
            pass

    return serialized


@router.get("/{issue_id}")
def list_comments(issue_id: str, user=Depends(current_user)):
    try:
        oid = ObjectId(issue_id)
    except Exception:
        raise HTTPException(400, "Invalid issue id")
    result = []
    for x in comments_collection.find({"issue_id": oid}).sort("created_at", -1):
        result.append(serialize_comment(x))
    return result
