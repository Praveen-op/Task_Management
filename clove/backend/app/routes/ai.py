import os
import re
import json
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List, Tuple
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from bson import ObjectId

from ..database import (
    users_collection,
    projects_collection,
    issues_collection,
    notifications_collection,
)
from ..dependencies import current_user
from ..security import encrypt_api_key, decrypt_api_key
from ..websocket_manager import ws_manager

router = APIRouter(prefix="/ai", tags=["AI"])

VALID_PRIORITIES = ["Critical", "Highest", "High", "Medium", "Low", "Lowest"]
VALID_STATUSES = ["To Do", "In Progress", "Done"]


# -------------------------------------------------------------------------
# Request Models
# -------------------------------------------------------------------------
class SaveKeyRequest(BaseModel):
    provider: str
    api_key: str


class AICommandRequest(BaseModel):
    prompt: str
    current_project_id: Optional[str] = None
    provider: Optional[str] = "deepseek"
    api_key: Optional[str] = None


# -------------------------------------------------------------------------
# Zero Data Leakage Context Sanitizer
# -------------------------------------------------------------------------
def sanitize_context_for_ai(user: dict) -> dict:
    user_id = str(user["_id"])
    team_id = user.get("team_id", user_id)

    teammates = []
    try:
        team_docs = users_collection.find(
            {"team_id": team_id},
            {"name": 1, "_id": 0}
        )
        teammates = [doc.get("name", "").strip() for doc in team_docs if doc.get("name")]
    except Exception:
        teammates = [user.get("name", "Team Member")]

    if user.get("name") and user.get("name") not in teammates:
        teammates.append(user.get("name"))

    projects = []
    try:
        proj_docs = projects_collection.find(
            {"$or": [{"owner_id": user_id}, {"members": user_id}]},
            {"name": 1, "key": 1, "_id": 0}
        )
        projects = [{"name": p.get("name"), "key": p.get("key")} for p in proj_docs if p.get("key")]
    except Exception:
        projects = []

    return {
        "teammates": teammates,
        "existing_projects": projects,
        "allowed_priorities": VALID_PRIORITIES,
        "allowed_statuses": VALID_STATUSES,
    }


def build_sanitized_prompt(prompt: str, context: dict):
    system_instruction = (
        "You are Clovia, the intelligent CLOVE Agile Task Management AI Copilot. "
        "The user describes project management actions in plain English (creating projects, generating sprint tasks, assigning to team members, updating statuses). "
        "Translate the user prompt into a structured JSON execution plan.\n"
        "ZERO-DATA-LEAKAGE PRIVACY RULE: You only have access to display names and project keys. Do not ask for or expect personal, secret, or credentials data.\n"
        "CONVERSATIONAL RULE: If the user is just saying hello, asking a question, or chatting (e.g. 'hi', 'who are you', 'help'), return a friendly, helpful reply in 'summary' and leave 'actions' as an empty array []. Only populate 'actions' when the user explicitly wants to create or update projects, tasks, or statuses.\n"
        "Respond ONLY with a JSON object matching this schema:\n"
        "{\n"
        '  "summary": "Brief 1-sentence description of the planned actions",\n'
        '  "actions": [\n'
        '    {\n'
        '      "action": "create_project",\n'
        '      "name": "Project Name",\n'
        '      "key": "PRJ (2-5 uppercase letters)",\n'
        '      "description": "Project goal or overview"\n'
        '    },\n'
        '    {\n'
        '      "action": "create_task",\n'
        '      "project_key": "PRJ",\n'
        '      "title": "Clear task title",\n'
        '      "description": "Detailed task description",\n'
        '      "issue_type": "Feature",\n'
        '      "priority": "High",\n'
        '      "status": "To Do",\n'
        '      "assignee_name": "Teammate Name (or null)",\n'
        '      "estimation_days": 2,\n'
        '      "due_days_from_now": 7\n'
        '    },\n'
        '    {\n'
        '      "action": "update_task_status",\n'
        '      "task_key": "PRJ-1",\n'
        '      "status": "Done"\n'
        '    },\n'
        '    {\n'
        '      "action": "assign_task",\n'
        '      "task_key": "PRJ-1",\n'
        '      "assignee_name": "Teammate Name"\n'
        '    }\n'
        '  ]\n'
        "}\n"
    )

    user_payload_text = (
        f"{system_instruction}\n\n"
        f"--- SANITIZED CONTEXT ---\n"
        f"Available Teammates: {json.dumps(context['teammates'])}\n"
        f"Existing Projects: {json.dumps(context['existing_projects'])}\n"
        f"Allowed Priorities: {json.dumps(context['allowed_priorities'])}\n"
        f"Allowed Statuses: {json.dumps(context['allowed_statuses'])}\n\n"
        f"--- USER PROMPT ---\n"
        f"{prompt}\n\n"
        f"Return ONLY valid JSON."
    )
    return system_instruction, user_payload_text


def extract_json_from_text(text: str) -> Optional[dict]:
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    if cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()
    try:
        return json.loads(cleaned)
    except Exception:
        match = re.search(r"(\{.*\})", cleaned, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except Exception:
                pass
    return None


# -------------------------------------------------------------------------
# Cloud Provider API Callers
# -------------------------------------------------------------------------
def call_gemini_api(prompt: str, context: dict, user_key: Optional[str] = None) -> Tuple[Optional[dict], Optional[str]]:
    api_key = (user_key or os.getenv("GEMINI_API_KEY", "")).strip()
    if not api_key:
        return None, "No API key configured for Gemini"
    if "•" in api_key or any(ord(c) > 127 for c in api_key):
        return None, "Invalid or masked Gemini API key. Please re-enter a valid API key in Connector."

    _, user_payload_text = build_sanitized_prompt(prompt, context)
    request_body = {
        "contents": [{"role": "user", "parts": [{"text": user_payload_text}]}],
        "generationConfig": {"temperature": 0.1, "response_mime_type": "application/json"}
    }
    models = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"]
    last_err = None

    for model_name in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(request_body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                    parsed = extract_json_from_text(text)
                    if parsed:
                        parsed["_engine"] = f"Google Gemini ({model_name})"
                        return parsed, None
        except urllib.error.HTTPError as he:
            try:
                raw_b = he.read().decode("utf-8")
                j = json.loads(raw_b)
                last_err = j.get("error", {}).get("message") or f"HTTP {he.code}: {he.reason}"
            except Exception:
                last_err = f"HTTP {he.code}: {he.reason}"
        except (UnicodeEncodeError, UnicodeError):
            last_err = "API key contains invalid non-ASCII characters. Please re-enter a valid API key in Connector."
        except Exception as e:
            last_err = str(e)

    return None, last_err or "Gemini API request failed"


def call_openai_api(prompt: str, context: dict, user_key: Optional[str] = None) -> Tuple[Optional[dict], Optional[str]]:
    api_key = (user_key or os.getenv("OPENAI_API_KEY", "")).strip()
    if not api_key:
        return None, "No API key configured for OpenAI"
    if "•" in api_key or any(ord(c) > 127 for c in api_key):
        return None, "Invalid or masked OpenAI API key. Please re-enter a valid API key in Connector."

    system_instruction, user_payload_text = build_sanitized_prompt(prompt, context)
    models = ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"]
    last_err = None

    for model in models:
        req_body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": user_payload_text}
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1
        }
        try:
            req = urllib.request.Request(
                "https://api.openai.com/v1/chat/completions",
                data=json.dumps(req_body).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=18) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    content = data["choices"][0]["message"]["content"]
                    parsed = extract_json_from_text(content)
                    if parsed:
                        parsed["_engine"] = f"OpenAI ({model})"
                        return parsed, None
        except urllib.error.HTTPError as he:
            try:
                raw_b = he.read().decode("utf-8")
                j = json.loads(raw_b)
                last_err = j.get("error", {}).get("message") or f"HTTP {he.code}: {he.reason}"
            except Exception:
                last_err = f"HTTP {he.code}: {he.reason}"
        except (UnicodeEncodeError, UnicodeError):
            last_err = "API key contains invalid non-ASCII characters. Please re-enter a valid API key in Connector."
        except Exception as e:
            last_err = str(e)

    return None, last_err or "OpenAI API request failed"


def call_claude_api(prompt: str, context: dict, user_key: Optional[str] = None) -> Tuple[Optional[dict], Optional[str]]:
    api_key = (user_key or os.getenv("ANTHROPIC_API_KEY", "")).strip()
    if not api_key:
        return None, "No API key configured for Claude"
    if "•" in api_key or any(ord(c) > 127 for c in api_key):
        return None, "Invalid or masked Claude API key. Please re-enter a valid API key in Connector."

    system_instruction, user_payload_text = build_sanitized_prompt(prompt, context)
    models = ["claude-3-5-haiku-20241022", "claude-3-5-sonnet-20241022", "claude-3-haiku-20240307"]
    last_err = None

    for model in models:
        req_body = {
            "model": model,
            "max_tokens": 1500,
            "system": f"{system_instruction}\nCRITICAL: Respond ONLY with valid JSON.",
            "messages": [{"role": "user", "content": user_payload_text}],
            "temperature": 0.1
        }
        try:
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=json.dumps(req_body).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=18) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    parts = data.get("content", [])
                    if parts:
                        text = parts[0].get("text", "")
                        parsed = extract_json_from_text(text)
                        if parsed:
                            parsed["_engine"] = f"Anthropic Claude ({model})"
                            return parsed, None
        except urllib.error.HTTPError as he:
            try:
                raw_b = he.read().decode("utf-8")
                j = json.loads(raw_b)
                last_err = j.get("error", {}).get("message") or f"HTTP {he.code}: {he.reason}"
            except Exception:
                last_err = f"HTTP {he.code}: {he.reason}"
        except (UnicodeEncodeError, UnicodeError):
            last_err = "API key contains invalid non-ASCII characters. Please re-enter a valid API key in Connector."
        except Exception as e:
            last_err = str(e)

    return None, last_err or "Claude API request failed"


def call_deepseek_api(prompt: str, context: dict, user_key: Optional[str] = None) -> Tuple[Optional[dict], Optional[str]]:
    api_key = (user_key or os.getenv("DEEPSEEK_API_KEY", "")).strip()
    if not api_key:
        return None, "No API key configured for DeepSeek"
    if "•" in api_key or any(ord(c) > 127 for c in api_key):
        return None, "Invalid or masked DeepSeek API key. Please re-enter a valid API key in Connector."

    system_instruction, user_payload_text = build_sanitized_prompt(prompt, context)
    models = ["deepseek-chat"]
    last_err = None

    for model in models:
        req_body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": user_payload_text}
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1
        }
        try:
            req = urllib.request.Request(
                "https://api.deepseek.com/chat/completions",
                data=json.dumps(req_body).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=18) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    content = data["choices"][0]["message"]["content"]
                    parsed = extract_json_from_text(content)
                    if parsed:
                        parsed["_engine"] = f"DeepSeek ({model})"
                        return parsed, None
        except urllib.error.HTTPError as he:
            try:
                raw_b = he.read().decode("utf-8")
                j = json.loads(raw_b)
                last_err = j.get("error", {}).get("message") or f"HTTP {he.code}: {he.reason}"
            except Exception:
                last_err = f"HTTP {he.code}: {he.reason}"
        except (UnicodeEncodeError, UnicodeError):
            last_err = "API key contains invalid non-ASCII characters. Please re-enter a valid API key in Connector."
        except Exception as e:
            last_err = str(e)

    return None, last_err or "DeepSeek API request failed"


def call_ai_engine(provider: Optional[str], prompt: str, context: dict, user_key: Optional[str] = None) -> Tuple[Optional[dict], Optional[str]]:
    p = (provider or "deepseek").strip().lower()

    if p in ["deepseek", "deekseek", "deekseeck"]:
        return call_deepseek_api(prompt, context, user_key)
    elif p in ["openai", "chatgpt"]:
        return call_openai_api(prompt, context, user_key)
    elif p in ["claude", "anthropic"]:
        return call_claude_api(prompt, context, user_key)
    else:
        return call_gemini_api(prompt, context, user_key)


# -------------------------------------------------------------------------
# Endpoints: Safe MongoDB Key Management
# -------------------------------------------------------------------------
@router.get("/keys")
def get_user_ai_keys(user=Depends(current_user)):
    user_id = str(user["_id"])
    user_doc = users_collection.find_one({"_id": ObjectId(user_id)}, {"ai_keys": 1})
    ai_keys = (user_doc or {}).get("ai_keys") or {}

    configured = {}
    masked = {}
    for prov in ["gemini", "deepseek", "openai", "claude"]:
        enc_val = ai_keys.get(prov)
        if enc_val:
            configured[prov] = True
            raw = decrypt_api_key(enc_val, user_id)
            if raw and len(raw) > 8:
                masked[prov] = raw[:4] + "••••••••" + raw[-4:]
            elif raw:
                masked[prov] = "••••••••"
            else:
                masked[prov] = ""
        else:
            configured[prov] = False
            masked[prov] = ""

    return {
        "success": True,
        "configured": configured,
        "masked_keys": masked,
        "storage": "MongoDB (Encrypted via PBKDF2 + ChaCha20 + HMAC-SHA256)"
    }


@router.post("/keys")
def save_user_ai_key(body: SaveKeyRequest, user=Depends(current_user)):
    user_id = str(user["_id"])
    provider = body.provider.strip().lower()
    raw_key = body.api_key.strip()

    if provider not in ["gemini", "deepseek", "openai", "claude"]:
        raise HTTPException(status_code=400, detail="Unsupported AI provider")

    if not raw_key:
        users_collection.update_one(
            {"_id": ObjectId(user_id)},
            {"$unset": {f"ai_keys.{provider}": ""}}
        )
        return {"success": True, "message": f"{provider.capitalize()} key removed from MongoDB"}

    if "•" in raw_key or any(ord(c) > 127 for c in raw_key) or "..." in raw_key:
        raise HTTPException(
            status_code=400,
            detail="Cannot save masked or invalid API key. Please paste your actual raw API key."
        )

    encrypted_str = encrypt_api_key(raw_key, user_id)
    users_collection.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {f"ai_keys.{provider}": encrypted_str}}
    )

    masked = raw_key[:4] + "••••••••" + raw_key[-4:] if len(raw_key) > 8 else "••••••••"
    return {
        "success": True,
        "message": f"🔒 {provider.capitalize()} API key encrypted and safely stored in MongoDB!",
        "masked_key": masked
    }


@router.delete("/keys")
def delete_user_ai_key(provider: str, user=Depends(current_user)):
    user_id = str(user["_id"])
    p = provider.strip().lower()
    users_collection.update_one(
        {"_id": ObjectId(user_id)},
        {"$unset": {f"ai_keys.{p}": ""}}
    )
    return {"success": True, "message": f"{p.capitalize()} key wiped from MongoDB"}


# -------------------------------------------------------------------------
# Endpoint: Execute AI Command
# -------------------------------------------------------------------------
@router.post("/command")
async def execute_ai_command(
    body: AICommandRequest,
    user=Depends(current_user)
):
    user_id = str(user["_id"])
    is_admin = user.get("role") == "admin"

    sanitized_context = sanitize_context_for_ai(user)

    default_project_key = None
    if body.current_project_id and ObjectId.is_valid(body.current_project_id):
        proj_doc = projects_collection.find_one({"_id": ObjectId(body.current_project_id)})
        if proj_doc:
            default_project_key = proj_doc.get("key")

    effective_api_key = (body.api_key or "").strip()
    if not effective_api_key or "•" in effective_api_key or "••••" in effective_api_key or "..." in effective_api_key or any(ord(c) > 127 for c in effective_api_key):
        effective_api_key = ""
        user_doc = users_collection.find_one({"_id": ObjectId(user_id)}, {"ai_keys": 1})
        ai_keys = (user_doc or {}).get("ai_keys") or {}
        enc_key = ai_keys.get(body.provider)
        if enc_key:
            decrypted = decrypt_api_key(enc_key, user_id)
            if decrypted and not ("•" in decrypted or any(ord(c) > 127 for c in decrypted) or "..." in decrypted):
                effective_api_key = decrypted
            else:
                # Key in DB was masked or corrupted - clean it up so it never throws latin-1 codec errors
                users_collection.update_one(
                    {"_id": ObjectId(user_id)},
                    {"$unset": {f"ai_keys.{body.provider}": ""}}
                )
                effective_api_key = ""

    provider_name = (body.provider or "DeepSeek").capitalize()

    if not effective_api_key:
        return {
            "success": False,
            "message": f"No API key configured for {provider_name}. Clovia operates exclusively via cloud AI models. Please open the Connector and enter your {provider_name} API key to begin.",
            "require_key": True
        }

    plan, cloud_err = call_ai_engine(body.provider, body.prompt, sanitized_context, effective_api_key)

    if cloud_err:
        if "Insufficient Balance" in str(cloud_err) or "insufficient_quota" in str(cloud_err):
            err_msg = f"⚠️ {provider_name} API returned Insufficient Balance (your account requires prepaid credits). Please check your {provider_name} account or switch to another provider in the Connector."
        else:
            err_msg = f"{provider_name} API Error: {cloud_err}"
        return {
            "success": False,
            "message": err_msg,
            "plan": None
        }

    if not plan:
        return {
            "success": False,
            "message": f"No valid response received from {provider_name} API. Please check your API key and network connection.",
            "plan": None
        }

    actions = plan.get("actions", [])
    if not actions:
        # Conversational greeting, explanation, or guidance directly from cloud LLM
        return {
            "success": True,
            "summary": plan.get("summary") or "Understood! Let me know if you would like me to create or update any projects or tasks.",
            "actions_executed": [],
            "engine": plan.get("_engine", provider_name),
            "is_conversational": True
        }

    requires_admin = any(a.get("action") in ["create_project", "create_task"] for a in actions)
    if requires_admin and not is_admin:
        raise HTTPException(
            status_code=403,
            detail="Only workspace administrators have permission to create projects and tasks."
        )

    batch_created_projects: Dict[str, ObjectId] = {}
    executed_results = []
    first_created_project_id = None

    def resolve_teammate(name_query: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
        if not name_query or not str(name_query).strip():
            return None, None
        q = str(name_query).strip()
        team_id = user.get("team_id", user_id)

        # 1. Exact match
        match = users_collection.find_one(
            {"team_id": team_id, "name": {"$regex": f"^{re.escape(q)}$", "$options": "i"}}
        )
        if match:
            return str(match["_id"]), match.get("name", q)

        # 2. Prefix match (e.g. "prav" -> "Praveen")
        match = users_collection.find_one(
            {"team_id": team_id, "name": {"$regex": f"^{re.escape(q)}", "$options": "i"}}
        )
        if match:
            return str(match["_id"]), match.get("name", q)

        # 3. Substring match
        match = users_collection.find_one(
            {"team_id": team_id, "name": {"$regex": re.escape(q), "$options": "i"}}
        )
        if match:
            return str(match["_id"]), match.get("name", q)

        return None, q

    for act in actions:
        action_type = act.get("action")

        if action_type == "create_project":
            p_name = (act.get("name") or "New Project").strip()
            p_key = (act.get("key") or "PRJ").strip().upper()
            p_desc = act.get("description") or ""

            unique_key = p_key
            counter = 1
            while projects_collection.find_one({"key": unique_key}):
                unique_key = f"{p_key[:4]}{counter}"
                counter += 1

            new_proj = {
                "name": p_name,
                "key": unique_key,
                "description": p_desc,
                "sprint_start_date": "",
                "sprint_end_date": "",
                "owner_id": user_id,
                "members": [user_id],
                "starred_by": [],
                "issue_counter": 0,
                "created_at": datetime.now(timezone.utc),
            }
            res = projects_collection.insert_one(new_proj)
            proj_id = res.inserted_id
            batch_created_projects[unique_key] = proj_id
            batch_created_projects[p_key] = proj_id
            if not first_created_project_id:
                first_created_project_id = str(proj_id)

            executed_results.append({
                "type": "project_created",
                "id": str(proj_id),
                "key": unique_key,
                "name": p_name
            })

        elif action_type == "create_task":
            target_proj_key = (act.get("project_key") or "").strip().upper()
            proj_doc = None

            if target_proj_key in batch_created_projects:
                proj_id = batch_created_projects[target_proj_key]
                proj_doc = projects_collection.find_one({"_id": proj_id})
            elif target_proj_key:
                proj_doc = projects_collection.find_one({"key": target_proj_key})

            if not proj_doc and default_project_key:
                proj_doc = projects_collection.find_one({"key": default_project_key})

            if not proj_doc and sanitized_context["existing_projects"]:
                first_key = sanitized_context["existing_projects"][0]["key"]
                proj_doc = projects_collection.find_one({"key": first_key})

            if not proj_doc:
                def_proj = {
                    "name": "General Workspace",
                    "key": "GEN",
                    "description": "Auto-created workspace project",
                    "owner_id": user_id,
                    "members": [user_id],
                    "starred_by": [],
                    "issue_counter": 0,
                    "created_at": datetime.now(timezone.utc),
                }
                res = projects_collection.insert_one(def_proj)
                proj_doc = def_proj
                proj_doc["_id"] = res.inserted_id

            proj_id = proj_doc["_id"]
            proj_key = proj_doc.get("key", "TSK")

            from pymongo import ReturnDocument
            proj_updated = projects_collection.find_one_and_update(
                {"_id": proj_id},
                {"$inc": {"issue_counter": 1}},
                return_document=ReturnDocument.AFTER
            )
            issue_number = proj_updated.get("issue_counter", 1)
            issue_key_str = f"{proj_key}-{issue_number}"

            due_days = int(act.get("due_days_from_now") or 7)
            due_date_str = (datetime.now(timezone.utc) + timedelta(days=due_days)).strftime("%Y-%m-%d")

            assignee_raw = act.get("assignee_name")
            assignee_id, resolved_assignee_name = resolve_teammate(assignee_raw) if assignee_raw else (None, None)

            priority = act.get("priority", "Medium")
            if priority not in VALID_PRIORITIES:
                priority = "Medium"
            status = act.get("status", "To Do")
            if status not in VALID_STATUSES:
                status = "To Do"

            estimation = int(act.get("estimation_days") or 2)
            if estimation <= 0:
                estimation = 1

            task_doc = {
                "project_id": proj_id,
                "number": issue_number,
                "key": issue_key_str,
                "title": (act.get("title") or "New Task").strip(),
                "description": (act.get("description") or "").strip(),
                "issue_type": act.get("issue_type") if act.get("issue_type") in ["Feature", "Bug", "Story", "Task", "Chore"] else "Feature",
                "status": status,
                "priority": priority,
                "due_date": due_date_str,
                "start_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                "estimation": estimation,
                "logged_hours": 0.0,
                "blocked_by": [],
                "blocks": [],
                "assignee_id": assignee_id,
                "reporter_id": user["_id"],
                "archived": False,
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
            }

            task_res = issues_collection.insert_one(task_doc)
            task_id = str(task_res.inserted_id)

            if assignee_id:
                projects_collection.update_one(
                    {"_id": proj_id},
                    {"$addToSet": {"members": str(assignee_id)}}
                )
                try:
                    notifications_collection.insert_one({
                        "user_id": assignee_id,
                        "message": f"Clovia assigned you to task \"{task_doc['title']}\"",
                        "issue_id": task_id,
                        "read": False,
                        "created_at": datetime.now(timezone.utc),
                    })
                except Exception:
                    pass

            await ws_manager.broadcast_to_project(
                str(proj_id),
                {
                    "type": "issue_created",
                    "issue_id": task_id,
                    "issue_key": issue_key_str,
                    "title": task_doc["title"],
                    "actor_id": user_id,
                    "status": status,
                }
            )

            executed_results.append({
                "type": "task_created",
                "key": issue_key_str,
                "title": task_doc["title"],
                "project_key": proj_key,
                "project_id": str(proj_id),
                "assignee": resolved_assignee_name if assignee_id else (assignee_raw or None),
                "priority": priority,
                "status": status,
                "issue_type": task_doc["issue_type"]
            })

        elif action_type == "update_task_status":
            t_key = (act.get("task_key") or "").strip().upper()
            target_status = act.get("status", "Done")
            if target_status not in VALID_STATUSES:
                target_status = "Done"

            issue_doc = issues_collection.find_one({"key": t_key})
            if issue_doc:
                issues_collection.update_one(
                    {"_id": issue_doc["_id"]},
                    {"$set": {"status": target_status, "updated_at": datetime.now(timezone.utc)}}
                )
                await ws_manager.broadcast_to_project(
                    str(issue_doc["project_id"]),
                    {
                        "type": "issue_updated",
                        "issue_id": str(issue_doc["_id"]),
                        "issue_key": t_key,
                        "field": "status",
                        "new_value": target_status,
                        "actor_id": user_id
                    }
                )
                executed_results.append({
                    "type": "task_status_updated",
                    "key": t_key,
                    "new_status": target_status
                })

        elif action_type == "assign_task":
            t_key = (act.get("task_key") or "").strip().upper()
            a_name = act.get("assignee_name")
            a_id, resolved_name = resolve_teammate(a_name)
            issue_doc = issues_collection.find_one({"key": t_key})
            if issue_doc and a_id:
                issues_collection.update_one(
                    {"_id": issue_doc["_id"]},
                    {"$set": {"assignee_id": a_id, "updated_at": datetime.now(timezone.utc)}}
                )
                projects_collection.update_one(
                    {"_id": issue_doc["project_id"]},
                    {"$addToSet": {"members": a_id}}
                )
                try:
                    notifications_collection.insert_one({
                        "user_id": a_id,
                        "message": f"Clovia assigned you to \"{issue_doc.get('title')}\"",
                        "issue_id": str(issue_doc["_id"]),
                        "read": False,
                        "created_at": datetime.now(timezone.utc),
                    })
                except Exception:
                    pass
                await ws_manager.broadcast_to_project(
                    str(issue_doc["project_id"]),
                    {
                        "type": "issue_updated",
                        "issue_id": str(issue_doc["_id"]),
                        "issue_key": t_key,
                        "field": "assignee_id",
                        "new_value": a_id,
                        "actor_id": user_id
                    }
                )
                executed_results.append({
                    "type": "task_assigned",
                    "key": t_key,
                    "assignee": resolved_name if a_id else a_name
                })

    return {
        "success": True,
        "summary": plan.get("summary") or f"Successfully executed {len(executed_results)} action(s).",
        "engine": plan.get("_engine", "Clovia"),
        "zero_leakage_protected": True,
        "first_project_id": first_created_project_id,
        "actions_executed": executed_results,
    }
