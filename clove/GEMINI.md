# CLOVE Repository Instructions & Architecture

This document serves as the guide and reference for the CLOVE workspace. It defines the architecture, project structure, technical stack, core patterns, and engineering conventions to ensure consistency and speed up development.

---

## 1. System Overview & Tech Stack

CLOVE is a Jira-like light issue tracker utilizing a direct client-server model:

```
Browser (Vanilla HTML/CSS/JS) <--> REST API (FastAPI) <--> DB (MongoDB via PyMongo)
```

- **Frontend**: Vanilla HTML5, CSS3 (using CSS custom properties, grid/flexbox layouts), and ES6+ JavaScript. No build pipeline or SPA frameworks are used. State is kept in-memory and/or `localStorage`.
- **Backend**: Python 3.10+ utilizing FastAPI for high-performance REST APIs, PyMongo for MongoDB interactions, and standard libraries.
- **Authentication**: JWT-based stateless authentication. Token validation is handled via standard FastAPI dependency injection with `HTTPBearer`.

---

## 2. Directory Structure

```text
clove/
├── README.md               # User-facing run instructions and stack overview
├── GEMINI.md               # Developer guidelines, conventions, and architectural notes (this file)
├── backend/
│   ├── app/
│   │   ├── routes/         # API Router modules (auth, projects, issues, etc.)
│   │   ├── database.py     # MongoDB connection setup and collection handles
│   │   ├── dependencies.py # API dependencies (e.g. current_user validation)
│   │   ├── main.py         # App entrypoint & CORS middleware
│   │   ├── schemas.py      # Pydantic models for validation and serialization
│   │   └── security.py     # Password hashing and JWT generation
│   ├── requirements.txt    # Python dependencies
│   └── venv/               # Local Python virtual environment (ignored in git)
└── frontend/
    ├── index.html          # Main application page (requires authentication)
    ├── login.html          # Login page
    ├── signup.html         # Signup page
    ├── css/
    │   └── style.css       # Unified CSS stylesheet for colors, variables, layout, and components
    └── js/
        ├── api.js          # Centrally defined `api()` fetch wrapper
        ├── app.js          # Core frontend state, DOM manipulation, and view routing
        └── auth.js         # Authentication page handlers (login, signup forms)
```

---

## 3. Backend Conventions (FastAPI & PyMongo)

### 3.1. Database Collection Handles
MongoDB handles are centralized in `backend/app/database.py`. Collection schemas are implicit but should follow these standard shapes:
- **users**: `{"_id": ObjectId, "name": str, "email": str, "password": str, "role": str}`
- **projects**: `{"_id": ObjectId, "name": str, "key": str, "description": str, "owner_id": str, "starred_by": [str], "created_at": datetime}`
- **issues**: `{"_id": ObjectId, "project_id": ObjectId, "title": str, "description": str, "status": str ("To Do" | "In Progress" | "Done"), "priority": str, "due_date": str | None, "assignee_id": str | None, "reporter_id": str, "archived": bool, "created_at": datetime, "updated_at": datetime}`
- **comments**: `{"_id": ObjectId, "issue_id": ObjectId, "user_id": str, "body": str, "created_at": datetime}`
- **notifications**: `{"_id": ObjectId, "user_id": str, "message": str, "issue_id": str, "read": bool, "created_at": datetime}`

### 3.2. Response Serialization
- Always transform native `_id` (ObjectId) properties to string properties (`id`) before returning them to the frontend.
- Utilize serializers like `serialize(p, user_id)` in `projects.py` or `serialize(x)` in `issues.py` to keep response structures clean.
- Ensure standard return shapes when returning empty or default values (e.g., using `.setdefault("due_date", None)`).

### 3.3. Request Validation (Pydantic)
- All request bodies must be validated using Pydantic classes declared in `backend/app/schemas.py`.
- Validation error handling should rely on FastAPI's default handling or raise explicit `HTTPException(400, "Validation detail message")`.

### 3.4. Authentication & Security
- Use the `current_user` dependency from `backend/app/dependencies.py` to protect routes requiring authentication.
- Read values from `current_user` with string object keys (e.g. `user["_id"]`, which is already converted to a string in `current_user`).
- Password validation uses `passlib.context.CryptContext` with `bcrypt`.
- JWT signatures are signed using HS256 algorithm with a secret key retrieved from `JWT_SECRET`.

---

## 4. Frontend Conventions (Vanilla JS & HTML/CSS)

### 4.1. Core API Fetch Wrapper
All REST calls to the backend must go through `api(path, options)` defined in `frontend/js/api.js`:
- The wrapper automatically injects `Authorization: Bearer <clove_token>` from `localStorage` if it exists.
- Content-Type headers default to `application/json` unless overridden.
- It parses JSON responses and converts any non-ok fetch response directly to a rejected Promise containing the server's error message.

### 4.2. Global State Management
State is managed globally in `frontend/js/app.js`:
- `projects`: List of all available projects.
- `users`: List of all team members.
- `notifications`: Current user notifications.
- `issues`: List of issues for the *currently active project*.
- `myIssues`: Issues assigned to the current user (used in "For You" view).

State transitions should always be accompanied by standard DOM rendering calls (e.g., `renderNotifications()`, `renderSidebarProjects()`, `renderProjectShell()`).

### 4.3. Views & Navigation
- Views are tracked via the `view` variable (`foryou` | `recent` | `starred` | `projects` | `team` | `project`).
- Switching views is done via `setView(v)` which sets state and invokes the matching render routine.
- Clean up or reset workspace state when switching context (e.g., clearing `activeProjectId` and resetting filters).

### 4.4. UI Conventions & Styling
- Always use the `esc(value)` helper when inserting dynamic strings into `innerHTML` to prevent XSS attacks.
- Ensure all custom styling uses variables declared in `css/style.css` for consistent spacing, fonts, and dark/light accents.
- Modal dialogues are loaded dynamically into `#modal-root`. Always ensure modal wrappers have standard structures and are properly dismissed when finished.

---

## 5. Local Development Workflow

To stand up the application locally, refer to the following workflow:

### Backend Initialization
```powershell
cd backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
# Copy the example environment file if .env is missing
if (!(Test-Path .env)) { copy .env.example .env }
uvicorn app.main:app --reload
```

### Frontend Static Server
```powershell
cd frontend
python -m http.server 5500
```
Then open `http://127.0.0.1:5500` in the browser.
