from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, HTMLResponse
from fastapi.openapi.docs import get_swagger_ui_html
from bson import ObjectId
from .database import client, users_collection, projects_collection, issues_collection
from .security import decode_token
from .websocket_manager import ws_manager
from .routes import auth, users, projects, issues, comments, notifications, search, invitations

app = FastAPI(title="CLOVE API", version="1.0.0", docs_url=None)

@app.get("/docs", include_in_schema=False)
async def custom_swagger_ui_html():
    html_res = get_swagger_ui_html(
        openapi_url=app.openapi_url or "/openapi.json",
        title=f"{app.title} - Swagger UI",
        swagger_favicon_url="https://fastapi.tiangolo.com/img/favicon.png",
    )
    custom_head_content = """
    <style>
        .swagger-ui .info hgroup.main a,
        .swagger-ui .info a[href*="openapi.json"],
        .swagger-ui .info .link,
        .swagger-ui .info .url,
        .swagger-ui span.url {
            display: none !important;
        }
    </style>
    <script>
        const observer = new MutationObserver(() => {
            document.querySelectorAll('.swagger-ui a[href*="openapi.json"], .swagger-ui .info hgroup.main a').forEach(el => el.remove());
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    </script>
    """
    body = html_res.body.decode("utf-8").replace("</head>", f"{custom_head_content}</head>")
    return HTMLResponse(content=body)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(projects.router)
app.include_router(issues.router)
app.include_router(comments.router)
app.include_router(notifications.router)
app.include_router(search.router)
app.include_router(invitations.router)

@app.websocket("/ws/projects/{project_id}")
async def websocket_project_sync(websocket: WebSocket, project_id: str, token: str = ""):
    if token:
        try:
            user_id = decode_token(token)
            user = users_collection.find_one({"_id": ObjectId(user_id)})
            if not user:
                await websocket.close(code=4001, reason="Invalid authentication token")
                return
        except Exception:
            await websocket.close(code=4001, reason="Authentication failed")
            return

    await ws_manager.connect(websocket, project_id)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket, project_id)
    except Exception:
        ws_manager.disconnect(websocket, project_id)

@app.get("/invite/{token}")
def redirect_to_frontend_invite(token: str):
    # Convenience redirect to the static frontend server
    return RedirectResponse(url=f"http://127.0.0.1:5500/invite.html?token={token}")

@app.get("/")
def root():
    return {"application": "CLOVE", "message": "CLOVE API is running"}

@app.on_event("startup")
def migrate_issue_keys():
    try:
        for proj in projects_collection.find():
            proj_id = proj["_id"]
            proj_key = (proj.get("key") or "ISS").strip().upper()
            proj_issues = list(issues_collection.find({"project_id": proj_id}).sort([("created_at", 1), ("_id", 1)]))
            counter = len(proj_issues)
            for idx, iss in enumerate(proj_issues, start=1):
                target_key = f"{proj_key}-{idx}"
                if iss.get("number") != idx or iss.get("key") != target_key:
                    issues_collection.update_one(
                        {"_id": iss["_id"]},
                        {"$set": {"number": idx, "key": target_key}}
                    )
            if proj.get("issue_counter", 0) < counter:
                projects_collection.update_one(
                    {"_id": proj_id},
                    {"$set": {"issue_counter": counter}}
                )
    except Exception as err:
        print("Issue keys migration error:", err)


@app.get("/health")
def health():
    try:
        client.admin.command("ping")
        return {"status": "healthy", "database": "connected"}
    except Exception:
        return {"status": "degraded", "database": "disconnected"}
