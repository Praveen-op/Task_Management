// Handle potential direct invite links or pending invite tokens
const urlParams = new URLSearchParams(window.location.search);
const directInviteToken = urlParams.get("token") || urlParams.get("invite");
if (directInviteToken) {
  location.href = `invite.html?token=${encodeURIComponent(directInviteToken)}`;
}

const token = localStorage.getItem("clove_token");
if (!token) {
  location.href = "login.html";
}

const pendingInvite = localStorage.getItem("clove_pending_invite");
if (pendingInvite) {
  location.href = `invite.html?token=${encodeURIComponent(pendingInvite)}`;
}

let currentUser = JSON.parse(localStorage.getItem("clove_user") || "{}");
const app = document.getElementById("app");

// ---------- Global state ----------
let projects = [];
let users = [];
let notifications = [];
let issues = [];               // issues for the currently open project (Board/Backlog)
let myIssues = [];             // issues assigned to current user (For You view)

let view = "foryou";           // foryou | recent | starred | projects | team | project
let activeProjectId = null;
let activeTab = "board";       // summary | backlog | board

let boardFilters = { priority: "", assignee_id: "" };
let boardGroupBy = "none";     // none | assignee | priority

let projectSocket = null;
let projectPingTimer = null;
let projectSyncPollTimer = null;
let isDraggingCard = false;

async function refreshUsers() {
  try {
    const data = await api("/users");
    if (data && Array.isArray(data)) users = data;
  } catch {}
}

// ---------- Small helpers ----------
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m])); }
function byId(id) { return document.getElementById(id); }
function findProject(id) { return projects.find(p => p.id === id); }
function findUser(id) { return users.find(u => u.id === id); }
function userLabel(id) { const u = findUser(id); return u ? u.name : "Unassigned"; }
function initials(name) { return (name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase(); }
function issueKey(projectId, issueId) {
  const p = findProject(projectId);
  const prefix = p ? p.key : "ISS";
  return `${prefix}-${issueId.slice(-4).toUpperCase()}`;
}
function formatDate(d) {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date)) return d;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function isOverdue(d) {
  if (!d) return false;
  const date = new Date(d);
  return !isNaN(date) && date < new Date(new Date().toDateString());
}
function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---------- Recent projects (per-browser convenience, not shared data) ----------
function getRecentIds() {
  try { return JSON.parse(localStorage.getItem("clove_recent") || "[]"); } catch { return []; }
}
function pushRecentId(id) {
  let recent = getRecentIds().filter(x => x !== id);
  recent.unshift(id);
  recent = recent.slice(0, 8);
  localStorage.setItem("clove_recent", JSON.stringify(recent));
}

// ---------- Per-project board display settings (per-browser preference) ----------
function getBoardSettings(projectId) {
  try { return JSON.parse(localStorage.getItem(`clove_board_settings_${projectId}`) || "{}"); }
  catch { return {}; }
}
function setBoardSettings(projectId, settings) {
  localStorage.setItem(`clove_board_settings_${projectId}`, JSON.stringify(settings));
}

// ================= Shell =================

function shell() {
  app.innerHTML = `
  <div class="app">
    <header class="navbar">
      <div class="brand-small">CLOVE</div>

      <div class="nav-search">
        <input id="navSearch" type="text" placeholder="Search projects and tasks...">
        <div id="searchResults" class="search-results hidden"></div>
      </div>

      <div class="nav-actions">
        <div class="dropdown-wrap">
          <button class="icon-btn" id="createBtn" title="Create">+</button>
          <div class="dropdown-panel create-menu hidden" id="createMenu">
            <div class="dropdown-list">
              <button id="createProjectOpt">📁 New Project</button>
              <button id="createTaskOpt">✓ New Task</button>
              <button id="inviteUserOpt">✉️ Invite User</button>
            </div>
          </div>
        </div>

        <div class="dropdown-wrap">
          <button class="icon-btn" id="notifBtn" title="Notifications">
            🔔<span id="notifBadge" class="badge-dot hidden">0</span>
          </button>
          <div class="dropdown-panel hidden" id="notifPanel">
            <div class="dropdown-head">
              <h4>Notifications</h4>
              <button class="link-btn" id="markAllReadBtn">Mark all read</button>
            </div>
            <div class="dropdown-list" id="notifList"></div>
          </div>
        </div>

        <div class="dropdown-wrap">
          <button class="icon-btn" id="settingsBtn" title="Settings">⚙️</button>
        </div>

        <div class="dropdown-wrap">
          <button class="profile-btn" id="profileBtn" title="Profile">${initials(currentUser.name)}</button>
          <div class="dropdown-panel hidden" id="profilePanel">
            <div class="profile-panel">
              <div class="p-name">${esc(currentUser.name)}</div>
              <div class="p-email">${esc(currentUser.email)}</div>
              <hr>
              <button class="secondary" id="logoutBtn">Logout</button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <div class="nav-section-title">Home</div>
        <div class="nav">
          <button class="small" data-view="foryou">🏠 For You</button>
          <button class="small" data-view="recent">🕘 Recent</button>
          <button class="small" data-view="starred">⭐ Starred</button>
        </div>

        <div class="nav-section-title">Projects</div>
        <div class="nav">
          <button class="small" data-view="projects">📁 All Projects</button>
        </div>
        <div class="project-mini-list" id="sidebarProjectList"></div>

        <div class="nav-section-title">Team</div>
        <div class="nav">
          <button class="small" data-view="team">👥 My Team</button>
          <button class="small" id="sidebarInviteBtn" style="color:#5b46d8;font-weight:700">✉️ Invite User</button>
        </div>
      </aside>
      <main id="content" class="content"></main>
    </div>

    <div id="modal-root"></div>
  </div>`;

  setupShellHandlers();
}

function setupShellHandlers() {
  byId("logoutBtn").onclick = () => {
    disconnectProjectWebSocket();
    stopProjectPolling();
    localStorage.clear();
    location.href = "login.html";
  };

  document.querySelectorAll(".sidebar .nav button[data-view]").forEach(b => {
    b.onclick = () => { setView(b.dataset.view); };
  });

  // Create menu
  const createMenu = byId("createMenu");
  byId("createBtn").onclick = (e) => { e.stopPropagation(); closeAllDropdowns(createMenu); createMenu.classList.toggle("hidden"); };
  byId("createProjectOpt").onclick = () => { createMenu.classList.add("hidden"); openProjectModal(); };
  byId("createTaskOpt").onclick = () => { createMenu.classList.add("hidden"); openIssueModal(); };
  byId("inviteUserOpt").onclick = () => { createMenu.classList.add("hidden"); openInviteModal(); };
  byId("sidebarInviteBtn").onclick = () => openInviteModal();

  // Notifications
  const notifPanel = byId("notifPanel");
  byId("notifBtn").onclick = (e) => { e.stopPropagation(); closeAllDropdowns(notifPanel); notifPanel.classList.toggle("hidden"); };
  byId("markAllReadBtn").onclick = async () => {
    await api("/notifications/read-all", { method: "POST" });
    notifications.forEach(n => n.read = true);
    renderNotifications();
  };

  // Profile
  const profilePanel = byId("profilePanel");
  byId("profileBtn").onclick = (e) => { e.stopPropagation(); closeAllDropdowns(profilePanel); profilePanel.classList.toggle("hidden"); };

  // Settings
  byId("settingsBtn").onclick = (e) => { e.stopPropagation(); openSettingsModal(); };

  document.addEventListener("click", () => closeAllDropdowns());

  // Search
  const searchInput = byId("navSearch");
  const searchResults = byId("searchResults");
  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) { searchResults.classList.add("hidden"); return; }
    searchTimer = setTimeout(async () => {
      try {
        const data = await api(`/search?q=${encodeURIComponent(q)}`);
        renderSearchResults(data);
      } catch { /* ignore transient search errors */ }
    }, 300);
  });
  searchInput.addEventListener("click", e => e.stopPropagation());
  searchResults.addEventListener("click", e => e.stopPropagation());
}

function closeAllDropdowns(except) {
  ["createMenu", "notifPanel", "profilePanel"].forEach(id => {
    const el = byId(id);
    if (el && el !== except) el.classList.add("hidden");
  });
  const sr = byId("searchResults");
  if (sr && sr !== except) sr.classList.add("hidden");
}

function renderSearchResults(data) {
  const box = byId("searchResults");
  const hasResults = data.projects.length || data.issues.length;
  if (!hasResults) {
    box.innerHTML = `<div class="sr-empty">No matches.</div>`;
  } else {
    let html = "";
    if (data.projects.length) {
      html += `<div class="sr-heading">Projects</div>`;
      html += data.projects.map(p => `<div class="sr-item" data-project="${p.id}"><span>${esc(p.name)}</span><span class="pill">${esc(p.key)}</span></div>`).join("");
    }
    if (data.issues.length) {
      html += `<div class="sr-heading">Tasks</div>`;
      html += data.issues.map(i => `<div class="sr-item" data-issue="${i.id}" data-project-jump="${i.project_id}"><span>${esc(i.title)}</span><span class="pill">${esc(i.status)}</span></div>`).join("");
    }
    box.innerHTML = html;
    box.querySelectorAll("[data-project]").forEach(el => el.onclick = () => {
      box.classList.add("hidden"); byId("navSearch").value = "";
      openProject(el.dataset.project);
    });
    box.querySelectorAll("[data-issue]").forEach(el => el.onclick = async () => {
      box.classList.add("hidden"); byId("navSearch").value = "";
      await openProject(el.dataset.projectJump);
      setTab("backlog");
      const issue = issues.find(x => x.id === el.dataset.issue);
      if (issue) openIssueModal(issue);
    });
  }
  box.classList.remove("hidden");
}

// ================= Data loading =================

function isAdmin() {
  return ((currentUser && currentUser.role) || "member").toLowerCase() === "admin";
}

function updateAdminUI() {
  const sidebarInvite = byId("sidebarInviteBtn");
  if (sidebarInvite) {
    sidebarInvite.style.display = isAdmin() ? "block" : "none";
  }
  const inviteOpt = byId("inviteUserOpt");
  if (inviteOpt) {
    inviteOpt.style.display = isAdmin() ? "block" : "none";
  }
}

async function loadInitialData() {
  try {
    const [meData, projectsData, usersData, notificationsData] = await Promise.all([
      api("/users/me").catch(() => null),
      api("/projects"),
      api("/users"),
      api("/notifications")
    ]);
    if (meData) {
      currentUser = meData;
      localStorage.setItem("clove_user", JSON.stringify(currentUser));
    }
    projects = projectsData || [];
    users = usersData || [];
    notifications = notificationsData || [];
    renderSidebarProjects();
    renderNotifications();
    updateAdminUI();
    const pendingProject = localStorage.getItem("clove_open_project");
    if (pendingProject && projects.some(p => p.id === pendingProject)) {
      localStorage.removeItem("clove_open_project");
      openProject(pendingProject);
    } else {
      setView("foryou");
    }
  } catch (e) {
    byId("content").innerHTML = `<div class="card"><h2>Could not load CLOVE</h2><p>${esc(e.message)}</p><p>Make sure FastAPI and MongoDB are running.</p></div>`;
  }
}

function renderNotifications() {
  const unread = notifications.filter(n => !n.read).length;
  const badge = byId("notifBadge");
  badge.textContent = unread;
  badge.classList.toggle("hidden", unread === 0);

  const list = byId("notifList");
  if (!notifications.length) {
    list.innerHTML = `<div class="dropdown-empty">No notifications yet.</div>`;
    return;
  }
  list.innerHTML = notifications.map(n => `
    <div class="notif-item ${n.read ? "" : "unread"}" data-id="${n.id}">
      <span class="unread-dot"></span>
      <div class="n-body">
        <div>${esc(n.message)}</div>
        <div class="n-time">${timeAgo(n.created_at)}</div>
      </div>
    </div>`).join("");
  list.querySelectorAll(".notif-item").forEach(el => el.onclick = async () => {
    const n = notifications.find(x => x.id === el.dataset.id);
    if (n && !n.read) {
      await api(`/notifications/${n.id}/read`, { method: "POST" });
      n.read = true;
      renderNotifications();
    }
  });
}

function renderSidebarProjects() {
  const list = byId("sidebarProjectList");
  list.innerHTML = projects.map(p => `
    <button data-project="${p.id}" class="${p.id === activeProjectId ? "active" : ""}">
      <span>${esc(p.name)}</span><span class="project-mini-key">${esc(p.key)}</span>
    </button>`).join("");
  list.querySelectorAll("[data-project]").forEach(b => b.onclick = () => openProject(b.dataset.project));
}

// ================= View routing =================

function setView(v) {
  disconnectProjectWebSocket();
  stopProjectPolling();
  view = v;
  activeProjectId = null;
  document.querySelectorAll(".sidebar .nav button[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  renderSidebarProjects();

  if (v === "foryou") return renderForYou();
  if (v === "recent") return renderRecent();
  if (v === "starred") return renderStarred();
  if (v === "projects") return renderAllProjects();
  if (v === "team") return renderTeam();
}

async function renderForYou() {
  const c = byId("content");
  c.innerHTML = `<div class="header-row"><div><h1>For You</h1><p class="muted">Tasks assigned to you.</p></div></div><div id="foryouList" class="list"><div class="empty">Loading…</div></div>`;
  try {
    myIssues = await api(`/issues?assignee_id=${encodeURIComponent(currentUser.id)}`);
  } catch { myIssues = []; }

  const list = byId("foryouList");
  if (!myIssues.length) {
    list.innerHTML = `<div class="empty">Nothing assigned to you right now.</div>`;
    return;
  }
  list.innerHTML = myIssues.map(i => `
    <div class="list-item" data-issue="${i.id}" data-project="${i.project_id}" style="cursor:pointer">
      <div><strong>${esc(i.title)}</strong><div class="muted">${esc(findProject(i.project_id)?.name || "")} · ${esc(issueKey(i.project_id, i.id))}</div></div>
      <div>
        ${i.due_date ? `<span class="pill">${esc(formatDate(i.due_date))}</span>` : ""}
        <span class="pill">${esc(i.status)}</span>
      </div>
    </div>`).join("");
  list.querySelectorAll("[data-issue]").forEach(el => el.onclick = async () => {
    await openProject(el.dataset.project);
    setTab("backlog");
    const issue = issues.find(x => x.id === el.dataset.issue);
    if (issue) openIssueModal(issue);
  });
}

function renderRecent() {
  const c = byId("content");
  const recentIds = getRecentIds();
  const recentProjects = recentIds.map(id => findProject(id)).filter(Boolean);
  c.innerHTML = `<div class="header-row"><div><h1>Recent</h1><p class="muted">Projects you've opened recently on this device.</p></div></div>
    <div class="list">${recentProjects.map(projectRow).join("") || '<div class="empty">No recently viewed projects yet.</div>'}</div>`;
  attachProjectRowHandlers();
}

function renderStarred() {
  const c = byId("content");
  const starred = projects.filter(p => p.starred);
  c.innerHTML = `<div class="header-row"><div><h1>Starred</h1><p class="muted">Projects you've starred.</p></div></div>
    <div class="list">${starred.map(projectRow).join("") || '<div class="empty">You haven\'t starred any projects yet.</div>'}</div>`;
  attachProjectRowHandlers();
}

function renderAllProjects() {
  const c = byId("content");
  c.innerHTML = `<div class="header-row"><div><h1>Projects</h1><p class="muted">Create and manage your CLOVE projects.</p></div><button class="primary" onclick="openProjectModal()">+ New Project</button></div>
    <div class="list">${projects.map(projectRow).join("") || '<div class="empty">No projects found.</div>'}</div>`;
  attachProjectRowHandlers();
}

function projectRow(p) {
  return `<div class="list-item" data-project="${p.id}" style="cursor:pointer">
    <div><strong>${esc(p.name)}</strong><div class="muted">${esc(p.description || "")}</div></div>
    <div>${p.starred ? "⭐ " : ""}<span class="pill">${esc(p.key)}</span></div>
  </div>`;
}
function attachProjectRowHandlers() {
  document.querySelectorAll("[data-project]").forEach(el => el.onclick = () => openProject(el.dataset.project));
}

function renderTeam() {
  const c = byId("content");
  c.innerHTML = `
    <div class="header-row">
      <div>
        <h1>My Team</h1>
        <p class="muted">Everyone in this CLOVE workspace.</p>
      </div>
      ${isAdmin() ? `<button class="primary" id="teamInviteBtn">+ Invite User</button>` : ""}
    </div>
    <div class="team-list">${users.map(u => {
      const role = (u.role || "member").toLowerCase();
      return `
      <div class="team-row">
        <div class="team-avatar">${initials(u.name)}</div>
        <div style="flex:1">
          <strong>${esc(u.name)} ${u.id === currentUser.id ? `<span class="muted" style="font-size:12px;font-weight:normal">(You)</span>` : ""}</strong>
          <div class="muted">${esc(u.email)}</div>
        </div>
        <div>
          ${isAdmin() ? `
            <select class="user-role-select" data-user-id="${u.id}">
              <option value="admin" ${role === "admin" ? "selected" : ""}>Admin</option>
              <option value="developer" ${role === "developer" ? "selected" : ""}>Developer</option>
              <option value="member" ${role === "member" ? "selected" : ""}>Member</option>
            </select>
          ` : `
            <span class="role-pill pill-${esc(role)}">${esc(role)}</span>
          `}
        </div>
      </div>`;
    }).join("")}</div>`;

  const inviteBtn = byId("teamInviteBtn");
  if (inviteBtn) inviteBtn.onclick = () => openInviteModal();

  document.querySelectorAll(".user-role-select").forEach(sel => {
    sel.onchange = async (e) => {
      const uid = e.target.dataset.userId;
      const newRole = e.target.value;
      try {
        await api(`/users/${uid}/role`, {
          method: "PUT",
          body: JSON.stringify({ role: newRole })
        });
        const u = users.find(x => x.id === uid);
        if (u) u.role = newRole;
        if (uid === currentUser.id) {
          currentUser.role = newRole;
          localStorage.setItem("clove_user", JSON.stringify(currentUser));
          updateAdminUI();
        }
        renderTeam();
      } catch (err) {
        alert(err.message || "Failed to update user role");
        renderTeam();
      }
    };
  });
}

// ================= Project view =================

async function openProject(projectId) {
  disconnectProjectWebSocket();
  stopProjectPolling();
  view = "project";
  activeProjectId = projectId;
  boardFilters = { priority: "", assignee_id: "" };
  boardGroupBy = "none";
  document.querySelectorAll(".sidebar .nav button[data-view]").forEach(b => b.classList.remove("active"));
  renderSidebarProjects();
  pushRecentId(projectId);

  try {
    issues = await api(`/issues?project_id=${projectId}`);
  } catch {
    issues = [];
  }
  activeTab = "board";
  renderProjectShell();
  connectProjectWebSocket(projectId);
  startProjectPolling(projectId);
}

function renderProjectShell() {
  const p = findProject(activeProjectId);
  if (!p) return;
  const c = byId("content");
  c.innerHTML = `
    <div class="project-title-row">
      <h1 style="margin:0">${esc(p.name)}</h1>
      <span class="pill">${esc(p.key)}</span>
      <button class="star-toggle ${p.starred ? "active" : ""}" id="starToggle" title="Star project">★</button>
      <span style="flex:1"></span>
      ${isAdmin() ? `<button class="secondary" id="projectInviteBtn" style="font-size:13px;padding:6px 12px">+ Invite User</button>` : ""}
    </div>
    <p class="muted" style="margin:4px 0 0">${esc(p.description || "")}</p>
    <div class="project-tabs">
      <button class="tab-btn" data-tab="summary">Summary</button>
      <button class="tab-btn" data-tab="backlog">Backlog</button>
      <button class="tab-btn" data-tab="board">Board</button>
    </div>
    <div id="tabContent"></div>`;

  byId("starToggle").onclick = async () => {
    const res = await api(`/projects/${p.id}/star`, { method: "POST" });
    p.starred = res.starred;
    renderProjectShell();
  };

  const pInviteBtn = byId("projectInviteBtn");
  if (pInviteBtn) pInviteBtn.onclick = () => openInviteModal(p.id);

  document.querySelectorAll(".tab-btn").forEach(b => b.onclick = () => setTab(b.dataset.tab));
  setTab(activeTab);
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "summary") renderSummaryTab();
  if (tab === "backlog") renderBacklogTab();
  if (tab === "board") renderBoardTab();
}

function renderSummaryTab() {
  const p = findProject(activeProjectId);
  const counts = { "To Do": 0, "In Progress": 0, "Done": 0 };
  issues.forEach(i => { if (counts[i.status] !== undefined) counts[i.status]++; });

  byId("tabContent").innerHTML = `
    <p class="summary-desc">${esc(p.description || "No description yet.")}</p>
    <div class="grid">
      <div class="card"><div class="muted">To Do</div><div class="stat">${counts["To Do"]}</div></div>
      <div class="card"><div class="muted">In Progress</div><div class="stat">${counts["In Progress"]}</div></div>
      <div class="card"><div class="muted">Done</div><div class="stat">${counts["Done"]}</div></div>
    </div>`;
}

function renderBacklogTab() {
  const c = byId("tabContent");
  c.innerHTML = `
    <div class="header-row"><div></div><button class="primary" onclick="openIssueModal()">+ New Task</button></div>
    <div class="backlog-head"><div>Task</div><div>Priority</div><div>Status</div><div>Due</div><div>Estimate</div><div>Assignee</div></div>
    <div id="backlogRows"></div>`;
  const rows = byId("backlogRows");
  if (!issues.length) {
    rows.innerHTML = `<div class="empty">No tasks yet. Create one to get started.</div>`;
    return;
  }
  rows.innerHTML = issues.map(i => `
    <div class="backlog-row" data-issue="${i.id}">
      <div class="b-title">${esc(i.title)} <span class="muted">${esc(issueKey(i.project_id, i.id))}</span></div>
      <div><span class="pill">${esc(i.priority)}</span></div>
      <div><span class="pill">${esc(i.status)}</span></div>
      <div>${i.due_date ? esc(formatDate(i.due_date)) : "—"}</div>
      <div>${i.estimation !== undefined && i.estimation !== null ? `<span class="estimate-chip">⏱️ ${esc(String(i.estimation))}d</span>` : "—"}</div>
      <div>${i.assignee_id ? esc(userLabel(i.assignee_id)) : "Unassigned"}</div>
    </div>`).join("");
  rows.querySelectorAll("[data-issue]").forEach(el => el.onclick = () => {
    const issue = issues.find(x => x.id === el.dataset.issue);
    if (issue) openIssueModal(issue);
  });
}

// ================= Realtime & Board Sync =================

function connectProjectWebSocket(projectId) {
  disconnectProjectWebSocket();

  const token = localStorage.getItem("clove_token");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//127.0.0.1:8000/ws/projects/${projectId}?token=${encodeURIComponent(token || "")}`;

  try {
    projectSocket = new WebSocket(wsUrl);

    projectSocket.onopen = () => {
      console.log(`[CLOVE Realtime] WebSocket connected for project ${projectId}`);
      projectPingTimer = setInterval(() => {
        if (projectSocket && projectSocket.readyState === WebSocket.OPEN) {
          projectSocket.send("ping");
        }
      }, 25000);
    };

    projectSocket.onmessage = (event) => {
      try {
        if (event.data === "pong") return;
        const msg = JSON.parse(event.data);
        handleRealtimeMessage(msg);
      } catch (err) {
        console.warn("[CLOVE Realtime] Error parsing message:", err);
      }
    };

    projectSocket.onclose = () => {
      if (projectPingTimer) {
        clearInterval(projectPingTimer);
        projectPingTimer = null;
      }
      projectSocket = null;
      setTimeout(() => {
        if (view === "project" && activeProjectId === projectId) {
          connectProjectWebSocket(projectId);
        }
      }, 2500);
    };

    projectSocket.onerror = (err) => {
      console.warn("[CLOVE Realtime] WebSocket error:", err);
    };
  } catch (e) {
    console.warn("[CLOVE Realtime] Failed to initialize WebSocket:", e);
  }
}

function disconnectProjectWebSocket() {
  if (projectPingTimer) {
    clearInterval(projectPingTimer);
    projectPingTimer = null;
  }
  if (projectSocket) {
    try { projectSocket.close(); } catch {}
    projectSocket = null;
  }
}

function handleRealtimeMessage(msg) {
  if (!msg || !activeProjectId) return;

  if (msg.type === "issue_updated") {
    const updated = msg.issue;
    if (!updated || updated.project_id !== activeProjectId) return;

    const idx = issues.findIndex(i => i.id === updated.id);
    if (idx !== -1) {
      issues[idx] = updated;
    } else {
      issues.unshift(updated);
    }

    if (activeTab === "board") {
      const settings = getBoardSettings(activeProjectId);
      renderBoardColumns(settings.showDueDates !== false);
      highlightCard(updated.id);
    } else if (activeTab === "backlog") {
      renderBacklogTab();
    } else if (activeTab === "summary") {
      renderSummaryTab();
    }
  } else if (msg.type === "issue_created") {
    const created = msg.issue;
    if (!created || created.project_id !== activeProjectId) return;

    if (!issues.some(i => i.id === created.id)) {
      issues.unshift(created);
    }

    if (activeTab === "board") {
      const settings = getBoardSettings(activeProjectId);
      renderBoardColumns(settings.showDueDates !== false);
      highlightCard(created.id);
    } else if (activeTab === "backlog") {
      renderBacklogTab();
    } else if (activeTab === "summary") {
      renderSummaryTab();
    }
  } else if (msg.type === "issue_deleted") {
    issues = issues.filter(i => i.id !== msg.issue_id);

    if (activeTab === "board") {
      const settings = getBoardSettings(activeProjectId);
      renderBoardColumns(settings.showDueDates !== false);
    } else if (activeTab === "backlog") {
      renderBacklogTab();
    } else if (activeTab === "summary") {
      renderSummaryTab();
    }
  } else if (msg.type === "sprint_completed") {
    reloadBoardIssues();
  }
}

function startProjectPolling(projectId) {
  stopProjectPolling();
  projectSyncPollTimer = setInterval(async () => {
    if (document.hidden || view !== "project" || activeProjectId !== projectId) return;

    try {
      const params = new URLSearchParams({ project_id: projectId });
      if (boardFilters.priority) params.set("priority", boardFilters.priority);
      if (boardFilters.assignee_id) params.set("assignee_id", boardFilters.assignee_id);
      const latest = await api(`/issues?${params.toString()}`);

      const currentJson = JSON.stringify(issues.map(i => ({ id: i.id, s: i.status, p: i.priority, a: i.assignee_id, t: i.title, d: i.due_date, est: i.estimation, u: i.updated_at })));
      const latestJson = JSON.stringify(latest.map(i => ({ id: i.id, s: i.status, p: i.priority, a: i.assignee_id, t: i.title, d: i.due_date, est: i.estimation, u: i.updated_at })));

      if (currentJson !== latestJson) {
        issues = latest;
        if (activeTab === "board") {
          const settings = getBoardSettings(activeProjectId);
          renderBoardColumns(settings.showDueDates !== false);
        } else if (activeTab === "backlog") {
          renderBacklogTab();
        } else if (activeTab === "summary") {
          renderSummaryTab();
        }
      }
    } catch {}
  }, 3500);
}

function stopProjectPolling() {
  if (projectSyncPollTimer) {
    clearInterval(projectSyncPollTimer);
    projectSyncPollTimer = null;
  }
}

function highlightCard(issueId) {
  const card = document.querySelector(`.task-card[data-id="${issueId}"]`);
  if (card) {
    card.classList.remove("realtime-pulse");
    void card.offsetWidth;
    card.classList.add("realtime-pulse");
  }
}

async function updateTaskStatus(issueId, newStatus) {
  const issue = issues.find(i => i.id === issueId);
  if (!issue || issue.status === newStatus) return;
  const oldStatus = issue.status;

  // Optimistic update
  issue.status = newStatus;
  const settings = getBoardSettings(activeProjectId);
  renderBoardColumns(settings.showDueDates !== false);
  highlightCard(issueId);

  try {
    const updated = await api(`/issues/${issueId}`, {
      method: "PUT",
      body: JSON.stringify({ status: newStatus }),
    });
    Object.assign(issue, updated);
    renderBoardColumns(settings.showDueDates !== false);
  } catch (err) {
    // Revert optimistic update on failure
    issue.status = oldStatus;
    renderBoardColumns(settings.showDueDates !== false);
    alert(`Could not change task status: ${err.message}`);
  }
}

function renderBoardTab() {
  const c = byId("tabContent");
  const settings = getBoardSettings(activeProjectId);
  const showDue = settings.showDueDates !== false;

  c.innerHTML = `
    <div class="board-actions">
      <select id="filterPriority">
        <option value="">All priorities</option>
        <option value="Low">Low</option>
        <option value="Medium">Medium</option>
        <option value="High">High</option>
        <option value="Critical">Critical</option>
      </select>
      <select id="filterAssignee">
        <option value="">All assignees</option>
        ${users.map(u => `<option value="${u.id}">${esc(u.name)} (${esc(u.role || "member")})</option>`).join("")}
      </select>
      <select id="groupBy">
        <option value="none">No grouping</option>
        <option value="assignee">Group by assignee</option>
        <option value="priority">Group by priority</option>
      </select>
      <span class="spacer"></span>
      <button class="secondary" id="completeSprintBtn">Complete Sprint</button>
      <button class="secondary" id="boardSettingsBtn">Board Settings</button>
      <button class="primary" onclick="openIssueModal()">+ Create Task</button>
    </div>
    <div class="board-columns">
      ${["To Do", "In Progress", "Done"].map(status => `
        <div class="board-column" data-status="${status}">
          <div class="board-col-head"><h4>${status}</h4><span class="col-count" data-count="${status}">0</span></div>
          <div class="col-dropzone" data-status="${status}"></div>
        </div>`).join("")}
    </div>`;

  byId("filterPriority").value = boardFilters.priority;
  byId("filterAssignee").value = boardFilters.assignee_id;
  byId("groupBy").value = boardGroupBy;

  byId("filterPriority").onchange = async (e) => { boardFilters.priority = e.target.value; await reloadBoardIssues(); };
  byId("filterAssignee").onchange = async (e) => { boardFilters.assignee_id = e.target.value; await reloadBoardIssues(); };
  byId("groupBy").onchange = (e) => { boardGroupBy = e.target.value; renderBoardColumns(showDue); };

  byId("completeSprintBtn").onclick = async () => {
    if (!confirm("Complete sprint? This archives every task currently in Done, clearing them from the board.")) return;
    const res = await api(`/issues/complete-sprint?project_id=${activeProjectId}`, { method: "POST" });
    await reloadBoardIssues();
    alert(`Archived ${res.archived_count} completed task(s).`);
  };

  byId("boardSettingsBtn").onclick = () => openBoardSettingsModal();

  renderBoardColumns(showDue);
}

async function reloadBoardIssues() {
  const params = new URLSearchParams({ project_id: activeProjectId });
  if (boardFilters.priority) params.set("priority", boardFilters.priority);
  if (boardFilters.assignee_id) params.set("assignee_id", boardFilters.assignee_id);
  issues = await api(`/issues?${params.toString()}`);
  const settings = getBoardSettings(activeProjectId);
  renderBoardColumns(settings.showDueDates !== false);
}

function renderBoardColumns(showDue) {
  ["To Do", "In Progress", "Done"].forEach(status => {
    const zone = document.querySelector(`.col-dropzone[data-status="${status}"]`);
    const countBadge = document.querySelector(`.col-count[data-count="${status}"]`);
    if (!zone || !countBadge) return;

    const columnIssues = issues.filter(i => i.status === status);
    countBadge.textContent = columnIssues.length;

    if (!columnIssues.length) {
      zone.innerHTML = `<div class="empty-column">No tasks here.</div>`;
      return;
    }

    if (boardGroupBy === "none") {
      zone.innerHTML = columnIssues.map(i => taskCardHtml(i, showDue)).join("");
    } else {
      const groups = {};
      columnIssues.forEach(i => {
        const key = boardGroupBy === "assignee" ? (i.assignee_id ? userLabel(i.assignee_id) : "Unassigned") : i.priority;
        (groups[key] = groups[key] || []).push(i);
      });
      zone.innerHTML = Object.keys(groups).sort().map(key => `
        <div class="group-heading">${esc(key)}</div>
        ${groups[key].map(i => taskCardHtml(i, showDue)).join("")}`).join("");
    }
  });

  document.querySelectorAll(".board-columns .task-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (isDraggingCard) return;
      if (e.target.closest(".card-status-select")) return;
      const issue = issues.find(x => x.id === card.dataset.id);
      if (issue) openIssueModal(issue);
    });

    card.addEventListener("dragstart", (e) => {
      isDraggingCard = true;
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", card.dataset.id);
      e.dataTransfer.effectAllowed = "move";
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      setTimeout(() => { isDraggingCard = false; }, 80);
    });

    const statusSel = card.querySelector(".card-status-select");
    if (statusSel) {
      statusSel.addEventListener("change", async (e) => {
        e.stopPropagation();
        const newStatus = e.target.value;
        const issueId = card.dataset.id;
        await updateTaskStatus(issueId, newStatus);
      });
    }
  });

  setupDropzones();
}

function taskCardHtml(i, showDue) {
  const overdue = i.status !== "Done" && isOverdue(i.due_date);
  return `
    <div class="task-card" draggable="true" data-id="${i.id}" data-priority="${esc(i.priority)}">
      <div class="task-card-header">
        <span class="task-key">${esc(issueKey(i.project_id, i.id))}</span>
        <select class="card-status-select" data-id="${i.id}" title="Change status" onclick="event.stopPropagation()">
          ${["To Do", "In Progress", "Done"].map(s => `<option value="${s}" ${i.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
      <div class="task-card-title">${esc(i.title)}</div>
      <div class="task-card-meta">
        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
          ${showDue && i.due_date ? `<span class="due-chip ${overdue ? "overdue" : ""}">${esc(formatDate(i.due_date))}</span>` : ""}
          ${i.estimation !== undefined && i.estimation !== null ? `<span class="estimate-chip" title="Estimation: ${esc(String(i.estimation))} days">⏱️ ${esc(String(i.estimation))}d</span>` : ""}
        </div>
        ${i.assignee_id ? `<span class="assignee-chip">${esc(initials(userLabel(i.assignee_id)))}</span>` : "<span></span>"}
      </div>
    </div>`;
}

function setupDropzones() {
  document.querySelectorAll(".board-column").forEach(col => {
    const targetStatus = col.dataset.status;

    col.ondragover = e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      col.classList.add("drag-over");
    };

    col.ondragleave = e => {
      if (!col.contains(e.relatedTarget)) {
        col.classList.remove("drag-over");
      }
    };

    col.ondrop = async e => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const issueId = e.dataTransfer.getData("text/plain");
      if (!issueId) return;

      const issue = issues.find(i => i.id === issueId);
      if (!issue || issue.status === targetStatus) return;

      await updateTaskStatus(issueId, targetStatus);
    };
  });
}

// ================= Board settings modal =================

function openBoardSettingsModal() {
  const settings = getBoardSettings(activeProjectId);
  const showDue = settings.showDueDates !== false;
  byId("modal-root").innerHTML = `
    <div class="modal"><div class="modal-card">
      <div class="modal-head"><h2>Board Settings</h2><button class="close" onclick="closeModal()">×</button></div>
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:16px">
        <input type="checkbox" id="showDueDatesCheck" ${showDue ? "checked" : ""} style="width:auto;margin:0">
        Show due dates on task cards
      </label>
      <p class="muted" style="margin-top:8px">This preference is saved on this device only.</p>
      <div class="actions"><button class="primary" onclick="closeModal()">Done</button></div>
    </div></div>`;
  byId("showDueDatesCheck").onchange = (e) => {
    setBoardSettings(activeProjectId, { ...settings, showDueDates: e.target.checked });
    renderBoardColumns(e.target.checked);
  };
}

// ================= Settings modal (profile) =================

function openSettingsModal() {
  closeAllDropdowns();
  byId("modal-root").innerHTML = `
    <div class="modal"><div class="modal-card">
      <div class="modal-head"><h2>Settings</h2><button class="close" onclick="closeModal()">×</button></div>
      <form id="settingsForm">
        <label>Display name<input id="settingsName" value="${esc(currentUser.name)}" required></label>
        <label>Email<input value="${esc(currentUser.email)}" disabled></label>
        <div class="actions"><button type="button" class="secondary" onclick="closeModal()">Cancel</button><button class="primary">Save</button></div>
      </form>
    </div></div>`;
  byId("settingsForm").onsubmit = async e => {
    e.preventDefault();
    try {
      const updated = await api("/users/me", { method: "PUT", body: JSON.stringify({ name: byId("settingsName").value }) });
      currentUser.name = updated.name;
      localStorage.setItem("clove_user", JSON.stringify(currentUser));
      closeModal();
      shell();
      await loadInitialData();
      if (activeProjectId) openProject(activeProjectId);
    } catch (err) { alert(err.message); }
  };
}

// ================= Project / Task modals =================

function openProjectModal() {
  closeAllDropdowns();
  byId("modal-root").innerHTML = `<div class="modal"><div class="modal-card"><div class="modal-head"><h2>New Project</h2><button class="close" onclick="closeModal()">×</button></div>
  <form id="projectForm"><label>Project name<input id="pname" required></label><label>Project key<input id="pkey" required maxlength="10"></label><label>Description<textarea id="pdesc"></textarea></label><div class="actions"><button type="button" class="secondary" onclick="closeModal()">Cancel</button><button class="primary">Create</button></div></form></div></div>`;
  byId("projectForm").onsubmit = async e => {
    e.preventDefault();
    try {
      const project = await api("/projects", { method: "POST", body: JSON.stringify({ name: pname.value, key: pkey.value, description: pdesc.value }) });
      projects.push(project);
      closeModal();
      renderSidebarProjects();
      openProject(project.id);
    } catch (err) { alert(err.message); }
  };
}

async function openIssueModal(existing) {
  closeAllDropdowns();
  if (!existing && !activeProjectId && !projects.length) return alert("Create a project first.");
  await refreshUsers();
  const projectId = existing ? existing.project_id : activeProjectId;
  const isEdit = !!existing;
  const todayStr = getTodayString();

  byId("modal-root").innerHTML = `<div class="modal"><div class="modal-card modal-task-card">
    <div class="modal-head task-modal-head">
      <div class="task-modal-title-row">
        ${isEdit && existing ? `<span class="task-key-badge">${esc(issueKey(existing.project_id, existing.id))}</span>` : ""}
        <h2>${isEdit ? "Edit Task" : "New Task"}</h2>
      </div>
      <button type="button" class="close" onclick="closeModal()">×</button>
    </div>
    <div id="taskErrorBox" class="form-error-banner hidden"></div>
    <form id="issueForm" class="task-modal-form" novalidate>
      <div class="task-modal-grid">
        <div class="task-modal-col-main">
          ${!isEdit && !activeProjectId ? `
            <label class="task-form-field">
              <span>Project<span class="req-star">*</span></span>
              <select id="iproject">
                ${projects.map(p => `<option value="${p.id}">${esc(p.key)} — ${esc(p.name)}</option>`).join("")}
              </select>
            </label>` : ""}
          <label class="task-form-field">
            <span>Task Title<span class="req-star">*</span></span>
            <input id="ititle" placeholder="Enter task title" value="${isEdit ? esc(existing.title) : ""}">
          </label>
          <label class="task-form-field ${isEdit ? "task-field-desc" : "task-field-desc-new"}">
            <span>Description<span class="req-star">*</span></span>
            <textarea id="idesc" placeholder="Enter task description">${isEdit ? esc(existing.description || "") : ""}</textarea>
          </label>
          ${isEdit ? `
            <div class="task-comments-wrapper">
              <div class="task-comments-title">Comments</div>
              <div id="commentList" class="comment-list-scroll"></div>
              <div class="comment-add-row">
                <input id="commentInput" placeholder="Add a comment…" autocomplete="off">
                <button type="button" class="secondary" id="commentBtn">Post</button>
              </div>
            </div>` : ""}
        </div>
        <div class="task-modal-col-side">
          <div class="task-side-card">
            <div class="task-side-title">Task Details</div>
            <label class="task-form-field">
              <span>Status<span class="req-star">*</span></span>
              <select id="istatus">
                ${["To Do", "In Progress", "Done"].map(s => `<option ${isEdit && existing.status === s ? "selected" : ""}>${s}</option>`).join("")}
              </select>
            </label>
            <label class="task-form-field">
              <span>Priority<span class="req-star">*</span></span>
              <select id="ipriority">
                ${["Low", "Medium", "High", "Critical"].map(p => `<option ${isEdit ? (existing.priority === p ? "selected" : "") : (p === "Medium" ? "selected" : "")}>${p}</option>`).join("")}
              </select>
            </label>
            <label class="task-form-field">
              <span>Due Date<span class="req-star">*</span></span>
              <input type="date" id="idue" min="${todayStr}" value="${isEdit && existing.due_date ? existing.due_date : ""}">
            </label>
            <label class="task-form-field">
              <span>Estimation (Days)<span class="req-star">*</span></span>
              <input type="number" id="iestimation" step="any" min="0.01" placeholder="e.g. 1, 2, 3.5" value="${isEdit && existing.estimation != null ? existing.estimation : ""}">
            </label>
            <label class="task-form-field">
              <span>Assignee<span class="opt-label">(Optional)</span></span>
              <select id="iassignee">
                <option value="">Unassigned</option>
                ${users.map(u => `<option value="${u.id}" ${isEdit && existing.assignee_id === u.id ? "selected" : ""}>${esc(u.name)} (${esc(u.role || "member")})</option>`).join("")}
              </select>
            </label>
          </div>
        </div>
      </div>
      <div class="actions task-modal-actions">
        ${isEdit ? `<button type="button" class="danger-btn" id="deleteIssueBtn">Delete</button>` : ""}
        <span style="flex:1"></span>
        <button type="button" class="secondary" onclick="closeModal()">Cancel</button>
        <button type="submit" class="primary">${isEdit ? "Save changes" : "Create"}</button>
      </div>
    </form>
  </div></div>`;

  const errorBox = byId("taskErrorBox");
  const clearError = () => {
    errorBox.classList.add("hidden");
    errorBox.textContent = "";
    document.querySelectorAll("#issueForm .field-invalid").forEach(el => el.classList.remove("field-invalid"));
  };
  const showError = (msg, inputId) => {
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
    if (inputId) {
      const el = byId(inputId);
      if (el) {
        el.classList.add("field-invalid");
        el.focus();
      }
    }
    errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  ["ititle", "idesc", "istatus", "ipriority", "idue", "iestimation"].forEach(id => {
    const el = byId(id);
    if (el) {
      el.addEventListener("input", () => {
        el.classList.remove("field-invalid");
        if (errorBox.textContent) clearError();
      });
      el.addEventListener("change", () => {
        el.classList.remove("field-invalid");
        if (errorBox.textContent) clearError();
      });
    }
  });

  byId("issueForm").onsubmit = async e => {
    e.preventDefault();
    clearError();

    const titleVal = byId("ititle").value.trim();
    if (!titleVal) {
      showError("Task Title is required.", "ititle");
      return;
    }

    const descVal = byId("idesc").value.trim();
    if (!descVal) {
      showError("Description is required.", "idesc");
      return;
    }

    const statusVal = byId("istatus").value;
    if (!statusVal) {
      showError("Status is required.", "istatus");
      return;
    }

    const priorityVal = byId("ipriority").value;
    if (!priorityVal) {
      showError("Priority is required.", "ipriority");
      return;
    }

    const dueVal = byId("idue").value;
    if (!dueVal) {
      showError("Due Date is required.", "idue");
      return;
    }
    if (dueVal < todayStr) {
      showError("Due Date must be today or an upcoming date.", "idue");
      return;
    }

    const estVal = byId("iestimation").value.trim();
    if (!estVal) {
      showError("Estimation (Days) is required.", "iestimation");
      return;
    }
    const estNum = parseFloat(estVal);
    if (isNaN(estNum) || estNum <= 0) {
      showError("Estimation (Days) must be a positive number (e.g. 1, 2, 3.5).", "iestimation");
      return;
    }

    const payload = {
      title: titleVal,
      description: descVal,
      status: statusVal,
      priority: priorityVal,
      due_date: dueVal,
      estimation: estNum,
      assignee_id: byId("iassignee").value || null,
    };

    try {
      if (isEdit) {
        const updated = await api(`/issues/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) });
        Object.assign(existing, updated);
        const idx = issues.findIndex(i => i.id === existing.id);
        if (idx !== -1) issues[idx] = existing;
      } else {
        payload.project_id = activeProjectId || (byId("iproject") ? byId("iproject").value : null);
        const created = await api("/issues", { method: "POST", body: JSON.stringify(payload) });
        if (created.project_id === activeProjectId && !issues.some(i => i.id === created.id)) {
          issues.unshift(created);
        }
      }
      closeModal();
      if (activeProjectId) setTab(activeTab);
    } catch (err) {
      showError(err.message || "An error occurred while saving.");
    }
  };

  if (isEdit) {
    byId("deleteIssueBtn").onclick = async () => {
      if (!confirm("Delete this task? This cannot be undone.")) return;
      try {
        await api(`/issues/${existing.id}`, { method: "DELETE" });
        issues = issues.filter(i => i.id !== existing.id);
        closeModal();
        if (activeProjectId) setTab(activeTab);
      } catch (err) { alert(err.message); }
    };
    loadComments(existing.id);
    byId("commentBtn").onclick = async () => {
      const body = byId("commentInput").value.trim();
      if (!body) return;
      try {
        await api("/comments", { method: "POST", body: JSON.stringify({ issue_id: existing.id, body }) });
        byId("commentInput").value = "";
        loadComments(existing.id);
      } catch (err) { alert(err.message); }
    };
    byId("commentInput").onkeydown = e => {
      if (e.key === "Enter") {
        e.preventDefault();
        byId("commentBtn").click();
      }
    };
  }
}

async function loadComments(issueId) {
  const box = byId("commentList");
  box.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    const comments = await api(`/comments/${issueId}`);
    if (!comments.length) { box.innerHTML = `<div class="muted">No comments yet.</div>`; return; }
    box.innerHTML = comments.map(c => `
      <div class="comment-item">
        <div class="c-meta">${esc(userLabel(c.user_id))} · ${timeAgo(c.created_at)}</div>
        <div>${esc(c.body)}</div>
      </div>`).join("");
  } catch (err) {
    box.innerHTML = `<div class="muted">Couldn't load comments.</div>`;
  }
}

function openInviteModal(projectId = null) {
  closeAllDropdowns();
  if (!isAdmin()) {
    alert("Only Admin users can invite new users.");
    return;
  }
  const project = projectId ? findProject(projectId) : null;
  const modalRoot = byId("modal-root");

  modalRoot.innerHTML = `
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h2>Invite User</h2>
          <button class="close" onclick="closeModal()">×</button>
        </div>
        <p class="muted" style="margin:4px 0 16px">
          ${project ? `Generate a unique invitation link to join <strong>${esc(project.name)}</strong>.` : "Generate a unique invitation link for a new member."}
        </p>
        <form id="inviteForm">
          <label>Select Role
            <select id="inviteRole" required>
              <option value="member" selected>Member</option>
              <option value="developer">Developer</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label>Link Expiration
            <select id="inviteExpires">
              <option value="24">24 Hours</option>
              <option value="168" selected>7 Days</option>
              <option value="720">30 Days</option>
            </select>
          </label>
          <div class="actions">
            <button type="button" class="secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="primary" id="generateInviteBtn">Generate Invite Link</button>
          </div>
        </form>
      </div>
    </div>
  `;

  byId("inviteForm").onsubmit = async (e) => {
    e.preventDefault();
    const roleSelect = byId("inviteRole");
    const role = roleSelect.value;
    const roleLabel = roleSelect.options[roleSelect.selectedIndex].text;
    const expiresInHours = parseInt(byId("inviteExpires").value, 10) || 168;
    const submitBtn = byId("generateInviteBtn");
    submitBtn.disabled = true;
    submitBtn.textContent = "Generating...";

    try {
      const res = await api("/invitations", {
        method: "POST",
        body: JSON.stringify({
          role: role,
          project_id: projectId || undefined,
          expires_in_hours: expiresInHours
        })
      });

      // Construct frontend shareable invite URL
      const currentOrigin = window.location.origin;
      const pathname = window.location.pathname;
      const basePath = pathname.substring(0, pathname.lastIndexOf('/') + 1);
      const inviteUrl = `${currentOrigin}${basePath}invite.html?token=${encodeURIComponent(res.token)}`;

      modalRoot.innerHTML = `
        <div class="modal">
          <div class="modal-card">
            <div class="modal-head">
              <h2>Invitation Created</h2>
              <button class="close" onclick="closeModal()">×</button>
            </div>
            <div class="invite-box">
              <div class="invite-created-role">Role: <strong>${esc(roleLabel)}</strong></div>
              <div class="invite-link-row">
                <input id="inviteUrlInput" readonly value="${esc(inviteUrl)}">
                <button class="primary" id="copyInviteBtn" type="button" style="white-space:nowrap">Copy Link</button>
              </div>
            </div>
            <div class="actions">
              <button type="button" class="secondary" onclick="closeModal()">Done</button>
            </div>
          </div>
        </div>
      `;

      byId("copyInviteBtn").onclick = async () => {
        const input = byId("inviteUrlInput");
        try {
          await navigator.clipboard.writeText(input.value);
        } catch {
          input.select();
          document.execCommand("copy");
        }
        const btn = byId("copyInviteBtn");
        btn.textContent = "Copied!";
        btn.style.background = "#15803d";
        setTimeout(() => {
          if (byId("copyInviteBtn")) {
            btn.textContent = "Copy Link";
            btn.style.background = "";
          }
        }, 2000);
      };

    } catch (err) {
      alert(err.message || "Failed to create invitation");
      closeModal();
    }
  };
}

function closeModal() { byId("modal-root").innerHTML = ""; }

// ================= Boot =================

shell();
loadInitialData();
