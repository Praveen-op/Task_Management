import json
from typing import Dict, List
from fastapi import WebSocket


class ConnectionManager:
    """
    Manages active WebSocket connections grouped by project_id.
    Enables instant real-time broadcasts when task statuses, assignments,
    or details are updated across team members.
    """

    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, project_id: str):
        await websocket.accept()
        if project_id not in self.active_connections:
            self.active_connections[project_id] = []
        self.active_connections[project_id].append(websocket)

    def disconnect(self, websocket: WebSocket, project_id: str):
        if project_id in self.active_connections:
            if websocket in self.active_connections[project_id]:
                self.active_connections[project_id].remove(websocket)
            if not self.active_connections[project_id]:
                del self.active_connections[project_id]

    async def broadcast_to_project(self, project_id: str, message: dict):
        if project_id not in self.active_connections:
            return
        dead = []
        for connection in list(self.active_connections[project_id]):
            try:
                await connection.send_text(json.dumps(message, default=str))
            except Exception:
                dead.append(connection)
        for d in dead:
            self.disconnect(d, project_id)


ws_manager = ConnectionManager()
