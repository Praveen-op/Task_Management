from typing import Optional
from pydantic import BaseModel, EmailStr, Field

class SignupRequest(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    email: EmailStr
    password: str = Field(min_length=6, max_length=100)

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class ProjectCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    key: str = Field(min_length=2, max_length=10)
    description: str = ""

class IssueCreate(BaseModel):
    project_id: str
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    status: str = "To Do"
    priority: str = "Medium"
    due_date: str = Field(min_length=1)
    estimation: float = Field(gt=0)
    assignee_id: Optional[str] = None

class IssueUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    due_date: Optional[str] = None
    estimation: Optional[float] = None
    assignee_id: Optional[str] = None
    archived: Optional[bool] = None

class CommentCreate(BaseModel):
    issue_id: str
    body: str = Field(min_length=1, max_length=2000)

class NotificationMarkRead(BaseModel):
    read: bool = True

class InvitationCreate(BaseModel):
    role: str = Field(default="member")
    project_id: Optional[str] = None
    team_id: Optional[str] = None
