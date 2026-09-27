# CLOVE

CLOVE is a Task Magaement web application built with plain web development technologies.

## Stack

- Frontend: HTML, CSS, JavaScript
- Backend: Python + FastAPI
- Database: MongoDB
- Driver: PyMongo
- Authentication: JWT

## Architecture

Browser -> HTML/CSS/JavaScript -> REST API -> FastAPI -> PyMongo -> MongoDB

## Features

- Signup, login, JWT authentication
- Top navbar: search (projects + tasks), quick-create menu, notifications, settings, profile menu
- Sidebar: For You, Recent, Starred, Projects, My Team
- Projects: create, list, star/unstar
- Project tabs: Summary (status counts), Backlog (flat task list), Board (Kanban)
- Kanban board with drag-and-drop between To Do / In Progress / Done
- Task cards show title, due date, issue key (e.g. WEB-A1B2), and assignee
- Board actions: filter by priority/assignee, group by assignee/priority, Complete Sprint (archives Done tasks), Board Settings (toggle due-date display, saved per device)
- Task creation/editing: title, description, status, priority, due date, assignee, comments
- Notifications: a user is notified when assigned to a task
- Settings: update your display name
- MongoDB collections for users, projects, issues, comments, notifications

## Notes on scope

- "My Team" currently shows everyone in the workspace — there's no multi-team model yet, so this is intentionally simple rather than simulated.
- "Complete Sprint" has no underlying sprint/cycle model; it archives whatever is currently in the Done column. This is stated in the API and UI so it isn't confused with real sprint planning.
- "Recent" and per-project "Board Settings" (like the due-date toggle) are stored in the browser (localStorage), so they're per-device, not shared across your devices or teammates.

## Requirements

- Python 3.10+
- MongoDB running
- A modern browser

## Run Backend

python -m venv venv
.\venv\Scripts\Activate
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload

## Run Frontend
python -m http.server 5500

## MongoDB

Default connection:

The backend can be built and run as a standalone container using Docker:

### 1. Build the Docker Image
docker build -t clove-backend 

## 2. Run the Container

docker run 




