from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr

from ..database import invites_collection
from ..dependencies import current_user
from ..email_service import send_invite_email

router = APIRouter(prefix="/invites", tags=["Invites"])


class InviteCreate(BaseModel):
    email: EmailStr


@router.post("")
def create_invite(data: InviteCreate, user=Depends(current_user)):
    try:
        send_invite_email(data.email, user["name"])
    except RuntimeError as e:
        # Email isn't configured yet (missing SMTP credentials).
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        # SMTP auth failure, network issue, etc.
        raise HTTPException(status_code=502, detail=f"Could not send email: {e}")

    invites_collection.insert_one({
        "email": data.email,
        "invited_by": user["_id"],
        "invited_by_name": user["name"],
        "created_at": datetime.now(timezone.utc),
    })
    return {"message": f"Invite sent to {data.email}"}


@router.get("")
def list_invites(user=Depends(current_user)):
    return [
        {
            "email": i["email"],
            "invited_by_name": i.get("invited_by_name", ""),
            "created_at": i["created_at"].isoformat(),
        }
        for i in invites_collection.find().sort("created_at", -1)
    ]
