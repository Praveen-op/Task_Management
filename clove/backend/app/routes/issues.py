from datetime import datetime, timezone
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from pymongo import ReturnDocument

from ..database import issues_collection, notifications_collection, projects_collection, users_collection, worklogs_collection
from ..dependencies import current_user
from ..schemas import IssueCreate, IssueUpdate, WorklogCreate, DependencyCreate
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
    if not x:
        return None
    x = dict(x)
    if "_id" in x:
        x["id"] = str(x.pop("_id"))
    elif "id" in x:
        x["id"] = str(x["id"])
    else:
        x["id"] = ""
    x["project_id"] = str(x.get("project_id", ""))
    x.setdefault("due_date", None)
    x.setdefault("start_date", None)
    x.setdefault("estimation", None)
    x.setdefault("logged_hours", 0.0)
    x.setdefault("blocked_by", [])
    x.setdefault("blocks", [])
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

    # Check dependency blocking status & clean up references to deleted tasks
    blocked_by_ids = x.get("blocked_by", [])
    blocker_keys = []
    is_blocked = False
    valid_blocked_by = []
    if blocked_by_ids:
        try:
            b_oids = [ObjectId(bid) for bid in blocked_by_ids if ObjectId.is_valid(bid)]
            if b_oids:
                blockers = list(issues_collection.find({"_id": {"$in": b_oids}}, {"key": 1, "status": 1}))
                found_bids = set(str(b["_id"]) for b in blockers)
                valid_blocked_by = [bid for bid in blocked_by_ids if bid in found_bids]
                for b in blockers:
                    b_st = (b.get("status") or "").strip().lower()
                    if b_st != "done":
                        is_blocked = True
                        blocker_keys.append(b.get("key") or str(b["_id"]))
        except Exception:
            pass
    x["blocked_by"] = valid_blocked_by
    x["blocked_by_keys"] = blocker_keys
    x["is_blocked"] = is_blocked

    # Blocked tasks separately come under Hold status
    st_low = (x.get("status") or "").strip().lower()
    if is_blocked and st_low != "done" and st_low not in ["hold", "on hold"]:
        try:
            issues_collection.update_one({"_id": x["_id"]}, {"$set": {"status": "Hold"}})
            x["status"] = "Hold"
        except Exception:
            x["status"] = "Hold"

    # Clean up blocks references to deleted tasks
    blocks_ids = x.get("blocks", [])
    valid_blocks = []
    if blocks_ids:
        try:
            bk_oids = [ObjectId(bid) for bid in blocks_ids if ObjectId.is_valid(bid)]
            if bk_oids:
                existing_blocks = list(issues_collection.find({"_id": {"$in": bk_oids}}, {"_id": 1}))
                found_bk_ids = set(str(b["_id"]) for b in existing_blocks)
                valid_blocks = [bid for bid in blocks_ids if bid in found_bk_ids]
        except Exception:
            pass
    x["blocks"] = valid_blocks

    if "project_name" not in x:
        try:
            p_doc = projects_collection.find_one({"_id": ObjectId(x["project_id"])}, {"name": 1})
            x["project_name"] = p_doc.get("name", "") if p_doc else ""
        except Exception:
            x["project_name"] = ""

    x["issue_type"] = x.get("issue_type") or "Feature"
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

    # If the user has an issue assigned to them in this project
    u_match = [user_id] + ([ObjectId(user_id)] if ObjectId.is_valid(user_id) else [])
    if issues_collection.find_one({"project_id": p_oid, "assignee_id": {"$in": u_match}}):
        projects_collection.update_one({"_id": p_oid}, {"$addToSet": {"members": user_id}})
        return project

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Permission denied. You are not a member of this project.",
    )


def normalize_status(raw_status: str | None, project_id: str | None = None) -> str:
    if not raw_status:
        return "To Do"
    raw_clean = raw_status.strip()
    if raw_clean.lower() in STATUS_MAP:
        return STATUS_MAP[raw_clean.lower()]

    if project_id and ObjectId.is_valid(project_id):
        proj = projects_collection.find_one({"_id": ObjectId(project_id)})
        if proj and proj.get("statuses"):
            allowed_names = [s.get("name") for s in proj["statuses"] if isinstance(s, dict)]
            for name in allowed_names:
                if name.lower() == raw_clean.lower():
                    return name

    if len(raw_clean) >= 2 and len(raw_clean) <= 40:
        return raw_clean

    raise HTTPException(
        status_code=400,
        detail=f"Invalid task status '{raw_status}'.",
    )


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
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Only administrators have permission to create tasks.")

    project = check_project_permission(data.project_id, user, action="write")

    if not data.title or not data.title.strip():
        raise HTTPException(status_code=400, detail="Task Title is required.")
    if not data.description or not data.description.strip():
        raise HTTPException(status_code=400, detail="Description is required.")

    issue_type = "Bug" if (data.issue_type or "").strip().lower() == "bug" else "Feature"

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
        "issue_type": issue_type,
        "status": final_status,
        "priority": data.priority,
        "due_date": final_due_date,
        "start_date": data.start_date or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "estimation": final_estimation,
        "logged_hours": 0.0,
        "blocked_by": [],
        "blocks": [],
        "assignee_id": assignee_id,
        "reporter_id": user["_id"],
        "archived": False,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    result = issues_collection.insert_one(doc)
    doc["_id"] = result.inserted_id

    if assignee_id:
        projects_collection.update_one(
            {"_id": proj_oid},
            {"$addToSet": {"members": str(assignee_id)}}
        )
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
    user_id = str(user["_id"])
    user_oids = [ObjectId(user_id)] if ObjectId.is_valid(user_id) else []
    user_match_ids = [user_id] + user_oids

    # Auto-heal and sync all projects where user has assigned tasks
    assigned_proj_raw = issues_collection.distinct("project_id", {"assignee_id": {"$in": user_match_ids}})
    assigned_proj_oids = [ObjectId(pid) for pid in assigned_proj_raw if ObjectId.is_valid(str(pid))]
    assigned_proj_all = assigned_proj_oids + [str(pid) for pid in assigned_proj_raw if pid]
    if assigned_proj_all:
        projects_collection.update_many(
            {"_id": {"$in": assigned_proj_all}},
            {"$addToSet": {"members": user_id}}
        )

    if project_id:
        check_project_permission(project_id, user, action="read")
        try:
            query["project_id"] = ObjectId(project_id)
        except Exception:
            return []
    else:
        if user.get("role") != "admin":
            accessible_filter = {
                "$or": [
                    {"owner_id": {"$in": user_match_ids}},
                    {"members": {"$in": user_match_ids}},
                    {"members.user_id": {"$in": user_match_ids}},
                    {"_id": {"$in": assigned_proj_all}},
                ]
            }
            accessible_proj_ids = [p["_id"] for p in projects_collection.find(accessible_filter, {"_id": 1})]
            all_accessible_ids = list(set(accessible_proj_ids + assigned_proj_all))

            is_self_assignee = assignee_id and str(assignee_id) == user_id
            if not all_accessible_ids and not is_self_assignee:
                return []
            if all_accessible_ids and not is_self_assignee:
                query["project_id"] = {"$in": all_accessible_ids}

    if status:
        query["status"] = normalize_status(status)
    if priority:
        query["priority"] = priority
    if assignee_id:
        a_matches = [str(assignee_id)]
        if ObjectId.is_valid(str(assignee_id)):
            a_matches.append(ObjectId(str(assignee_id)))
        query["assignee_id"] = {"$in": a_matches}
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
    if "issue_type" in changes:
        raw_t = str(changes["issue_type"]).strip().lower()
        changes["issue_type"] = "Bug" if raw_t == "bug" else "Feature"
    if "start_date" in changes and changes["start_date"]:
        changes["start_date"] = str(changes["start_date"]).strip()[:10]

    if "status" in changes:
        target_status = normalize_status(changes["status"], project_id=project_id_str)
        changes["status"] = target_status
        if target_status.lower() == "done":
            blocked_by_ids = existing.get("blocked_by", [])
            if blocked_by_ids:
                b_oids = [ObjectId(bid) for bid in blocked_by_ids if ObjectId.is_valid(bid)]
                incomplete_blockers = list(issues_collection.find(
                    {"_id": {"$in": b_oids}, "status": {"$ne": "Done"}},
                    {"key": 1}
                ))
                if incomplete_blockers:
                    keys_str = ", ".join([b.get("key", "task") for b in incomplete_blockers])
                    raise HTTPException(
                        status_code=400,
                        detail=f"Cannot complete task: blocked by unresolved task(s): {keys_str}."
                    )

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
        projects_collection.update_one(
            {"_id": ObjectId(project_id_str)},
            {"$addToSet": {"members": str(changes["assignee_id"])}}
        )
        if changes["assignee_id"] != existing.get("assignee_id"):
            notify_assignee(issue_id, changes["assignee_id"], user["_id"], updated_issue["title"])

    serialized = serialize(updated_issue)

    # When a task is marked Done, unblock any tasks that were waiting on it and return them to In Progress
    if changes.get("status") == "Done":
        blocked_tasks = list(issues_collection.find({"project_id": existing["project_id"], "blocked_by": str(oid)}))
        for bt in blocked_tasks:
            other_blockers = [x for x in bt.get("blocked_by", []) if str(x) != str(oid)]
            has_other = False
            if other_blockers:
                try:
                    ob_oids = [ObjectId(x) for x in other_blockers if ObjectId.is_valid(x)]
                    if ob_oids:
                        has_other = bool(issues_collection.find_one({"_id": {"$in": ob_oids}, "status": {"$ne": "Done"}}))
                except Exception:
                    pass
            if not has_other:
                issues_collection.update_one({"_id": bt["_id"]}, {"$set": {"status": "In Progress"}})
                unblocked_doc = issues_collection.find_one({"_id": bt["_id"]})
                if unblocked_doc:
                    await ws_manager.broadcast_to_project(project_id_str, {"type": "issue_updated", "issue": serialize(unblocked_doc)})

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
    issues_collection.update_many({}, {"$pull": {"blocked_by": issue_id, "blocks": issue_id}})

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


# ================= Worklog / Time Tracking =================

@router.post("/{issue_id}/worklog")
async def add_worklog(issue_id: str, data: WorklogCreate, user=Depends(current_user)):
    try:
        oid = ObjectId(issue_id)
    except Exception:
        raise HTTPException(400, "Invalid issue id")

    existing = issues_collection.find_one({"_id": oid})
    if not existing:
        raise HTTPException(404, "Task not found")

    check_project_permission(str(existing["project_id"]), user, action="write")

    hours = round(float(data.hours), 2)
    if hours <= 0:
        raise HTTPException(400, "Hours logged must be greater than 0")

    work_date = data.date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    user_name = user.get("name", "Team member")
    user_id = str(user["_id"])

    worklog_doc = {
        "issue_id": oid,
        "project_id": existing["project_id"],
        "user_id": ObjectId(user_id),
        "user_name": user_name,
        "user_email": user.get("email", ""),
        "hours": hours,
        "date": work_date,
        "comment": (data.comment or "").strip(),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    res = worklogs_collection.insert_one(worklog_doc)
    worklog_doc["id"] = str(res.inserted_id)
    worklog_doc["_id"] = str(res.inserted_id)
    worklog_doc["issue_id"] = issue_id
    worklog_doc["project_id"] = str(existing["project_id"])
    worklog_doc["user_id"] = user_id

    current_logged = float(existing.get("logged_hours") or 0.0)
    new_logged = round(current_logged + hours, 2)
    issues_collection.update_one(
        {"_id": oid},
        {"$set": {"logged_hours": new_logged, "updated_at": datetime.now(timezone.utc)}}
    )

    updated_issue = issues_collection.find_one({"_id": oid})
    serialized = serialize(updated_issue)

    await ws_manager.broadcast_to_project(
        str(existing["project_id"]),
        {
            "type": "issue_updated",
            "issue": serialized,
            "actor_id": user_id,
            "actor_name": user_name,
        }
    )

    return worklog_doc


@router.get("/{issue_id}/worklog")
def get_worklogs(issue_id: str, user=Depends(current_user)):
    try:
        oid = ObjectId(issue_id)
    except Exception:
        raise HTTPException(400, "Invalid issue id")

    existing = issues_collection.find_one({"_id": oid})
    if not existing:
        raise HTTPException(404, "Task not found")

    check_project_permission(str(existing["project_id"]), user, action="read")

    logs = list(worklogs_collection.find({"issue_id": oid}).sort("created_at", -1))
    results = []
    for l in logs:
        results.append({
            "id": str(l["_id"]),
            "issue_id": issue_id,
            "user_id": str(l.get("user_id", "")),
            "user_name": l.get("user_name", "Team member"),
            "hours": l.get("hours", 0.0),
            "date": l.get("date", ""),
            "comment": l.get("comment", ""),
            "created_at": l.get("created_at", "")
        })
    return results


@router.delete("/{issue_id}/worklog/{worklog_id}")
async def delete_worklog(issue_id: str, worklog_id: str, user=Depends(current_user)):
    try:
        w_oid = ObjectId(worklog_id)
        i_oid = ObjectId(issue_id)
    except Exception:
        raise HTTPException(400, "Invalid ID")

    w_doc = worklogs_collection.find_one({"_id": w_oid, "issue_id": i_oid})
    if not w_doc:
        raise HTTPException(404, "Worklog not found")

    user_id = str(user["_id"])
    if str(w_doc.get("user_id")) != user_id and user.get("role") != "admin":
        raise HTTPException(403, "You can only delete your own logged work entries.")

    worklogs_collection.delete_one({"_id": w_oid})

    all_logs = list(worklogs_collection.find({"issue_id": i_oid}))
    total_hours = round(sum(float(l.get("hours", 0.0)) for l in all_logs), 2)

    issues_collection.update_one(
        {"_id": i_oid},
        {"$set": {"logged_hours": total_hours, "updated_at": datetime.now(timezone.utc)}}
    )

    updated_issue = issues_collection.find_one({"_id": i_oid})
    serialized = serialize(updated_issue)

    await ws_manager.broadcast_to_project(
        str(updated_issue["project_id"]),
        {
            "type": "issue_updated",
            "issue": serialized,
            "actor_id": user_id,
            "actor_name": user.get("name", "Team member"),
        }
    )

    return {"status": "deleted", "logged_hours": total_hours}


# ================= Task Dependencies =================

@router.post("/{issue_id}/dependencies")
async def add_dependency(issue_id: str, data: DependencyCreate, user=Depends(current_user)):
    try:
        i_oid = ObjectId(issue_id)
        t_oid = ObjectId(data.target_issue_id)
    except Exception:
        raise HTTPException(400, "Invalid issue ID format")

    if issue_id == data.target_issue_id:
        raise HTTPException(400, "A task cannot depend on itself.")

    issue = issues_collection.find_one({"_id": i_oid})
    target = issues_collection.find_one({"_id": t_oid})
    if not issue or not target:
        raise HTTPException(404, "Issue or target issue not found")

    if str(issue["project_id"]) != str(target["project_id"]):
        raise HTTPException(400, "Dependencies can only be linked between tasks in the same project.")

    check_project_permission(str(issue["project_id"]), user, action="write")

    dep_type = data.type
    if dep_type == "blocked_by":
        issues_collection.update_one({"_id": i_oid}, {"$addToSet": {"blocked_by": data.target_issue_id}})
        issues_collection.update_one({"_id": t_oid}, {"$addToSet": {"blocks": issue_id}})
        # Whenever blocked is linked -> show Hold status!
        if (target.get("status") or "").strip().lower() != "done":
            issues_collection.update_one({"_id": i_oid}, {"$set": {"status": "Hold"}})
    else:
        issues_collection.update_one({"_id": i_oid}, {"$addToSet": {"blocks": data.target_issue_id}})
        issues_collection.update_one({"_id": t_oid}, {"$addToSet": {"blocked_by": issue_id}})
        if (issue.get("status") or "").strip().lower() != "done":
            issues_collection.update_one({"_id": t_oid}, {"$set": {"status": "Hold"}})

    up1 = issues_collection.find_one({"_id": i_oid})
    up2 = issues_collection.find_one({"_id": t_oid})
    s_up1 = serialize(up1)
    s_up2 = serialize(up2) if up2 else None
    await ws_manager.broadcast_to_project(str(issue["project_id"]), {"type": "issue_updated", "issue": s_up1})
    if s_up2:
        await ws_manager.broadcast_to_project(str(issue["project_id"]), {"type": "issue_updated", "issue": s_up2})

    return {"status": "linked", "issue": s_up1, "target": s_up2}


@router.delete("/{issue_id}/dependencies/{target_issue_id}")
async def remove_dependency(issue_id: str, target_issue_id: str, user=Depends(current_user)):
    try:
        i_oid = ObjectId(issue_id)
        t_oid = ObjectId(target_issue_id)
    except Exception:
        raise HTTPException(400, "Invalid issue ID format")

    issue = issues_collection.find_one({"_id": i_oid})
    if not issue:
        raise HTTPException(404, "Issue not found")

    check_project_permission(str(issue["project_id"]), user, action="write")

    issues_collection.update_one({"_id": i_oid}, {"$pull": {"blocked_by": target_issue_id, "blocks": target_issue_id}})
    issues_collection.update_one({"_id": t_oid}, {"$pull": {"blocked_by": issue_id, "blocks": issue_id}})

    up1 = issues_collection.find_one({"_id": i_oid})
    up2 = issues_collection.find_one({"_id": t_oid})
    s_up1 = serialize(up1)

    # If remove the blocked -> automatically go to In Progress status!
    if not s_up1.get("is_blocked"):
        issues_collection.update_one({"_id": i_oid}, {"$set": {"status": "In Progress"}})
        up1 = issues_collection.find_one({"_id": i_oid})
        s_up1 = serialize(up1)

    s_up2 = serialize(up2) if up2 else None
    await ws_manager.broadcast_to_project(str(issue["project_id"]), {"type": "issue_updated", "issue": s_up1})
    if s_up2:
        await ws_manager.broadcast_to_project(str(issue["project_id"]), {"type": "issue_updated", "issue": s_up2})

    return {"status": "unlinked", "issue": s_up1}
