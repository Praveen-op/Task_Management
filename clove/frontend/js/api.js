// Auto-detect environment (localhost vs production cloud deployment)
const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

// Change this to your live Render backend URL once deployed (e.g. "https://clove-backend.onrender.com")
const PRODUCTION_BACKEND_URL = window.CLOVE_BACKEND_URL || "https://clove-backend.onrender.com";

const API_BASE = isLocal ? "http://127.0.0.1:8000" : PRODUCTION_BACKEND_URL;

window.CLOVE_CONFIG = {
  isLocal,
  API_BASE,
  getWsUrl: (projectId, token) => {
    if (isLocal) {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//127.0.0.1:8000/ws/projects/${projectId}?token=${encodeURIComponent(token || "")}`;
    }
    const host = PRODUCTION_BACKEND_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `wss://${host}/ws/projects/${projectId}?token=${encodeURIComponent(token || "")}`;
  }
};

window.byId = window.byId || function(id) {
  return document.getElementById(id);
};

async function api(path, options = {}) {
  const headers = {"Content-Type": "application/json", ...(options.headers || {})};
  const token = localStorage.getItem("clove_token");
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(API_BASE + path, {...options, headers});
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401) {
    if (!location.pathname.includes("login.html") && !location.pathname.includes("signup.html") && !location.pathname.includes("invite.html")) {
      localStorage.removeItem("clove_token");
      localStorage.removeItem("clove_user");
      location.href = "login.html";
    }
  }
  if (!response.ok) throw new Error(data.detail || "Request failed");
  return data;
}
