from typing import Optional, Union
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
    sprint_start_date: Optional[str] = None
    sprint_end_date: Optional[str] = None

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    sprint_start_date: Optional[str] = None
    sprint_end_date: Optional[str] = None

class IssueCreate(BaseModel):
    project_id: str
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    issue_type: Optional[str] = "Feature"
    status: str = "To Do"
    priority: str = "Medium"
    due_date: str = Field(min_length=1)
    start_date: Optional[str] = None
    estimation: Union[int, float] = Field(gt=0)
    estimation_hours: Optional[float] = None
    assignee_id: Optional[str] = None

class IssueUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    issue_type: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    due_date: Optional[str] = None
    start_date: Optional[str] = None
    estimation: Optional[Union[int, float]] = None
    estimation_hours: Optional[float] = None
    assignee_id: Optional[str] = None
    archived: Optional[bool] = None

class WorklogCreate(BaseModel):
    hours: float = Field(gt=0, le=100)
    date: Optional[str] = None
    comment: Optional[str] = Field(default="", max_length=500)

class DependencyCreate(BaseModel):
    target_issue_id: str
    type: str = "blocked_by" # "blocked_by" or "blocks"

class ProjectWorkflowUpdate(BaseModel):
    statuses: list[dict]

class CommentCreate(BaseModel):
    issue_id: str
    body: Optional[str] = Field(default="", max_length=2000)
    attachment: Optional[dict] = None

class NotificationMarkRead(BaseModel):
    read: bool = True

class InvitationCreate(BaseModel):
    role: str = Field(default="member")
    project_id: Optional[str] = None
    team_id: Optional[str] = None
