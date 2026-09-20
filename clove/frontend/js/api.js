const API_BASE = "http://127.0.0.1:8000";

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
