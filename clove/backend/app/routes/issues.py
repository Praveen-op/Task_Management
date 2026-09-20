from datetime import datetime, timezone
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from pymongo import ReturnDocument

from ..database import issues_collection, notifications_collection, projects_collection, users_collection
from ..dependencies import current_user
from ..schemas import IssueCreate, IssueUpdate
from ..websocket_manager import ws_manager

router = APIRouter(prefix="/issues", tags=["Issues"])

VALID_STATUSES = {"To Do", "In Progress", "Done"}
STATUS_MAP = {
    "to do": "To Do",
    "todo": "To Do",
    "in progress": "In Progress",
    "inprogress": "In Progress",
    "done": "Done",
}


class StatusUpdate(BaseModel):
    status: str


def serialize(x):
    x["id"] = str(x.pop("_id"))
    x["project_id"] = str(x["project_id"])
    x.setdefault("due_date", None)
    x.setdefault("estimation", None)
    x.setdefault("archived", False)
    if "reporter_id" in x:
        x["reporter_id"] = str(x["reporter_id"])
    if x.get("assignee_id"):
        x["assignee_id"] = str(x["assignee_id"])

    # Ensure sequential number and issue key (e.g. PROJECTKEY-1, PROJECTKEY-2)
    if "number" not in x or not x.get("key"):
        try:
            proj = projects_collection.find_one({"_id": ObjectId(x["project_id"])})
            proj_key = (proj.get("key") if proj else None) or "ISS"
            q = {"project_id": ObjectId(x["project_id"])}
            if "created_at" in x and x["created_at"]:
                q["created_at"] = {"$lte": x["created_at"]}
            else:
                q["_id"] = {"$lte": ObjectId(x["id"])}
            cnt = issues_collection.count_documents(q)
            num = cnt if cnt > 0 else 1
            x["number"] = num
            x["key"] = f"{proj_key}-{num}"
            issues_collection.update_one(
                {"_id": ObjectId(x["id"])},
                {"$set": {"number": num, "key": x["key"]}}
            )
        except Exception:
            x.setdefault("number", 1)
            x.setdefault("key", f"ISS-{x.get('number', 1)}")

    return x


def notify_assignee(issue_id: str, assignee_id: str, actor_id: str, title: str):
    if not assignee_id or assignee_id == actor_id:
        return
    try:
        actor = users_collection.find_one({"_id": ObjectId(actor_id)})
        actor_name = actor.get("name", "A team member") if actor else "A team member"
        notifications_collection.insert_one({
            "user_id": assignee_id,
            "message": f"{actor_name} assigned you to \"{title}\"",
            "issue_id": issue_id,
            "read": False,
            "created_at": datetime.now(timezone.utc),
        })
    except Exception as e:
        print(f"Error creating notification: {e}")


def check_project_permission(project_id: str, user: dict, action: str = "write"):
    """
    Validates that the user has permission to view/modify issues in the project.
    - Admin: unrestricted access to all projects
    - Project Owner: unrestricted access to own project
    - Project Member: access to project they belong to
    """
    try:
        p_oid = ObjectId(project_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid project id")

    project = projects_collection.find_one({"_id": p_oid})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    user_role = (user.get("role") or "member").strip().lower()
    user_id = str(user["_id"])

    # Admins have full access across the workspace
    if user_role == "admin":
        return project

    # Project owner has full access
    if str(project.get("owner_id", "")) == user_id:
        return project

    # If the user is in project's members list
    raw_members = project.get("members", [])
    member_ids = [str(m.get("user_id") if isinstance(m, dict) else m) for m in raw_members]
    if user_id in member_ids:
        return project

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Permission denied. You are not a member of this project.",
    )


def normalize_status(raw_status: str | None) -> str:
    if not raw_status:
        return "To Do"
    normalized = STATUS_MAP.get(raw_status.strip().lower())
    if not normalized:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid task status '{raw_status}'. Must be one of: 'To Do', 'In Progress', 'Done'",
        )
    return normalized


VALID_PRIORITIES = {"Lowest", "Low", "Medium", "High", "Highest", "Critical"}


def validate_due_date(due_date_str: str | None) -> str:
    if not due_date_str or not str(due_date_str).strip():
        raise HTTPException(status_code=400, detail="Due Date is required.")
    cleaned = str(due_date_str).strip()[:10]
    try:
        parsed_date = datetime.strptime(cleaned, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid Due Date format. Expected YYYY-MM-DD.")

    # Check that due date is today or an upcoming date.
    # Take min of server local and UTC date to accommodate timezone differences.
    today_cutoff = min(datetime.now().date(), datetime.now(timezone.utc).date())
    if parsed_date < today_cutoff:
        raise HTTPException(status_code=400, detail="Due Date must be today or an upcoming date.")
    return parsed_date.strftime("%Y-%m-%d")


def validate_estimation(est) -> int:
    if est is None or est == "":
        raise HTTPException(status_code=400, detail="Estimation (Days) is required.")
    try:
        val = float(est)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Estimation (Days) must be a positive whole number.")
    if val <= 0:
        raise HTTPException(status_code=400, detail="Estimation (Days) must be a positive whole number of days.")
    return int(round(val))


@router.post("")
async def create_issue(data: IssueCreate, user=Depends(current_user)):
    project = check_project_permission(data.project_id, user, action="write")

    if not data.title or not data.title.strip():
        raise HTTPException(status_code=400, detail="Task Title is required.")
    if not data.description or not data.description.strip():
        raise HTTPException(status_code=400, detail="Description is required.")

    final_status = normalize_status(data.status)

    if not data.priority or data.priority not in VALID_PRIORITIES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid priority '{data.priority}'. Must be Lowest, Low, Medium, High, Highest, or Critical.",
        )

    final_due_date = validate_due_date(data.due_date)
    final_estimation = validate_estimation(data.estimation)

    # Validate assignee if provided
    assignee_id = data.assignee_id
    if assignee_id:
        try:
            assigned_user = users_collection.find_one({"_id": ObjectId(assignee_id)})
            if not assigned_user:
                raise HTTPException(status_code=400, detail="Assignee user not found")
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid assignee id")
    proj_oid = ObjectId(data.project_id)
    proj = projects_collection.find_one_and_update(
        {"_id": proj_oid},
        {"$inc": {"issue_counter": 1}},
        return_document=ReturnDocument.AFTER
    )
    if not proj or "issue_counter" not in proj:
        current_count = issues_collection.count_documents({"project_id": proj_oid})
        next_number = current_count + 1
        projects_collection.update_one(
            {"_id": proj_oid},
            {"$set": {"issue_counter": next_number}}
        )
        proj = projects_collection.find_one({"_id": proj_oid})
        issue_number = next_number
    else:
        issue_number = proj["issue_counter"]

    proj_key = (proj.get("key") if proj else None) or "ISS"
    issue_key_str = f"{proj_key}-{issue_number}"

    doc = {
        "project_id": proj_oid,
        "number": issue_number,
        "key": issue_key_str,
        "title": data.title.strip(),
        "description": data.description.strip(),
        "status": final_status,
        "priority": data.priority,
        "due_date": final_due_date,
        "estimation": final_estimation,
        "assignee_id": assignee_id,
        "reporter_id": user["_id"],
        "archived": False,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    result = issues_collection.insert_one(doc)
    doc["_id"] = result.inserted_id

    if assignee_id:
        notify_assignee(str(result.inserted_id), assignee_id, user["_id"], doc["title"])

    serialized = serialize(doc)

    # Broadcast real-time event to all connected team members
    await ws_manager.broadcast_to_project(
        str(data.project_id),
        {
            "type": "issue_created",
            "issue": serialized,
            "actor_id": user["_id"],
            "actor_name": user.get("name", "Team member"),
        },
    )

    return serialized


@router.get("")
def list_issues(
    project_id: str | None = None,
    status: str | None = None,
    priority: str | None = None,
    assignee_id: str | None = None,
    include_archived: bool = False,
    user=Depends(current_user),
):
    query = {}
    if project_id:
        check_project_permission(project_id, user, action="read")
        try:
            query["project_id"] = ObjectId(project_id)
        except Exception:
            return []
    else:
        user_id = str(user["_id"])
        user_oids = [ObjectId(user_id)] if ObjectId.is_valid(user_id) else []
        user_match_ids = [user_id] + user_oids
        accessible_filter = {
            "$or": [
                {"owner_id": {"$in": user_match_ids}},
                {"members": {"$in": user_match_ids}},
                {"members.user_id": {"$in": user_match_ids}},
            ]
        }
        accessible_proj_ids = [p["_id"] for p in projects_collection.find(accessible_filter, {"_id": 1})]
        if not accessible_proj_ids and user.get("role") != "admin":
            return []
        if user.get("role") != "admin":
            query["project_id"] = {"$in": accessible_proj_ids}

    if status:
        query["status"] = normalize_status(status)
    if priority:
        query["priority"] = priority
    if assignee_id:
        query["assignee_id"] = assignee_id
    if not include_archived:
        query["archived"] = {"$ne": True}

    return [serialize(x) for x in issues_collection.find(query).sort("created_at", -1)]


@router.get("/{issue_id}")
def get_issue(issue_id: str, user=Depends(current_user)):
    try:
        oid = ObjectId(issue_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid issue id")

    existing = issues_collection.find_one({"_id": oid})
    if not existing:
        raise HTTPException(status_code=404, detail="Issue not found")

    check_project_permission(str(existing["project_id"]), user, action="read")
    return serialize(existing)


@router.put("/{issue_id}")
async def update_issue(issue_id: str, data: IssueUpdate, user=Depends(current_user)):
    try:
        oid = ObjectId(issue_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid issue id")

    existing = issues_collection.find_one({"_id": oid})
    if not existing:
        raise HTTPException(status_code=404, detail="Issue not found")

    project_id_str = str(existing["project_id"])
    check_project_permission(project_id_str, user, action="write")

    changes = data.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(status_code=400, detail="No changes supplied")

    # If this is a task edit from the modal (indicated by title being passed),
    # enforce all required fields: title, description, status, priority, due_date, estimation
    if "title" in changes:
        if not str(changes["title"]).strip():
            raise HTTPException(status_code=400, detail="Task Title is required.")
        changes["title"] = str(changes["title"]).strip()

        if "description" not in changes or not str(changes["description"]).strip():
            raise HTTPException(status_code=400, detail="Description is required.")
        if "due_date" not in changes or not str(changes["due_date"]).strip():
            raise HTTPException(status_code=400, detail="Due Date is required.")
        if "estimation" not in changes or changes["estimation"] is None:
            raise HTTPException(status_code=400, detail="Estimation (Days) is required.")

    # Validate individual fields if present
    if "title" in changes and not str(changes["title"]).strip():
        raise HTTPException(status_code=400, detail="Task Title cannot be empty.")

    if "description" in changes:
        if not str(changes["description"]).strip():
            raise HTTPException(status_code=400, detail="Description cannot be empty.")
        changes["description"] = str(changes["description"]).strip()

    if "status" in changes:
        changes["status"] = normalize_status(changes["status"])

    if "priority" in changes:
        if changes["priority"] not in VALID_PRIORITIES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid priority '{changes['priority']}'. Must be Lowest, Low, Medium, High, Highest, or Critical.",
            )

    if "due_date" in changes:
        changes["due_date"] = validate_due_date(changes["due_date"])

    if "estimation" in changes:
        changes["estimation"] = validate_estimation(changes["estimation"])

    # Validate assignee
    if "assignee_id" in changes:
        new_assignee = changes["assignee_id"]
        if new_assignee:
            try:
                assigned_user = users_collection.find_one({"_id": ObjectId(new_assignee)})
                if not assigned_user:
                    raise HTTPException(status_code=400, detail="Assignee user not found")
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid assignee id")
        else:
            changes["assignee_id"] = None

    changes["updated_at"] = datetime.now(timezone.utc)

    issues_collection.update_one({"_id": oid}, {"$set": changes})
    updated_issue = issues_collection.find_one({"_id": oid})

    # Notify new assignee if changed
    if "assignee_id" in changes and changes["assignee_id"]:
        if changes["assignee_id"] != existing.get("assignee_id"):
            notify_assignee(issue_id, changes["assignee_id"], user["_id"], updated_issue["title"])

    serialized = serialize(updated_issue)

    # Real-time WebSocket Broadcast to all connected team members
    await ws_manager.broadcast_to_project(
        project_id_str,
        {
            "type": "issue_updated",
            "issue": serialized,
            "actor_id": user["_id"],
            "actor_name": user.get("name", "Team member"),
        },
    )

    return serialized


@router.patch("/{issue_id}/status")
async def update_issue_status(issue_id: str, data: StatusUpdate, user=Depends(current_user)):
    """
    Dedicated lightweight status update endpoint for fast Kanban transitions.
    """
    return await update_issue(issue_id, IssueUpdate(status=data.status), user)


@router.delete("/{issue_id}")
async def delete_issue(issue_id: str, user=Depends(current_user)):
    try:
        oid = ObjectId(issue_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid issue id")

    existing = issues_collection.find_one({"_id": oid})
    if not existing:
        raise HTTPException(status_code=404, detail="Issue not found")

    project_id_str = str(existing["project_id"])
    project = check_project_permission(project_id_str, user, action="write")

    user_role = (user.get("role") or "member").strip().lower()
    is_owner = str(project.get("owner_id")) == user["_id"]
    is_reporter = str(existing.get("reporter_id")) == user["_id"]

    if user_role != "admin" and not is_owner and not is_reporter:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied. Only Admins, project owners, or the task reporter can delete this task.",
        )

    issues_collection.delete_one({"_id": oid})

    await ws_manager.broadcast_to_project(
        project_id_str,
        {
            "type": "issue_deleted",
            "issue_id": issue_id,
            "project_id": project_id_str,
            "actor_id": user["_id"],
            "actor_name": user.get("name", "Team member"),
        },
    )

    return {"message": "Issue deleted"}


@router.post("/complete-sprint")
async def complete_sprint(project_id: str, user=Depends(current_user)):
    check_project_permission(project_id, user, action="write")
    try:
        oid = ObjectId(project_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid project id")

    proj = projects_collection.find_one({"_id": oid})
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    is_currently_completed = bool(proj.get("completed", False))
    new_completed_state = not is_currently_completed

    if new_completed_state:
        result = issues_collection.update_many(
            {"project_id": oid, "status": "Done", "archived": {"$ne": True}},
            {"$set": {"archived": True, "updated_at": datetime.now(timezone.utc)}},
        )
        archived_count = result.modified_count
    else:
        archived_count = 0

    projects_collection.update_one(
        {"_id": oid},
        {"$set": {
            "completed": new_completed_state,
            "completed_at": datetime.now(timezone.utc) if new_completed_state else None,
            "updated_at": datetime.now(timezone.utc),
        }}
    )

    await ws_manager.broadcast_to_project(
        project_id,
        {
            "type": "sprint_completed",
            "project_id": project_id,
            "archived_count": archived_count,
            "completed": new_completed_state,
            "actor_id": user["_id"],
        },
    )

    return {
        "message": "Sprint completed" if new_completed_state else "Sprint reopened",
        "archived_count": archived_count,
        "completed": new_completed_state,
    }
