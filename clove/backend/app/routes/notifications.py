from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from ..database import notifications_collection
from ..dependencies import current_user

router = APIRouter(prefix="/notifications", tags=["Notifications"])


def serialize(n):
    n["id"] = str(n.pop("_id"))
    return n


@router.get("")
def list_notifications(user=Depends(current_user)):
    cursor = notifications_collection.find({"user_id": user["_id"]}).sort("created_at", -1).limit(50)
    return [serialize(n) for n in cursor]


@router.post("/{notification_id}/read")
def mark_read(notification_id: str, user=Depends(current_user)):
    try:
        oid = ObjectId(notification_id)
    except Exception:
        raise HTTPException(400, "Invalid notification id")
    result = notifications_collection.update_one(
        {"_id": oid, "user_id": user["_id"]}, {"$set": {"read": True}}
    )
    if not result.matched_count:
        raise HTTPException(404, "Notification not found")
    return {"message": "Marked as read"}


@router.post("/read-all")
def mark_all_read(user=Depends(current_user)):
    notifications_collection.update_many({"user_id": user["_id"]}, {"$set": {"read": True}})
    return {"message": "All notifications marked as read"}
