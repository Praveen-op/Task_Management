from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from bson import ObjectId
from .database import client, users_collection
from .security import decode_token
from .websocket_manager import ws_manager
from .routes import auth, users, projects, issues, comments, notifications, search, invitations

app = FastAPI(title="CLOVE API", version="1.0.0")

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

@app.get("/health")
def health():
    try:
        client.admin.command("ping")
        return {"status": "healthy", "database": "connected"}
    except Exception:
        return {"status": "degraded", "database": "disconnected"}
