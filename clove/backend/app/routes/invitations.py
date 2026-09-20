import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, status
from ..database import (
    invitations_collection,
    projects_collection,
    users_collection,
    notifications_collection,
)
from ..dependencies import current_user
from ..schemas import InvitationCreate

router = APIRouter(prefix="/invitations", tags=["Invitations"])

VALID_ROLES = {"member", "developer", "admin"}


def serialize_invitation(inv: dict) -> dict:
    return {
        "id": str(inv["_id"]),
        "token": inv["token"],
        "role": inv["role"],
        "team_id": inv.get("team_id"),
        "project_id": inv.get("project_id"),
        "created_by": inv.get("created_by"),
        "status": inv.get("status", "pending"),
        "created_at": inv["created_at"].isoformat() if isinstance(inv.get("created_at"), datetime) else str(inv.get("created_at")),
        "expires_at": inv["expires_at"].isoformat() if isinstance(inv.get("expires_at"), datetime) else str(inv.get("expires_at")),
        "accepted_by": inv.get("accepted_by"),
        "accepted_at": inv["accepted_at"].isoformat() if isinstance(inv.get("accepted_at"), datetime) else None,
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def create_invitation(data: InvitationCreate, user=Depends(current_user)):
    role = (data.role or "member").strip().lower()
    if role not in VALID_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role '{data.role}'. Must be one of: {', '.join(sorted(VALID_ROLES))}",
        )

    project = None
    if data.project_id:
        try:
            project = projects_collection.find_one({"_id": ObjectId(data.project_id)})
        except Exception:
            project = None
        if not project:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Project specified for invitation does not exist",
            )

    # Strict Permission Check: Only Admin users can invite new users
    user_role = (user.get("role") or "member").strip().lower()

    # If the workspace does not yet have any Admin, automatically bootstrap the current user as Admin
    if not users_collection.find_one({"role": "admin"}):
        users_collection.update_one({"_id": ObjectId(user["_id"])}, {"$set": {"role": "admin"}})
        user["role"] = "admin"
        user_role = "admin"

    if user_role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied. Only Admin users can invite new users.",
        )

    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=7)

    doc = {
        "token": token,
        "team_id": data.team_id or "default",
        "project_id": str(project["_id"]) if project else (data.project_id if data.project_id else None),
        "created_by": user["_id"],
        "role": role,
        "status": "pending",
        "created_at": now,
        "expires_at": expires_at,
        "accepted_by": None,
        "accepted_at": None,
    }

    result = invitations_collection.insert_one(doc)
    doc["_id"] = result.inserted_id
    return serialize_invitation(doc)


@router.get("/{token}")
def get_invitation(token: str):
    inv = invitations_collection.find_one({"token": token})
    if not inv:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invitation not found or invalid token",
        )

    # Check expiration
    now = datetime.now(timezone.utc)
    expires_at = inv.get("expires_at")
    if isinstance(expires_at, datetime):
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < now:
            if inv.get("status") == "pending":
                invitations_collection.update_one({"_id": inv["_id"]}, {"$set": {"status": "expired"}})
                inv["status"] = "expired"

    if inv.get("status") != "pending":
        status_detail = inv.get("status", "invalid")
        raise HTTPException(
            status_code=status.HTTP_410_GONE if status_detail in {"expired", "accepted", "revoked"} else status.HTTP_400_BAD_REQUEST,
            detail=f"This invitation is no longer active (Status: {status_detail}).",
        )

    # Resolve project and inviter names for UI display
    project = None
    if inv.get("project_id"):
        try:
            project = projects_collection.find_one({"_id": ObjectId(inv["project_id"])})
        except Exception:
            project = None

    inviter = None
    if inv.get("created_by"):
        try:
            inviter = users_collection.find_one({"_id": ObjectId(inv["created_by"])})
        except Exception:
            inviter = None

    return {
        "token": inv["token"],
        "role": inv["role"],
        "status": inv["status"],
        "team_name": "My Team",
        "project_id": str(project["_id"]) if project else None,
        "project_name": project.get("name") if project else None,
        "project_key": project.get("key") if project else None,
        "inviter_name": inviter.get("name") if inviter else "A team member",
        "expires_at": inv["expires_at"].isoformat() if isinstance(inv["expires_at"], datetime) else str(inv["expires_at"]),
    }


@router.post("/{token}/accept")
def accept_invitation(token: str, user=Depends(current_user)):
    inv = invitations_collection.find_one({"token": token})
    if not inv:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invitation not found or invalid token",
        )

    now = datetime.now(timezone.utc)
    expires_at = inv.get("expires_at")
    if isinstance(expires_at, datetime):
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < now:
            invitations_collection.update_one({"_id": inv["_id"]}, {"$set": {"status": "expired"}})
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail="This invitation has expired and can no longer be accepted.",
            )

    if inv.get("status") != "pending":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"This invitation has already been {inv.get('status')}.",
        )

    assigned_role = inv["role"]

    # Role updates: Update user role in users collection if invited as developer or admin, or if user is member
    user_id = user["_id"]
    current_role = user.get("role", "member")
    role_priority = {"member": 1, "developer": 2, "admin": 3}
    if role_priority.get(assigned_role, 1) >= role_priority.get(current_role, 1):
        users_collection.update_one(
            {"_id": ObjectId(user_id)},
            {"$set": {"role": assigned_role}},
        )

    # If associated with a project, ensure user is registered to the project members
    project_id = inv.get("project_id")
    if project_id:
        try:
            projects_collection.update_one(
                {"_id": ObjectId(project_id)},
                {
                    "$addToSet": {
                        "members": {
                            "user_id": user_id,
                            "role": assigned_role,
                            "joined_at": now,
                        }
                    }
                },
            )
        except Exception:
            pass

    # Mark invitation as accepted atomically
    invitations_collection.update_one(
        {"_id": inv["_id"]},
        {
            "$set": {
                "status": "accepted",
                "accepted_by": user_id,
                "accepted_at": now,
            }
        },
    )

    # Notify the inviter
    if inv.get("created_by"):
        try:
            notifications_collection.insert_one(
                {
                    "user_id": inv["created_by"],
                    "message": f"{user.get('name', 'A user')} accepted your invitation to join as {assigned_role.capitalize()}.",
                    "issue_id": None,
                    "read": False,
                    "created_at": now,
                }
            )
        except Exception:
            pass

    return {
        "message": "Invitation accepted successfully",
        "role": assigned_role,
        "project_id": project_id,
        "status": "accepted",
    }


@router.delete("/{token}")
def revoke_invitation(token: str, user=Depends(current_user)):
    inv = invitations_collection.find_one({"token": token})
    if not inv:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invitation not found",
        )

    user_role = user.get("role", "member")
    if inv.get("created_by") != user["_id"] and user_role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to revoke this invitation",
        )

    invitations_collection.update_one(
        {"_id": inv["_id"]},
        {"$set": {"status": "revoked"}},
    )
    return {"message": "Invitation revoked"}
