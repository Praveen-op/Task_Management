import re
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException
from bson import ObjectId
from ..database import projects_collection, issues_collection, users_collection, worklogs_collection
from ..schemas import ProjectCreate, ProjectWorkflowUpdate, ProjectUpdate
from ..dependencies import current_user

router = APIRouter(prefix="/projects", tags=["Projects"])


def user_accessible_filter(user_id: str):
    user_oids = [ObjectId(user_id)] if ObjectId.is_valid(user_id) else []
    user_match_ids = [user_id] + user_oids

    # Include projects where user has assigned tasks
    assigned_proj_raw = issues_collection.distinct("project_id", {"assignee_id": {"$in": user_match_ids}})
    assigned_proj_oids = [ObjectId(pid) for pid in assigned_proj_raw if ObjectId.is_valid(str(pid))]
    assigned_proj_all = assigned_proj_oids + [str(pid) for pid in assigned_proj_raw if pid]

    # Auto-heal: ensure user is in project members
    if assigned_proj_all:
        projects_collection.update_many(
            {"_id": {"$in": assigned_proj_all}},
            {"$addToSet": {"members": user_id}}
        )

    return {
        "$or": [
            {"owner_id": {"$in": user_match_ids}},
            {"members": {"$in": user_match_ids}},
            {"members.user_id": {"$in": user_match_ids}},
            {"_id": {"$in": assigned_proj_all}},
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

    default_statuses = [
        {"name": "To Do", "color": "#6B7280", "category": "todo"},
        {"name": "In Progress", "color": "#3B82F6", "category": "inprogress"},
        {"name": "Hold", "color": "#F59E0B", "category": "hold"},
        {"name": "Done", "color": "#10B981", "category": "done"}
    ]

    raw_statuses = p.get("statuses") or default_statuses
    # Ensure Hold status is present in statuses
    has_hold = any((s.get("name") if isinstance(s, dict) else str(s)).strip().lower() in ["hold", "on hold"] for s in raw_statuses)
    if not has_hold:
        done_idx = next((i for i, s in enumerate(raw_statuses) if (s.get("name") if isinstance(s, dict) else str(s)).strip().lower() == "done"), -1)
        hold_dict = {"name": "Hold", "color": "#F59E0B", "category": "hold"}
        if done_idx != -1:
            raw_statuses.insert(done_idx, hold_dict)
        else:
            raw_statuses.append(hold_dict)

    return {
        "id": str(p["_id"]),
        "name": p["name"],
        "key": p["key"],
        "description": p.get("description", ""),
        "sprint_start_date": p.get("sprint_start_date", ""),
        "sprint_end_date": p.get("sprint_end_date", ""),
        "owner_id": str(p.get("owner_id", "")),
        "members": members_list,
        "starred": user_id in [str(x) for x in p.get("starred_by", [])],
        "completed": bool(p.get("completed", False)),
        "statuses": raw_statuses,
    }


@router.post("")
def create_project(data: ProjectCreate, user=Depends(current_user)):
    if user.get("role") != "admin":
        raise HTTPException(403, "Only administrators have permission to create projects.")

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
        "sprint_start_date": data.sprint_start_date or "",
        "sprint_end_date": data.sprint_end_date or "",
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
        user_match_ids = [user_id] + ([ObjectId(user_id)] if ObjectId.is_valid(user_id) else [])
        if issues_collection.find_one({"project_id": ObjectId(project_id), "assignee_id": {"$in": user_match_ids}}):
            projects_collection.update_one({"_id": ObjectId(project_id)}, {"$addToSet": {"members": user_id}})
        else:
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

@router.put("/{project_id}")
def update_project(project_id: str, data: ProjectUpdate, user=Depends(current_user)):
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
        raise HTTPException(403, "Access denied. Only project members or admin can edit project details.")

    update_fields = {}
    if data.name is not None:
        name = data.name.strip()
        if len(name) < 2:
            raise HTTPException(400, "Project name must be at least 2 characters long")
        update_fields["name"] = name
    if data.description is not None:
        update_fields["description"] = data.description
    if data.sprint_start_date is not None:
        update_fields["sprint_start_date"] = data.sprint_start_date
    if data.sprint_end_date is not None:
        update_fields["sprint_end_date"] = data.sprint_end_date

    if update_fields:
        update_fields["updated_at"] = datetime.now(timezone.utc)
        projects_collection.update_one({"_id": oid}, {"$set": update_fields})
        p = projects_collection.find_one({"_id": oid})

    return serialize(p, user_id)


@router.put("/{project_id}/statuses")
def update_project_workflow(project_id: str, data: ProjectWorkflowUpdate, user=Depends(current_user)):
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
        raise HTTPException(403, "Only the project owner or an admin can customize workflows.")

    cleaned_statuses = []
    has_done = False
    for s in data.statuses:
        name = str(s.get("name", "")).strip()
        if not name:
            continue
        color = str(s.get("color", "#3B82F6")).strip()
        cat = str(s.get("category", "todo")).strip().lower()
        if cat not in ("todo", "inprogress", "done"):
            cat = "inprogress"
        if cat == "done" or name.lower() == "done":
            has_done = True
        cleaned_statuses.append({
            "name": name,
            "color": color,
            "category": cat
        })

    if len(cleaned_statuses) < 2:
        raise HTTPException(400, "Workflow must contain at least 2 statuses.")
    if not has_done:
        cleaned_statuses.append({"name": "Done", "color": "#10B981", "category": "done"})

    projects_collection.update_one(
        {"_id": oid},
        {"$set": {"statuses": cleaned_statuses, "updated_at": datetime.now(timezone.utc)}}
    )

    return {"message": "Workflow updated successfully", "statuses": cleaned_statuses}


@router.get("/{project_id}/analytics")
def get_project_analytics(project_id: str, user=Depends(current_user)):
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

    all_issues = list(issues_collection.find({"project_id": oid}))
    total_tasks = len(all_issues)

    project_statuses = p.get("statuses") or [
        {"name": "To Do", "color": "#6B7280", "category": "todo"},
        {"name": "In Progress", "color": "#3B82F6", "category": "inprogress"},
        {"name": "Done", "color": "#10B981", "category": "done"}
    ]

    status_counts = {s["name"]: 0 for s in project_statuses}
    done_status_names = {s["name"].lower() for s in project_statuses if s.get("category") == "done" or s["name"].lower() == "done"}
    inprog_status_names = {s["name"].lower() for s in project_statuses if s.get("category") == "inprogress" or s["name"].lower() in ("in progress", "inprogress")}

    priority_counts = {"Highest": 0, "High": 0, "Medium": 0, "Low": 0, "Lowest": 0}
    overdue_tasks = []
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    total_estimated_days = 0.0
    total_logged_hours = 0.0
    user_task_map = {}

    all_member_ids = list(set([owner_id] + member_ids))
    for mid in all_member_ids:
        if ObjectId.is_valid(mid):
            u_doc = users_collection.find_one({"_id": ObjectId(mid)})
            if u_doc:
                user_task_map[mid] = {
                    "user_id": mid,
                    "name": u_doc.get("name", "Team member"),
                    "email": u_doc.get("email", ""),
                    "role": u_doc.get("role", "member"),
                    "total_assigned": 0,
                    "in_progress": 0,
                    "completed": 0,
                    "overdue": 0,
                    "estimated_days": 0.0,
                    "logged_hours": 0.0
                }

    for iss in all_issues:
        st = iss.get("status", "To Do")
        if st in status_counts:
            status_counts[st] += 1
        else:
            status_counts[st] = status_counts.get(st, 0) + 1

        prio = iss.get("priority", "Medium")
        if prio in priority_counts:
            priority_counts[prio] += 1
        elif prio == "Critical":
            priority_counts["Highest"] += 1

        est = iss.get("estimation") or 0.0
        try:
            est_float = float(est)
        except Exception:
            est_float = 0.0
        total_estimated_days += est_float

        logged = iss.get("logged_hours") or 0.0
        try:
            logged_float = float(logged)
        except Exception:
            logged_float = 0.0
        total_logged_hours += logged_float

        due = iss.get("due_date")
        is_done = st.lower() in done_status_names
        is_overdue = bool(due and str(due)[:10] < today_str and not is_done)

        if is_overdue:
            assignee_name = "Unassigned"
            if iss.get("assignee_id") and str(iss["assignee_id"]) in user_task_map:
                assignee_name = user_task_map[str(iss["assignee_id"])]["name"]
            overdue_tasks.append({
                "id": str(iss["_id"]),
                "key": iss.get("key", "ISS"),
                "title": iss.get("title", ""),
                "due_date": due,
                "priority": prio,
                "status": st,
                "assignee_name": assignee_name,
            })

        aid = str(iss.get("assignee_id") or "")
        if aid and aid in user_task_map:
            user_task_map[aid]["total_assigned"] += 1
            if is_done:
                user_task_map[aid]["completed"] += 1
            elif st.lower() in inprog_status_names:
                user_task_map[aid]["in_progress"] += 1
            if is_overdue:
                user_task_map[aid]["overdue"] += 1
            user_task_map[aid]["estimated_days"] += est_float
            user_task_map[aid]["logged_hours"] += logged_float

    done_count = sum(cnt for name, cnt in status_counts.items() if name.lower() in done_status_names)
    completion_pct = 100 if p.get("completed") else (round((done_count / total_tasks * 100)) if total_tasks > 0 else 0)

    overdue_pct = (len(overdue_tasks) / total_tasks * 100) if total_tasks > 0 else 0
    health_score = max(10, min(100, int(100 - (overdue_pct * 1.5) + (completion_pct * 0.2))))
    if len(overdue_tasks) == 0 and (total_tasks == 0 or completion_pct > 20):
        health_score = max(health_score, 85)

    if health_score >= 80:
        health_status = "Healthy"
    elif health_score >= 55:
        health_status = "At Risk"
    else:
        health_status = "Critical"

    total_estimated_hours = round(total_estimated_days * 8.0, 1)

    # Sprint dates & burndown calculation
    today_dt = datetime.now(timezone.utc).date()
    sprint_start_str = str(p.get("sprint_start_date") or "").strip()[:10]
    sprint_end_str = str(p.get("sprint_end_date") or "").strip()[:10]

    has_custom_sprint = False
    if sprint_start_str and sprint_end_str:
        try:
            start_dt = datetime.strptime(sprint_start_str, "%Y-%m-%d").date()
            end_dt = datetime.strptime(sprint_end_str, "%Y-%m-%d").date()
            if end_dt < start_dt:
                end_dt = start_dt + timedelta(days=7)
            has_custom_sprint = True
        except Exception:
            start_dt = today_dt - timedelta(days=7)
            end_dt = today_dt
    elif sprint_start_str:
        try:
            start_dt = datetime.strptime(sprint_start_str, "%Y-%m-%d").date()
            end_dt = start_dt + timedelta(days=14)
            has_custom_sprint = True
        except Exception:
            start_dt = today_dt - timedelta(days=7)
            end_dt = today_dt
    else:
        # Default rolling 7 days
        start_dt = today_dt - timedelta(days=7)
        end_dt = today_dt

    total_sprint_days = max(1, min(60, (end_dt - start_dt).days))

    # Pre-calculate done task dates for historical accuracy
    completed_task_dates = []
    for iss in all_issues:
        st = iss.get("status", "To Do")
        if st.lower() in done_status_names:
            c_at = iss.get("completed_at") or iss.get("updated_at")
            if c_at:
                try:
                    if hasattr(c_at, "date"):
                        completed_task_dates.append(c_at.date())
                    else:
                        completed_task_dates.append(datetime.fromisoformat(str(c_at)[:10]).date())
                except Exception:
                    completed_task_dates.append(today_dt)
            else:
                completed_task_dates.append(today_dt)

    burndown_points = []
    for d in range(total_sprint_days + 1):
        curr_dt = start_dt + timedelta(days=d)
        day_label = curr_dt.strftime("%b %d")

        # Ideal line burns down linearly from total_tasks to 0
        ideal = max(0.0, round(total_tasks * (1.0 - (d / total_sprint_days)), 1))

        # Actual line: only plot up to today (or if project is completed, all days)
        if curr_dt <= today_dt or p.get("completed"):
            if p.get("completed"):
                actual = 0
            else:
                if completed_task_dates:
                    tasks_done_after = sum(1 for cdate in completed_task_dates if cdate > curr_dt)
                    actual = max(0, (total_tasks - done_count) + tasks_done_after)
                else:
                    days_elapsed = max(0, (curr_dt - start_dt).days)
                    total_elapsed = max(1, (min(today_dt, end_dt) - start_dt).days)
                    ratio = min(1.0, days_elapsed / total_elapsed)
                    actual = max(0, total_tasks - int(done_count * ratio))
        else:
            # Future days
            actual = None

        burndown_points.append({
            "day": day_label,
            "date": curr_dt.strftime("%Y-%m-%d"),
            "ideal": ideal,
            "actual": actual
        })

    return {
        "project_id": project_id,
        "project_name": p.get("name"),
        "project_key": p.get("key"),
        "completed": bool(p.get("completed")),
        "sprint_start_date": sprint_start_str or start_dt.strftime("%Y-%m-%d"),
        "sprint_end_date": sprint_end_str or end_dt.strftime("%Y-%m-%d"),
        "sprint_duration_days": total_sprint_days,
        "has_custom_sprint": has_custom_sprint,
        "health_score": health_score,
        "health_status": health_status,
        "summary": {
            "total_tasks": total_tasks,
            "completed_tasks": done_count,
            "in_progress_tasks": sum(cnt for name, cnt in status_counts.items() if name.lower() in inprog_status_names),
            "todo_tasks": max(0, total_tasks - done_count - sum(cnt for name, cnt in status_counts.items() if name.lower() in inprog_status_names)),
            "overdue_count": len(overdue_tasks),
            "completion_percentage": completion_pct,
        },
        "time_tracking": {
            "total_estimated_days": round(total_estimated_days, 1),
            "total_estimated_hours": total_estimated_hours,
            "total_logged_hours": round(total_logged_hours, 1),
            "remaining_hours": max(0.0, round(total_estimated_hours - total_logged_hours, 1)),
            "progress_percentage": round((total_logged_hours / total_estimated_hours * 100)) if total_estimated_hours > 0 else 0
        },
        "status_distribution": [
            {
                "name": s["name"],
                "color": s.get("color", "#3B82F6"),
                "category": s.get("category", "todo"),
                "count": status_counts.get(s["name"], 0),
                "percentage": round(status_counts.get(s["name"], 0) / total_tasks * 100) if total_tasks > 0 else 0
            }
            for s in project_statuses
        ],
        "priority_distribution": [
            {"priority": k, "count": v, "color": {"Highest": "#EF4444", "High": "#F97316", "Medium": "#EAB308", "Low": "#3B82F6", "Lowest": "#9CA3AF"}.get(k, "#6B7280")}
            for k, v in priority_counts.items()
        ],
        "team_workload": list(user_task_map.values()),
        "overdue_tasks": overdue_tasks[:10],
        "burndown": burndown_points
    }
