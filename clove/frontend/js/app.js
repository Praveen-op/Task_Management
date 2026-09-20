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
if (typeof window.byId !== "function") {
  window.byId = (id) => document.getElementById(id);
}
const app = byId("app");

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
let activeModalIssueId = null;
let modalCommentTimer = null;

let sidebarCollapsed = localStorage.getItem("clove_sidebar_collapsed") === "true";

// ---------- Modern Toast Notifications ----------
function showToast(message, type = "info", duration = 3500) {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  let iconSrc = "image/bolt.svg";
  if (type === "success") iconSrc = "image/check-circle.svg";
  else if (type === "error") iconSrc = "image/close.svg";
  else if (type === "info") iconSrc = "image/bell.svg";

  toast.innerHTML = `
    <div class="toast-icon-wrap">
      <img src="${iconSrc}" class="app-icon" alt="">
    </div>
    <div class="toast-message">${esc(message)}</div>
    <button class="toast-close-btn" type="button" title="Dismiss">
      <img src="image/close.svg" class="app-icon" style="width:12px;height:12px;" alt="">
    </button>
  `;

  const dismiss = () => {
    if (toast.classList.contains("toast-hiding")) return;
    toast.classList.add("toast-hiding");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 200);
  };

  toast.querySelector(".toast-close-btn").onclick = (e) => {
    e.stopPropagation();
    dismiss();
  };

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

// ---------- Modern Confirmation Modal ----------
function showConfirm(options = {}) {
  return new Promise((resolve) => {
    const title = options.title || "Confirm Action";
    const message = options.message || "Are you sure you want to continue?";
    const confirmText = options.confirmText || "Confirm";
    const cancelText = options.cancelText || "Cancel";
    const danger = Boolean(options.danger);
    const type = options.type || (danger ? "danger" : "info");

    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    let iconSvg = "";
    if (danger) {
      iconSvg = `<img src="image/trash.svg" class="app-icon" alt="">`;
    } else if (type === "success") {
      iconSvg = `<img src="image/check-circle.svg" class="app-icon" alt="">`;
    } else {
      iconSvg = `<img src="image/bolt.svg" class="app-icon" alt="">`;
    }

    overlay.innerHTML = `
      <div class="confirm-dialog" role="dialog" aria-modal="true">
        <div class="confirm-header">
          <div class="confirm-icon-wrap ${type}">
            ${iconSvg}
          </div>
          <div style="flex:1;min-width:0;">
            <h3 class="confirm-title">${esc(title)}</h3>
            <p class="confirm-message">${esc(message)}</p>
          </div>
        </div>
        <div class="confirm-actions">
          <button class="secondary confirm-cancel-btn" type="button">${esc(cancelText)}</button>
          <button class="${danger ? "danger-btn" : "primary"} confirm-ok-btn" type="button">${esc(confirmText)}</button>
        </div>
      </div>
    `;

    const cleanup = (result) => {
      document.removeEventListener("keydown", handleKeyDown);
      overlay.classList.add("confirm-hiding");
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 150);
      resolve(result);
    };

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === "Enter") {
        const active = document.activeElement;
        if (active && active.classList.contains("confirm-cancel-btn")) {
          e.preventDefault();
          cleanup(false);
        } else {
          e.preventDefault();
          cleanup(true);
        }
      }
    };

    overlay.querySelector(".confirm-cancel-btn").onclick = () => cleanup(false);
    overlay.querySelector(".confirm-ok-btn").onclick = () => cleanup(true);
    overlay.onclick = (e) => {
      if (e.target === overlay) cleanup(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector(".confirm-ok-btn");
    if (okBtn) okBtn.focus();
  });
}

// Global safety replacements
window.alert = (msg) => showToast(msg, "info");
window.showToast = showToast;
window.showConfirm = showConfirm;

// ---------- Sidebar State & Floating Tooltip Helpers ----------
function updateSidebarState(collapsed) {
  sidebarCollapsed = collapsed;
  localStorage.setItem("clove_sidebar_collapsed", String(collapsed));

  const appEl = document.querySelector(".app");
  if (appEl) {
    appEl.classList.toggle("sidebar-collapsed", collapsed);
  }
  const sidebar = byId("sidebar");
  if (sidebar) {
    sidebar.classList.toggle("collapsed", collapsed);
  }
  const navZone = byId("navbarSidebarZone");
  if (navZone) {
    navZone.classList.toggle("collapsed", collapsed);
  }

  const topbarBtn = byId("topbarSidebarToggle");
  if (topbarBtn) {
    topbarBtn.title = "Collapse Sidebar";
    topbarBtn.setAttribute("aria-label", "Collapse Sidebar");
    topbarBtn.setAttribute("data-tooltip", "Collapse Sidebar");
  }

  const expandBtn = byId("sidebarExpandBtn");
  if (expandBtn) {
    expandBtn.title = "Expand Sidebar";
    expandBtn.setAttribute("aria-label", "Expand Sidebar");
    expandBtn.setAttribute("data-tooltip", "Expand Sidebar");
  }

  // Hide floating tooltip immediately on toggle
  const tooltipEl = byId("sidebarFloatingTooltip");
  if (tooltipEl) tooltipEl.classList.add("hidden");
}

function attachSidebarTooltips() {
  let tooltipEl = byId("sidebarFloatingTooltip");
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.id = "sidebarFloatingTooltip";
    tooltipEl.className = "sidebar-floating-tooltip hidden";
    document.body.appendChild(tooltipEl);
  }

  const sidebar = byId("sidebar");
  if (!sidebar) return;

  const showTooltip = (target) => {
    if (!sidebar.classList.contains("collapsed")) return;
    const text = target.getAttribute("data-tooltip");
    if (!text) return;

    tooltipEl.textContent = text;
    tooltipEl.classList.remove("hidden");

    const rect = target.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    const top = rect.top + (rect.height - tooltipRect.height) / 2;
    const left = rect.right + 10;

    tooltipEl.style.top = `${Math.max(8, top)}px`;
    tooltipEl.style.left = `${left}px`;
  };

  const hideTooltip = () => {
    tooltipEl.classList.add("hidden");
  };

  sidebar.onmouseover = (e) => {
    const item = e.target.closest("[data-tooltip]");
    if (item && sidebar.contains(item)) {
      showTooltip(item);
    } else {
      hideTooltip();
    }
  };

  sidebar.onmouseout = (e) => {
    const item = e.target.closest("[data-tooltip]");
    if (item && !item.contains(e.relatedTarget)) {
      hideTooltip();
    }
  };

  const topbarBtn = byId("topbarSidebarToggle");
  if (topbarBtn) {
    topbarBtn.onmouseenter = () => {
      if (sidebar.classList.contains("collapsed")) {
        showTooltip(topbarBtn);
      }
    };
    topbarBtn.onmouseleave = hideTooltip;
  }
}

// ---------- Theme Management (Light #FFFBF7 / Dark #14100D) ----------
function initTheme() {
  const saved = localStorage.getItem("clove_theme") || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", saved);
}
initTheme();

function toggleTheme() {
  const curr = document.documentElement.getAttribute("data-theme") || "light";
  const next = curr === "dark" ? "light" : "dark";
  setTheme(next);
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("clove_theme", theme);
  updateThemeToggleButtons();
}

function updateThemeToggleButtons() {
  const curr = document.documentElement.getAttribute("data-theme") || "light";
  document.querySelectorAll(".theme-toggle-btn").forEach(btn => {
    btn.innerHTML = curr === "dark"
      ? `<img src="image/sun.svg" class="app-icon theme-icon" alt=""> Light Mode`
      : `<img src="image/moon.svg" class="app-icon theme-icon" alt=""> Dark Mode`;
  });
}

async function refreshUsers() {
  try {
    const data = await api("/users");
    if (data && Array.isArray(data)) users = data;
  } catch {}
}

// ---------- Small helpers ----------
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m])); }
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function findProject(idOrKey) {
  if (!idOrKey) return null;
  const str = String(idOrKey).trim();
  let p = projects.find(x => x.id === str);
  if (p) return p;
  p = projects.find(x => x.key && x.key.toLowerCase() === str.toLowerCase());
  if (p) return p;
  p = projects.find(x => x.name && (x.name.toLowerCase() === str.toLowerCase() || slugify(x.name) === str.toLowerCase()));
  return p || null;
}
function findUser(id) { return users.find(u => u.id === id); }
function userLabel(id) { const u = findUser(id); return u ? u.name : "Unassigned"; }
function initials(name) { return (name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase(); }
function issueKey(issueOrProjectId, maybeIssueId) {
  let issueObj = null;
  let projectId = null;
  let issueId = null;

  if (typeof issueOrProjectId === "object" && issueOrProjectId !== null) {
    issueObj = issueOrProjectId;
    projectId = issueObj.project_id;
    issueId = issueObj.id;
  } else {
    projectId = issueOrProjectId;
    issueId = maybeIssueId;
    if (typeof maybeIssueId === "object" && maybeIssueId !== null) {
      issueObj = maybeIssueId;
    } else if (Array.isArray(issues)) {
      issueObj = issues.find(x => x.id === issueId);
    }
  }

  const p = findProject(projectId);
  const prefix = p ? p.key : "ISS";

  if (issueObj && issueObj.key) {
    return issueObj.key;
  }
  if (issueObj && issueObj.number != null) {
    return `${prefix}-${issueObj.number}`;
  }

  if (Array.isArray(issues) && issues.length) {
    const sorted = [...issues].sort((a, b) => (a.created_at || a.id || "").localeCompare(b.created_at || b.id || ""));
    const idx = sorted.findIndex(x => x.id === issueId);
    if (idx !== -1) {
      return `${prefix}-${idx + 1}`;
    }
  }

  return `${prefix}-1`;
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
  if (!iso) return "just now";
  let s = String(iso).trim();
  if (!s.endsWith("Z") && !s.includes("+") && !s.includes("-", 10)) {
    s += "Z";
  }
  const dateMs = new Date(s).getTime();
  if (isNaN(dateMs)) return "just now";
  const diffMs = Date.now() - dateMs;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatEstimation(val) {
  if (val === undefined || val === null || val === "") return "";
  const num = Math.round(Number(val));
  if (isNaN(num) || num <= 0) return String(val);
  return `${num} ${num === 1 ? "day" : "days"}`;
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
  <div class="app ${sidebarCollapsed ? "sidebar-collapsed" : ""}">
    <header class="navbar">
      <div class="navbar-sidebar-zone ${sidebarCollapsed ? "collapsed" : ""}" id="navbarSidebarZone">
        <div class="brand-small" onclick="setView('foryou')" title="CLOVE Home" data-tooltip="CLOVE Home" style="cursor:pointer;">
          <svg viewBox="-65 -80 130 160" width="28" height="34" style="flex-shrink:0; overflow:visible;">
            <defs>
              <linearGradient id="cloveNavBudGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#FF5F0A"/>
                <stop offset="1" stop-color="#FF9F1C"/>
              </linearGradient>
            </defs>
            <g transform="rotate(35) translate(-40 -84)">
              <circle cx="40" cy="40" r="32" fill="url(#cloveNavBudGrad)"/>
              <path d="M28 88 L52 88 L40 168 Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>
            </g>
          </svg>
          <span class="brand-wordmark">clove</span>
        </div>
        <button class="icon-btn sidebar-topbar-toggle" id="topbarSidebarToggle" title="Collapse Sidebar" aria-label="Collapse Sidebar" data-tooltip="Collapse Sidebar">
          <svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
            <path class="sidebar-toggle-arrow" d="M14 9l-3 3 3 3"></path>
          </svg>
        </button>
      </div>

      <div class="nav-search">
        <input id="navSearch" type="text" placeholder="Search projects and tasks...">
        <div id="searchResults" class="search-results hidden"></div>
      </div>

      <div class="nav-actions">
        <div class="dropdown-wrap">
          <button class="primary" id="createBtn" title="Create New"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> Create</button>
          <div class="dropdown-panel create-menu hidden" id="createMenu">
            <div class="dropdown-list">
              <button id="createProjectOpt"><img src="image/folder-plus.svg" class="app-icon menu-icon" alt=""> New Project</button>
              <button id="createTaskOpt"><img src="image/task.svg" class="app-icon menu-icon" alt=""> New Task</button>
            </div>
          </div>
        </div>

        <div class="dropdown-wrap">
          <button class="icon-btn" id="notifBtn" title="Notifications">
            <img src="image/bell.svg" class="app-icon nav-btn-icon" alt="Notifications"><span id="notifBadge" class="badge-dot hidden">0</span>
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
          <button class="profile-btn" id="profileBtn" title="Profile">${initials(currentUser.name)}</button>
          <div class="dropdown-panel hidden" id="profilePanel">
            <div class="profile-panel">
              <div class="p-name">${esc(currentUser.name)}</div>
              <div class="p-email">${esc(currentUser.email)}</div>
              <hr>
              <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0 10px;">
                <span style="font-size:12px;font-weight:600;color:var(--text-secondary);">Theme</span>
                <button type="button" class="theme-toggle-btn" id="themeToggleBtn"><img src="image/moon.svg" class="app-icon theme-icon" alt=""> Dark Mode</button>
              </div>
              <hr>
              <button class="secondary full" id="logoutBtn">Logout</button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <div class="layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}">
      <aside class="sidebar ${sidebarCollapsed ? "collapsed" : ""}" id="sidebar">
        <div class="sidebar-expand-row" id="sidebarExpandRow">
          <button class="icon-btn sidebar-expand-btn" id="sidebarExpandBtn" title="Expand Sidebar" aria-label="Expand Sidebar" data-tooltip="Expand Sidebar">
            <svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="9" y1="3" x2="9" y2="21"></line>
              <path class="sidebar-toggle-arrow" d="M11 9l3 3-3 3"></path>
            </svg>
          </button>
        </div>

        <div class="nav-section-title">Home</div>
        <div class="nav">
          <button class="small" data-view="foryou" data-tooltip="For You"><img src="image/home.svg" class="app-icon nav-icon" alt=""> <span class="nav-text">For You</span></button>
          <button class="small" data-view="recent" data-tooltip="Recent"><img src="image/history.svg" class="app-icon nav-icon" alt=""> <span class="nav-text">Recent</span></button>
          <button class="small" data-view="starred" data-tooltip="Starred"><img src="image/star.svg" class="app-icon nav-icon" alt=""> <span class="nav-text">Starred</span></button>
        </div>

        <div class="nav-section-divider"></div>
        <div class="nav-section-title">Projects</div>
        <div class="nav">
          <button class="small" data-view="projects" data-tooltip="All Projects"><img src="image/folder.svg" class="app-icon nav-icon" alt=""> <span class="nav-text">All Projects</span></button>
        </div>
        <div class="project-mini-list" id="sidebarProjectList"></div>

        <div class="nav-section-divider"></div>
        <div class="nav-section-title">Team</div>
        <div class="nav">
          <button class="small" data-view="team" data-tooltip="My Team"><img src="image/users.svg" class="app-icon nav-icon" alt=""> <span class="nav-text">My Team</span></button>
          <button class="small" id="sidebarInviteBtn" data-tooltip="Invite User"><img src="image/user-plus.svg" class="app-icon nav-icon" alt=""> <span class="nav-text">Invite User</span></button>
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

  const handleToggle = () => {
    updateSidebarState(!sidebarCollapsed);
  };
  const topbarToggle = byId("topbarSidebarToggle");
  if (topbarToggle) topbarToggle.onclick = handleToggle;

  const sidebarExpand = byId("sidebarExpandBtn");
  if (sidebarExpand) sidebarExpand.onclick = handleToggle;

  attachSidebarTooltips();

  // Create menu
  const createMenu = byId("createMenu");
  byId("createBtn").onclick = (e) => { e.stopPropagation(); closeAllDropdowns(createMenu); createMenu.classList.toggle("hidden"); };
  byId("createProjectOpt").onclick = () => { createMenu.classList.add("hidden"); openProjectModal(); };
  byId("createTaskOpt").onclick = () => { createMenu.classList.add("hidden"); openIssueModal(); };
  byId("sidebarInviteBtn").onclick = () => openInviteModal();

  // Notifications
  const notifPanel = byId("notifPanel");
  byId("notifBtn").onclick = (e) => { e.stopPropagation(); closeAllDropdowns(notifPanel); notifPanel.classList.toggle("hidden"); };
  byId("markAllReadBtn").onclick = async () => {
    await api("/notifications/read-all", { method: "POST" });
    notifications.forEach(n => n.read = true);
    renderNotifications();
    showToast("All notifications marked as read", "success");
  };

  // Profile
  const profilePanel = byId("profilePanel");
  byId("profileBtn").onclick = (e) => { e.stopPropagation(); closeAllDropdowns(profilePanel); profilePanel.classList.toggle("hidden"); };
  const themeToggle = byId("themeToggleBtn");
  if (themeToggle) {
    updateThemeToggleButtons();
    themeToggle.onclick = (e) => { e.stopPropagation(); toggleTheme(); };
  }

  document.addEventListener("click", () => closeAllDropdowns());

  // Search
  const searchInput = byId("navSearch");
  const searchResults = byId("searchResults");
  let searchTimer;

  searchInput.oninput = () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      searchResults.classList.add("hidden");
      searchResults.innerHTML = "";
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const res = await api(`/search?q=${encodeURIComponent(q)}`);
        renderSearchResults(res);
      } catch (e) {
        searchResults.innerHTML = `<div class="sr-item">Search failed</div>`;
        searchResults.classList.remove("hidden");
      }
    }, 250);
  };

  searchInput.onfocus = () => {
    if (searchInput.value.trim() && searchResults.innerHTML) {
      searchResults.classList.remove("hidden");
    }
  };
}

function renderSearchResults(data) {
  const box = byId("searchResults");
  const pList = data.projects || [];
  const iList = data.issues || [];

  if (!pList.length && !iList.length) {
    box.innerHTML = `<div class="sr-item muted">No results found</div>`;
    box.classList.remove("hidden");
    return;
  }

  let html = "";
  if (pList.length) {
    html += `<div class="sr-heading">Projects</div>`;
    pList.forEach(p => {
      html += `<div class="sr-item" data-search-project="${p.id}">
        <strong>${esc(p.name)}</strong> <span class="pill">${esc(p.key)}</span>
      </div>`;
    });
  }
  if (iList.length) {
    html += `<div class="sr-heading">Tasks</div>`;
    iList.forEach(i => {
      html += `<div class="sr-item" data-search-issue="${i.id}" data-project="${i.project_id}">
        <div><strong>${esc(i.title)}</strong></div>
        <div class="muted" style="font-size:11px">${esc(i.key || "")} · ${esc(i.status)}</div>
      </div>`;
    });
  }
  box.innerHTML = html;
  box.classList.remove("hidden");

  box.querySelectorAll("[data-search-project]").forEach(el => {
    el.onclick = () => {
      box.classList.add("hidden");
      byId("navSearch").value = "";
      openProject(el.dataset.searchProject);
    };
  });
  box.querySelectorAll("[data-search-issue]").forEach(el => {
    el.onclick = async () => {
      box.classList.add("hidden");
      byId("navSearch").value = "";
      await openProject(el.dataset.project, "board");
      const target = issues.find(x => x.id === el.dataset.searchIssue);
      if (target) openIssueModal(target);
    };
  });
}

function closeAllDropdowns(except = null) {
  ["createMenu", "notifPanel", "profilePanel", "searchResults"].forEach(id => {
    const el = byId(id);
    if (el && el !== except) el.classList.add("hidden");
  });
}

// ================= Data loading =================

function isAdmin() {
  return ((currentUser && currentUser.role) || "member").toLowerCase() === "admin";
}

function updateAdminUI() {
  const sidebarInvite = byId("sidebarInviteBtn");
  if (sidebarInvite) {
    sidebarInvite.style.display = isAdmin() ? "" : "none";
  }
  const inviteOpt = byId("inviteUserOpt");
  if (inviteOpt) {
    inviteOpt.style.display = isAdmin() ? "" : "none";
  }
}

async function loadInitialData() {
  try {
    const [meData, projectsData, usersData, notificationsData] = await Promise.all([
      api("/users/me"),
      api("/projects"),
      api("/users"),
      api("/notifications")
    ]);
    currentUser = meData;
    localStorage.setItem("clove_user", JSON.stringify(currentUser));
    updateAdminUI();

    projects = projectsData || [];
    users = usersData || [];
    notifications = notificationsData || [];

    renderSidebarProjects();
    renderNotifications();
    const pendingProject = localStorage.getItem("clove_open_project");
    if (pendingProject && projects.some(p => p.id === pendingProject)) {
      localStorage.removeItem("clove_open_project");
      await openProject(pendingProject);
    } else {
      await restoreRoute();
    }
  } catch (e) {
    byId("content").innerHTML = `<div class="card"><h2>Could not load CLOVE</h2><p>${esc(e.message)}</p><p>Make sure FastAPI and MongoDB are running.</p></div>`;
  }
}

function renderNotifications() {
  const unread = notifications.filter(n => !n.read).length;
  const badge = byId("notifBadge");
  if (badge) {
    badge.textContent = unread > 99 ? "99+" : unread;
    badge.classList.toggle("hidden", unread === 0);
  }

  const list = byId("notifList");
  if (!list) return;
  if (!notifications.length) {
    list.innerHTML = `
      <div class="dropdown-empty notif-empty-state">
        <div class="notif-empty-icon"><img src="image/bell.svg" class="app-icon" alt=""></div>
        <p class="notif-empty-title">All caught up!</p>
        <span class="notif-empty-sub">You have no new notifications right now.</span>
      </div>`;
    return;
  }
  list.innerHTML = notifications.map(n => `
    <div class="notif-item ${n.read ? "" : "unread"}" data-id="${n.id}">
      <div class="notif-avatar">
        <img src="image/bell.svg" class="app-icon" alt="">
        ${n.read ? "" : `<span class="unread-dot"></span>`}
      </div>
      <div class="notif-content">
        <div class="n-body">${esc(n.message)}</div>
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
  if (!list) return;
  if (!projects.length) {
    list.innerHTML = `<div class="sidebar-empty-projects" style="padding:8px 12px;font-size:12px;color:var(--text-muted);font-style:italic;">No projects yet</div>`;
    return;
  }
  list.innerHTML = projects.map(p => `
    <button data-project="${p.id}" data-tooltip="${esc(p.name)} (${esc(p.key)})${p.completed ? " · Sprint Completed" : ""}" class="${p.id === activeProjectId ? "active" : ""} ${p.completed ? "completed-project" : ""}" title="${esc(p.name)}${p.completed ? " (Sprint Completed)" : ""}">
      <span class="project-mini-icon"><img src="image/folder.svg" class="app-icon" style="width:14px;height:14px;" alt=""></span>
      <span class="nav-text project-mini-name ${p.completed ? "strikeout" : ""}">${esc(p.name)}</span>
      <span class="nav-text project-mini-key ${p.completed ? "strikeout" : ""}">${esc(p.key)}</span>
    </button>`).join("");
  list.querySelectorAll("[data-project]").forEach(b => b.onclick = () => openProject(b.dataset.project));
}

// ================= Navigation & Route Persistence =================

function saveRoute() {
  document.title = "CLOVE";
  if (view === "project" && activeProjectId) {
    const p = findProject(activeProjectId);
    const key = (p && p.key) ? p.key : activeProjectId;
    const tab = activeTab || "board";
    const targetHash = `#/projects/${encodeURIComponent(key)}/${tab}`;
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, "", targetHash);
    }
    localStorage.setItem("clove_view", "project");
    localStorage.setItem("clove_project", activeProjectId);
    localStorage.setItem("clove_tab", tab);
  } else if (view && view !== "project") {
    const routeName = (view === "foryou" || view === "for-you") ? "for-you" : view;
    const targetHash = `#/${routeName}`;
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, "", targetHash);
    }
    localStorage.setItem("clove_view", view === "for-you" ? "foryou" : view);
    localStorage.removeItem("clove_project");
  }
}

async function restoreRoute() {
  document.title = "CLOVE";
  let hash = (window.location.hash || "").trim();
  if (hash.startsWith("#")) hash = hash.slice(1);
  if (hash.startsWith("/")) hash = hash.slice(1);

  // 1. If empty hash or root, restore from localStorage or default to foryou
  if (!hash) {
    const savedView = localStorage.getItem("clove_view");
    const savedProject = localStorage.getItem("clove_project");
    const savedTab = localStorage.getItem("clove_tab") || "board";

    if (savedView === "project" && savedProject) {
      const proj = findProject(savedProject);
      if (proj) {
        await openProject(proj.id, savedTab);
        return;
      }
    }

    if (savedView && ["foryou", "for-you", "recent", "starred", "projects", "team"].includes(savedView)) {
      setView(savedView === "for-you" ? "foryou" : savedView);
      return;
    }

    setView("foryou");
    return;
  }

  // 2. Project routes: projects/:keyOrId/:tab, project/:keyOrId/:tab, projects/:keyOrId
  const projMatch = hash.match(/^projects?\/([^/?#]+)(?:\/([^/?#]+))?/i);
  if (projMatch) {
    const rawKeyOrId = decodeURIComponent(projMatch[1]).trim();
    const rawTab = projMatch[2] ? decodeURIComponent(projMatch[2]).toLowerCase() : "board";
    const validTab = ["summary", "backlog", "board"].includes(rawTab) ? rawTab : "board";

    // If route was literally "#/projects" or "#/project"
    if (!rawKeyOrId || rawKeyOrId.toLowerCase() === "all") {
      setView("projects");
      return;
    }

    const proj = findProject(rawKeyOrId);
    if (proj) {
      if (activeProjectId === proj.id && view === "project") {
        if (activeTab !== validTab) setTab(validTab);
      } else {
        await openProject(proj.id, validTab);
      }
      return;
    } else {
      localStorage.removeItem("clove_project");
      showToast("Project not found or no access", "info");
      setView("projects");
      return;
    }
  }

  // 3. Main views: for-you, foryou, recent, starred, projects, project, team
  const viewMatch = hash.match(/^(for-you|foryou|recent|starred|projects?|team)$/i);
  if (viewMatch) {
    let matched = viewMatch[1].toLowerCase();
    if (matched === "for-you" || matched === "foryou") matched = "foryou";
    else if (matched === "project" || matched === "projects") matched = "projects";
    if (view !== matched || !byId("content") || !byId("content").innerHTML.trim()) {
      setView(matched);
    }
    return;
  }

  // 4. Default fallback
  setView("foryou");
}

window.addEventListener("hashchange", () => {
  restoreRoute();
});

// ================= View routing =================

function setView(v) {
  disconnectProjectWebSocket();
  stopProjectPolling();
  view = (v === "for-you") ? "foryou" : v;
  activeProjectId = null;
  document.querySelectorAll(".sidebar .nav button[data-view]").forEach(b => {
    b.classList.toggle("active", b.dataset.view === view || (view === "foryou" && b.dataset.view === "for-you"));
  });
  renderSidebarProjects();
  saveRoute();

  if (view === "foryou") return renderForYou();
  if (view === "recent") return renderRecent();
  if (view === "starred") return renderStarred();
  if (view === "projects") return renderAllProjects();
  if (view === "team") return renderTeam();
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
  list.innerHTML = myIssues.map(i => {
    const overdue = i.status !== "Done" && isOverdue(i.due_date);
    const prioClass = `prio-${(i.priority || "medium").toLowerCase()}`;
    const statusClass = `status-${(i.status || "todo").toLowerCase().replace(/\s+/g, "")}`;
    return `
    <div class="list-item" data-issue="${i.id}" data-project="${i.project_id}" style="cursor:pointer">
      <div><strong>${esc(i.title)}</strong><div class="muted">${esc(findProject(i.project_id)?.name || "")} · ${esc(issueKey(i))}</div></div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="pill ${prioClass}">${esc(i.priority || "Medium")}</span>
        ${i.due_date ? `<span class="due-chip ${overdue ? "overdue" : ""}">${esc(formatDate(i.due_date))}</span>` : ""}
        <span class="pill ${statusClass}">${esc(i.status)}</span>
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-issue]").forEach(el => el.onclick = async () => {
    await openProject(el.dataset.project, "backlog");
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
  const emptyHtml = `
    <div class="empty" style="text-align:center;padding:48px 16px;background:var(--bg-surface);border:1px dashed var(--border-default);border-radius:var(--radius-lg);margin-top:10px;">
      <div style="margin-bottom:12px;"><img src="image/folder.svg" class="app-icon" style="width:40px;height:40px;" alt=""></div>
      <h3 style="margin:0 0 6px;font-size:16px;">No projects yet</h3>
      <p class="muted" style="margin:0 0 18px;font-size:13px;">Create your first project to start organizing tasks and sprints.</p>
      <button class="primary" onclick="openProjectModal()"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> Create Project</button>
    </div>
  `;
  c.innerHTML = `<div class="header-row"><div><h1>Projects</h1><p class="muted">Create and manage your CLOVE projects.</p></div><button class="primary" onclick="openProjectModal()"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> New Project</button></div>
    <div class="list">${projects.map(projectRow).join("") || emptyHtml}</div>`;
  attachProjectRowHandlers();
}

function projectRow(p) {
  const isOwner = currentUser && (p.owner_id === currentUser.id || currentUser.role === "admin");
  return `<div class="list-item ${p.completed ? "completed-project-card" : ""}" data-project="${p.id}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
    <div style="flex:1;min-width:0;padding-right:12px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <strong class="${p.completed ? "strikeout" : ""}">${esc(p.name)}</strong>
        ${p.completed ? `<span class="pill status-done sprint-done-pill" style="font-size:10px;padding:1px 7px;display:inline-flex;align-items:center;gap:3px;"><img src="image/check.svg" class="app-icon" style="width:10px;height:10px;" alt=""> Completed</span>` : ""}
      </div>
      <div class="muted ${p.completed ? "strikeout" : ""}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.description || "")}</div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
      ${p.starred ? `<img src="image/star-filled.svg" class="app-icon no-invert" style="width:14px;height:14px;margin-right:2px;" alt="Starred"> ` : ""}<span class="pill ${p.completed ? "strikeout" : ""}">${esc(p.key)}</span>
      ${isOwner ? `<button class="secondary small" data-delete-project="${p.id}" title="Delete Project" style="padding:4px 8px;font-size:12px;border:none;background:transparent;color:var(--text-muted);cursor:pointer;display:inline-flex;align-items:center;"><img src="image/trash.svg" class="app-icon" style="width:14px;height:14px;" alt="Delete"></button>` : ""}
    </div>
  </div>`;
}

function attachProjectRowHandlers() {
  const content = byId("content");
  if (!content) return;
  content.querySelectorAll(".list-item[data-project]").forEach(el => el.onclick = (e) => {
    if (e.target.closest("[data-delete-project]")) return;
    openProject(el.dataset.project);
  });
  content.querySelectorAll("[data-delete-project]").forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const pId = btn.dataset.deleteProject;
      const proj = findProject(pId);
      const ok = await showConfirm({
        title: "Delete Project",
        message: `Delete project "${proj ? proj.name : ''}"? This will delete the project and all its tasks permanently.`,
        confirmText: "Delete Project",
        cancelText: "Cancel",
        danger: true
      });
      if (!ok) return;
      try {
        await api(`/projects/${pId}`, { method: "DELETE" });
        projects = projects.filter(p => p.id !== pId);
        renderSidebarProjects();
        renderAllProjects();
        showToast("Project deleted successfully", "success");
      } catch (err) {
        showToast(err.message || "Failed to delete project", "error");
      }
    };
  });
}

function renderTeam() {
  const c = byId("content");
  c.innerHTML = `
    <div class="header-row">
      <div>
        <h1>My Team</h1>
        <p class="muted">Everyone in this CLOVE workspace.</p>
      </div>
      ${isAdmin() ? `<button class="primary" id="teamInviteBtn"><img src="image/user-plus.svg" class="app-icon btn-icon" alt=""> Invite User</button>` : ""}
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
        showToast("User role updated successfully", "success");
        renderTeam();
      } catch (err) {
        showToast(err.message || "Failed to update user role", "error");
        renderTeam();
      }
    };
  });
}

// ================= Project view =================

async function openProject(projectIdOrKey, targetTab = null) {
  const p = findProject(projectIdOrKey);
  if (!p) {
    localStorage.removeItem("clove_project");
    showToast("Project not found or no access", "info");
    setView("projects");
    return;
  }
  const projectId = p.id;
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
  activeTab = targetTab || activeTab || "board";
  renderProjectShell();
  connectProjectWebSocket(projectId);
  startProjectPolling(projectId);
  saveRoute();
}

function renderProjectShell() {
  const p = findProject(activeProjectId);
  if (!p) return;
  const c = byId("content");
  c.innerHTML = `
    <div class="project-title-row">
      <h1 class="${p.completed ? "strikeout" : ""}" style="margin:0">${esc(p.name)}</h1>
      <span class="pill ${p.completed ? "strikeout" : ""}">${esc(p.key)}</span>
      ${p.completed ? `<span class="pill status-done sprint-done-pill" style="font-size:11px;padding:2px 8px;display:inline-flex;align-items:center;gap:4px;"><img src="image/check.svg" class="app-icon" style="width:12px;height:12px;" alt=""> Sprint Completed</span>` : ""}
      <button class="star-toggle ${p.starred ? "active" : ""}" id="starToggle" title="Star project" style="background:transparent;border:none;cursor:pointer;padding:4px;display:inline-flex;align-items:center;">
        <img src="image/${p.starred ? "star-filled.svg" : "star.svg"}" class="app-icon ${p.starred ? "no-invert" : ""}" style="width:18px;height:18px;" alt="Star">
      </button>
      <span style="flex:1"></span>
      ${isAdmin() ? `<button class="secondary" id="projectInviteBtn" style="font-size:13px;padding:6px 12px;display:inline-flex;align-items:center;"><img src="image/user-plus.svg" class="app-icon btn-icon" alt=""> Invite User</button>` : ""}
    </div>
    <p class="muted ${p.completed ? "strikeout" : ""}" style="margin:4px 0 0">${esc(p.description || "")}</p>
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
  saveRoute();
}

function renderSummaryTab() {
  const p = findProject(activeProjectId);
  if (!p) return;
  const counts = { "To Do": 0, "In Progress": 0, "Done": 0 };
  issues.forEach(i => {
    const s = (i.status || "").trim().toLowerCase();
    if (s === "in progress" || s === "inprogress") {
      counts["In Progress"]++;
    } else if (s === "done") {
      counts["Done"]++;
    } else {
      counts["To Do"]++;
    }
  });
  const total = issues.length;
  const pct = p.completed ? 100 : (total === 0 ? 0 : Math.round((counts["Done"] / total) * 100));

  byId("tabContent").innerHTML = `
    <div class="summary-shell">
      <div class="summary-header">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <p class="summary-desc ${p.completed ? "strikeout" : ""}" style="margin:0;font-weight:600;">${esc(p.description || p.name || "No project description provided.")}</p>
          ${p.completed ? `<span class="pill status-done sprint-done-pill" style="font-size:11px;padding:2px 8px;display:inline-flex;align-items:center;gap:4px;"><img src="image/check.svg" class="app-icon" style="width:12px;height:12px;" alt=""> Sprint Completed</span>` : ""}
        </div>
        <div class="progress-container">
          <div class="progress-labels">
            <span class="progress-title ${p.completed ? "strikeout" : ""}">Sprint Completion Progress</span>
            <span class="progress-pct">${p.completed ? "100% (Sprint Completed)" : `${pct}% (${counts["Done"]}/${total} completed)`}</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${p.completed ? 100 : pct}%"></div>
          </div>
        </div>
      </div>

      <div class="grid summary-kpi-grid">
        <div class="card summary-kpi">
          <div class="kpi-icon kpi-total"><img src="image/clipboard.svg" class="app-icon kpi-img" alt="Total Tasks"></div>
          <div>
            <div class="stat ${p.completed ? "strikeout" : ""}">${total}</div>
            <div class="muted">Total Tasks</div>
          </div>
        </div>
        <div class="card summary-kpi">
          <div class="kpi-icon kpi-todo"><img src="image/hourglass.svg" class="app-icon kpi-img" alt="To Do"></div>
          <div>
            <div class="stat ${p.completed ? "strikeout" : ""}">${counts["To Do"]}</div>
            <div class="muted">To Do</div>
          </div>
        </div>
        <div class="card summary-kpi">
          <div class="kpi-icon kpi-inprog"><img src="image/bolt.svg" class="app-icon kpi-img" alt="In Progress"></div>
          <div>
            <div class="stat ${p.completed ? "strikeout" : ""}">${counts["In Progress"]}</div>
            <div class="muted">In Progress</div>
          </div>
        </div>
        <div class="card summary-kpi">
          <div class="kpi-icon kpi-done"><img src="image/check-circle.svg" class="app-icon kpi-img" alt="Completed"></div>
          <div>
            <div class="stat ${p.completed ? "strikeout" : ""}">${counts["Done"]}</div>
            <div class="muted">Completed</div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderBacklogTab() {
  const c = byId("tabContent");
  c.innerHTML = `
    <div class="header-row"><div></div><button class="primary" onclick="openIssueModal()"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> New Task</button></div>
    <div class="backlog-head"><div>Task</div><div>Priority</div><div>Status</div><div>Due</div><div>Estimate</div><div>Assignee</div></div>
    <div id="backlogRows"></div>`;
  const rows = byId("backlogRows");
  if (!issues.length) {
    rows.innerHTML = `<div class="empty">No tasks yet. Create one to get started.</div>`;
    return;
  }
  rows.innerHTML = issues.map(i => {
    const overdue = i.status !== "Done" && isOverdue(i.due_date);
    const prioClass = `prio-${(i.priority || "medium").toLowerCase()}`;
    const statusClass = `status-${(i.status || "todo").toLowerCase().replace(/\s+/g, "")}`;
    return `
    <div class="backlog-row" data-issue="${i.id}">
      <div class="b-title">${esc(i.title)} <span class="muted">${esc(issueKey(i))}</span></div>
      <div><span class="pill ${prioClass}">${esc(i.priority)}</span></div>
      <div><span class="pill ${statusClass}">${esc(i.status)}</span></div>
      <div>${i.due_date ? `<span class="due-chip ${overdue ? "overdue" : ""}">${esc(formatDate(i.due_date))}</span>` : "—"}</div>
      <div>${i.estimation !== undefined && i.estimation !== null ? `<span class="estimate-chip"><img src="image/timer.svg" class="app-icon" style="width:12px;height:12px;vertical-align:-1px;margin-right:3px;" alt=""> ${esc(formatEstimation(i.estimation))}</span>` : "—"}</div>
      <div>${i.assignee_id ? `<span style="display:inline-flex;align-items:center;gap:6px;"><span class="assignee-chip" style="width:22px;height:22px;font-size:10px;">${esc(initials(userLabel(i.assignee_id)))}</span><span>${esc(userLabel(i.assignee_id))}</span></span>` : '<span class="muted">Unassigned</span>'}</div>
    </div>`;
  }).join("");
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
    const proj = findProject(msg.project_id);
    if (proj && msg.completed !== undefined) {
      proj.completed = msg.completed;
      renderSidebarProjects();
      if (view === "projects") renderAllProjects();
      if (view === "starred") renderStarred();
      if (view === "recent") renderRecent();
      if (activeProjectId === msg.project_id) {
        renderProjectShell();
      }
    }
    reloadBoardIssues();
  } else if (msg.type === "comment_created") {
    if (activeModalIssueId && activeModalIssueId === msg.issue_id) {
      loadComments(msg.issue_id);
    }
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
    showToast(`Could not change task status: ${err.message}`, "error");
  }
}

function renderBoardTab() {
  const c = byId("tabContent");
  const settings = getBoardSettings(activeProjectId);
  const showDue = settings.showDueDates !== false;
  const proj = findProject(activeProjectId);
  const isCompletedProj = proj && proj.completed;

  c.innerHTML = `
    <div class="board-actions">
      <select id="filterPriority">
        <option value="">All priorities</option>
        <option value="Highest">Highest</option>
        <option value="High">High</option>
        <option value="Medium">Medium</option>
        <option value="Low">Low</option>
        <option value="Lowest">Lowest</option>
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
      <button class="secondary" id="completeSprintBtn">${isCompletedProj ? "Reopen Sprint" : "Complete Sprint"}</button>
      <button class="primary" onclick="openIssueModal()"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> Create Task</button>
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
    const proj = findProject(activeProjectId);
    const wasCompleted = proj && proj.completed;
    const confirmTitle = wasCompleted ? "Reopen Sprint" : "Complete Sprint";
    const confirmMsg = wasCompleted
      ? "Reopen sprint? This will reactivate the project and remove the strikeout."
      : "Complete sprint? This will strike out the project in All Projects and Summary, and archive Done tasks.";
    const ok = await showConfirm({
      title: confirmTitle,
      message: confirmMsg,
      confirmText: wasCompleted ? "Reopen Sprint" : "Complete Sprint",
      cancelText: "Cancel",
      type: wasCompleted ? "info" : "success"
    });
    if (!ok) return;

    try {
      const res = await api(`/issues/complete-sprint?project_id=${activeProjectId}`, { method: "POST" });
      if (proj) {
        proj.completed = res.completed;
      }
      renderSidebarProjects();
      renderProjectShell();
      await reloadBoardIssues();
      showToast(res.completed ? "Sprint completed! Project is now struck out in All Projects and Summary." : "Sprint reopened! Project is active again.", "success");
    } catch (err) {
      showToast(err.message || "Failed to update sprint status", "error");
    }
  };

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
  const settings = getBoardSettings(activeProjectId);
  const shouldShowDue = showDue !== undefined ? showDue : (settings.showDueDates !== false);

  ["To Do", "In Progress", "Done"].forEach(status => {
    const zone = document.querySelector(`.col-dropzone[data-status="${status}"]`);
    const countBadge = document.querySelector(`.col-count[data-count="${status}"]`);
    if (!zone || !countBadge) return;

    const columnIssues = issues.filter(i => {
      const s = (i.status || "").trim().toLowerCase();
      if (status === "To Do") {
        return s === "to do" || s === "todo" || s === "backlog" || !s;
      }
      if (status === "In Progress") {
        return s === "in progress" || s === "inprogress";
      }
      if (status === "Done") {
        return s === "done";
      }
      return s === status.toLowerCase();
    });
    countBadge.textContent = columnIssues.length;

    if (!columnIssues.length) {
      zone.innerHTML = `<div class="empty-column">No tasks here.</div>`;
      return;
    }

    if (boardGroupBy === "none") {
      zone.innerHTML = columnIssues.map(i => taskCardHtml(i, shouldShowDue)).join("");
    } else {
      const groups = {};
      columnIssues.forEach(i => {
        const key = boardGroupBy === "assignee" ? (i.assignee_id ? userLabel(i.assignee_id) : "Unassigned") : i.priority;
        (groups[key] = groups[key] || []).push(i);
      });
      const priorityOrder = { "Highest": 1, "Critical": 1, "High": 2, "Medium": 3, "Low": 4, "Lowest": 5 };
      zone.innerHTML = Object.keys(groups).sort((a, b) => {
        if (boardGroupBy === "priority") {
          return (priorityOrder[a] || 99) - (priorityOrder[b] || 99);
        }
        return a.localeCompare(b);
      }).map(key => `
        <div class="group-heading">${esc(key)}</div>
        ${groups[key].map(i => taskCardHtml(i, shouldShowDue)).join("")}`).join("");
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
  const curStatus = (i.status || "").trim().toLowerCase();
  const overdue = curStatus !== "done" && isOverdue(i.due_date);
  const prioClass = `prio-${(i.priority || "medium").toLowerCase()}`;
  return `
    <div class="task-card" draggable="true" data-id="${i.id}" data-priority="${esc(i.priority)}">
      <div class="task-card-header">
        <span class="task-key">${esc(issueKey(i))}</span>
        <select class="card-status-select" data-id="${i.id}" title="Change status" onclick="event.stopPropagation()">
          ${["To Do", "In Progress", "Done"].map(s => {
            const target = s.toLowerCase();
            const isMatch = curStatus === target || (target === "to do" && (curStatus === "todo" || curStatus === "backlog" || !curStatus));
            return `<option value="${s}" ${isMatch ? "selected" : ""}>${s}</option>`;
          }).join("")}
        </select>
      </div>
      <div class="task-card-title">${esc(i.title)}</div>
      <div class="task-card-meta">
        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
          <span class="pill ${prioClass}" style="font-size:10px;padding:2px 7px;font-weight:700;">${esc(i.priority)}</span>
          ${showDue && i.due_date ? `<span class="due-chip ${overdue ? "overdue" : ""}">${esc(formatDate(i.due_date))}</span>` : ""}
          ${i.estimation !== undefined && i.estimation !== null ? `<span class="estimate-chip" title="Estimation: ${esc(formatEstimation(i.estimation))}"><img src="image/timer.svg" class="app-icon" style="width:12px;height:12px;vertical-align:-1px;margin-right:3px;" alt=""> ${esc(formatEstimation(i.estimation))}</span>` : ""}
        </div>
        ${i.assignee_id ? `<span class="assignee-chip" title="${esc(userLabel(i.assignee_id))}">${esc(initials(userLabel(i.assignee_id)))}</span>` : "<span></span>"}
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
      <div class="modal-head"><h2>Board Settings</h2><button class="close" onclick="closeModal()"><img src="image/close.svg" class="app-icon" alt="Close"></button></div>
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
      <div class="modal-head"><h2>Settings</h2><button class="close" onclick="closeModal()"><img src="image/close.svg" class="app-icon" alt="Close"></button></div>
      <form id="settingsForm">
        <label>Display name<input id="settingsName" value="${esc(currentUser.name)}" required></label>
        <label>Email<input value="${esc(currentUser.email)}" disabled></label>
        <label>Appearance
          <div style="display:flex;gap:10px;margin-top:6px;">
            <button type="button" class="secondary" id="setLightModeBtn" style="flex:1;"><img src="image/sun.svg" class="app-icon theme-icon" alt=""> Light Theme</button>
            <button type="button" class="secondary" id="setDarkModeBtn" style="flex:1;"><img src="image/moon.svg" class="app-icon theme-icon" alt=""> Dark Theme</button>
          </div>
        </label>
        <div class="actions"><button type="button" class="secondary" onclick="closeModal()">Cancel</button><button class="primary">Save</button></div>
      </form>
    </div></div>`;
  byId("setLightModeBtn").onclick = () => { setTheme("light"); };
  byId("setDarkModeBtn").onclick = () => { setTheme("dark"); };
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
      showToast("Profile updated successfully", "success");
    } catch (err) { showToast(err.message, "error"); }
  };
}

// ================= Project / Task modals =================

function openProjectModal() {
  closeAllDropdowns();
  byId("modal-root").innerHTML = `
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h2>New Project</h2>
          <button type="button" class="close" onclick="closeModal()"><img src="image/close.svg" class="app-icon" alt="Close"></button>
        </div>
        <div id="projectErrorBox" class="form-error-banner hidden"></div>
        <form id="projectForm" novalidate>
          <label class="task-form-field">
            <span>Project name <span class="req-star">*</span></span>
            <input id="pname" placeholder="Enter project name" required autocomplete="off">
          </label>
          <label class="task-form-field">
            <span>Project key <span class="req-star">*</span></span>
            <input id="pkey" placeholder="Enter project key" maxlength="10" required autocomplete="off" style="text-transform:uppercase;">
          </label>
          <label class="task-form-field">
            <span>Description</span>
            <textarea id="pdesc" placeholder="Enter project description"></textarea>
          </label>
          <div class="actions">
            <button type="button" class="secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="primary" id="createProjectSubmitBtn">Create</button>
          </div>
        </form>
      </div>
    </div>`;

  const pname = byId("pname");
  const pkey = byId("pkey");
  const pdesc = byId("pdesc");
  const errorBox = byId("projectErrorBox");
  const submitBtn = byId("createProjectSubmitBtn");

  const clearError = () => {
    errorBox.classList.add("hidden");
    errorBox.textContent = "";
    pname.classList.remove("field-invalid");
    pkey.classList.remove("field-invalid");
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
  };

  pname.addEventListener("input", () => {
    pname.classList.remove("field-invalid");
    if (errorBox.textContent) clearError();
  });

  pkey.addEventListener("input", () => {
    pkey.value = pkey.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    pkey.classList.remove("field-invalid");
    if (errorBox.textContent) clearError();
  });

  byId("projectForm").onsubmit = async e => {
    e.preventDefault();
    clearError();

    const nameVal = pname.value.trim();
    const keyVal = pkey.value.trim().toUpperCase();
    const descVal = pdesc.value.trim();

    if (!nameVal) {
      showError("Project name is required.", "pname");
      return;
    }
    if (nameVal.length < 2) {
      showError("Project name must be at least 2 characters.", "pname");
      return;
    }

    if (!keyVal) {
      showError("Project key is required.", "pkey");
      return;
    }
    if (keyVal.length < 2) {
      showError("Project key must be at least 2 characters.", "pkey");
      return;
    }

    // Client-side uniqueness check for Project Name (case-insensitive)
    const duplicateName = projects.find(p => p.name.trim().toLowerCase() === nameVal.toLowerCase());
    if (duplicateName) {
      showError(`A project named '${nameVal}' already exists. All project names must be unique.`, "pname");
      return;
    }

    // Client-side uniqueness check for Project Key (case-insensitive)
    const duplicateKey = projects.find(p => p.key.trim().toUpperCase() === keyVal);
    if (duplicateKey) {
      showError(`Project key '${keyVal}' already exists. All project keys must be unique.`, "pkey");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Creating...";

    try {
      const project = await api("/projects", {
        method: "POST",
        body: JSON.stringify({ name: nameVal, key: keyVal, description: descVal })
      });
      projects.push(project);
      closeModal();
      renderSidebarProjects();
      openProject(project.id);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";

      const msg = err.message || "Failed to create project";
      if (/key/i.test(msg)) {
        showError(msg, "pkey");
      } else if (/name/i.test(msg)) {
        showError(msg, "pname");
      } else {
        showError(msg);
      }
    }
  };
}

async function openIssueModal(existing) {
  closeAllDropdowns();
  if (!existing && !activeProjectId && !projects.length) {
    showToast("Create a project first.", "info");
    return;
  }
  await refreshUsers();
  const projectId = existing ? existing.project_id : activeProjectId;
  const isEdit = !!existing;
  const todayStr = getTodayString();

  byId("modal-root").innerHTML = `<div class="modal"><div class="modal-card modal-task-card">
    <div class="modal-head task-modal-head">
      <div class="task-modal-title-row">
        ${isEdit && existing ? `<span class="task-key-badge">${esc(issueKey(existing))}</span>` : ""}
        <h2>${isEdit ? "Edit Task" : "New Task"}</h2>
      </div>
      <button type="button" class="close" onclick="closeModal()"><img src="image/close.svg" class="app-icon" alt="Close"></button>
    </div>
    <div id="taskErrorBox" class="form-error-banner hidden"></div>
    <form id="issueForm" class="task-modal-form" novalidate>
      <div class="task-modal-grid">
        <div class="task-modal-col-main">
          ${!isEdit && !activeProjectId ? `
            <label class="task-form-field">
              <span>Project <span class="req-star">*</span></span>
              <select id="iproject">
                ${projects.map(p => `<option value="${p.id}">${esc(p.key)} — ${esc(p.name)}</option>`).join("")}
              </select>
            </label>` : ""}
          <label class="task-form-field">
            <span>Task Title <span class="req-star">*</span></span>
            <input id="ititle" placeholder="Enter task title" value="${isEdit ? esc(existing.title) : ""}">
          </label>
          <label class="task-form-field ${isEdit ? "task-field-desc" : "task-field-desc-new"}">
            <span>Description <span class="req-star">*</span></span>
            <textarea id="idesc" placeholder="Enter task description">${isEdit ? esc(existing.description || "") : ""}</textarea>
          </label>
          ${isEdit ? `
            <div class="task-comments-wrapper">
              <div class="task-comments-title">Comments</div>
              <div id="commentList" class="comment-list-scroll"></div>
              <div id="commentAttachmentPreview" class="comment-attachment-preview hidden"></div>
              <div class="comment-add-row">
                <input id="commentInput" placeholder="Add a comment…" autocomplete="off">
                <input type="file" id="commentFileInput" style="display:none">
                <button type="button" class="comment-attach-btn" id="commentAttachBtn" title="Attach file"><img src="image/paperclip.svg" class="app-icon" alt="Attach"></button>
                <button type="button" class="secondary" id="commentBtn">Post</button>
              </div>
            </div>` : ""}
        </div>
        <div class="task-modal-col-side">
          <div class="task-side-card">
            <div class="task-side-title">Task Details</div>
            <label class="task-form-field">
              <span>Status <span class="req-star">*</span></span>
              <select id="istatus">
                ${["To Do", "In Progress", "Done"].map(s => `<option ${isEdit && existing.status === s ? "selected" : ""}>${s}</option>`).join("")}
              </select>
            </label>
            <label class="task-form-field">
              <span>Priority <span class="req-star">*</span></span>
              <select id="ipriority">
                ${["Highest", "High", "Medium", "Low", "Lowest"].map(p => {
                  const isSelected = isEdit
                    ? (existing.priority === p || (existing.priority === "Critical" && p === "Highest"))
                    : (p === "Medium");
                  return `<option value="${p}" ${isSelected ? "selected" : ""}>${p}</option>`;
                }).join("")}
                ${isEdit && existing.priority === "Critical" ? `<option value="Critical">Critical</option>` : ""}
              </select>
            </label>
            <label class="task-form-field">
              <span>Due Date <span class="req-star">*</span></span>
              <input type="date" id="idue" min="${todayStr}" value="${isEdit && existing.due_date ? existing.due_date : ""}">
            </label>
            <label class="task-form-field">
              <span>Estimation (Days) <span class="req-star">*</span></span>
              <input type="number" id="iestimation" step="1" min="1" placeholder="Enter days" value="${isEdit && existing.estimation != null ? Math.round(existing.estimation) : ""}">
            </label>
            <label class="task-form-field">
              <span>Assignee</span>
              <select id="iassignee">
                <option value="">Unassigned</option>
                ${users.map(u => `<option value="${u.id}" ${isEdit && existing.assignee_id === u.id ? "selected" : ""}>${esc(u.name)} (${esc(u.role || "member")})</option>`).join("")}
              </select>
            </label>
          </div>
        </div>
      </div>
      <div class="actions task-modal-actions">
        ${isEdit ? `<button type="button" class="danger-btn" id="deleteIssueBtn"><img src="image/trash.svg" class="app-icon btn-icon" alt=""> Delete</button>` : ""}
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
    const estNum = parseInt(estVal, 10);
    if (isNaN(estNum) || estNum <= 0 || !Number.isInteger(Number(estVal))) {
      showError("Estimation (Days) must be a positive whole number of days.", "iestimation");
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

    let created = null;
    try {
      if (isEdit) {
        const updated = await api(`/issues/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) });
        Object.assign(existing, updated);
        const idx = issues.findIndex(i => i.id === existing.id);
        if (idx !== -1) issues[idx] = existing;
      } else {
        payload.project_id = activeProjectId || (byId("iproject") ? byId("iproject").value : null);
        created = await api("/issues", { method: "POST", body: JSON.stringify(payload) });
        if (created && created.project_id && activeProjectId && String(created.project_id) === String(activeProjectId)) {
          if (!issues.some(i => i.id === created.id)) {
            issues.unshift(created);
          }
        }
      }
      closeModal();
      if (activeProjectId) {
        setTab(activeTab);
      } else if (created && created.project_id) {
        await openProject(created.project_id, "board");
      }
    } catch (err) {
      showError(err.message || "An error occurred while saving.");
    }
  };

  if (isEdit) {
    activeModalIssueId = existing.id;

    byId("deleteIssueBtn").onclick = async () => {
      const ok = await showConfirm({
        title: "Delete Task",
        message: "Are you sure you want to delete this task? This cannot be undone.",
        confirmText: "Delete Task",
        cancelText: "Cancel",
        danger: true
      });
      if (!ok) return;
      try {
        await api(`/issues/${existing.id}`, { method: "DELETE" });
        issues = issues.filter(i => i.id !== existing.id);
        closeModal();
        if (activeProjectId) setTab(activeTab);
        showToast("Task deleted", "success");
      } catch (err) { showToast(err.message, "error"); }
    };

    loadComments(existing.id);

    // Polling backup to guarantee real-time updates while modal is open
    if (modalCommentTimer) clearInterval(modalCommentTimer);
    modalCommentTimer = setInterval(() => {
      if (activeModalIssueId === existing.id && byId("commentList")) {
        loadComments(existing.id, true);
      } else {
        clearInterval(modalCommentTimer);
        modalCommentTimer = null;
      }
    }, 3500);

    let pendingAttachment = null;
    const fileInput = byId("commentFileInput");
    const previewBox = byId("commentAttachmentPreview");
    const attachBtn = byId("commentAttachBtn");

    if (attachBtn && fileInput) {
      attachBtn.onclick = () => fileInput.click();
      fileInput.onchange = () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
          showToast("File size cannot exceed 8MB.", "error");
          fileInput.value = "";
          return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
          pendingAttachment = {
            name: file.name,
            type: file.type || "application/octet-stream",
            size: file.size,
            data: ev.target.result
          };
          previewBox.classList.remove("hidden");
          previewBox.innerHTML = `
            <span>📎</span>
            <span class="preview-name">${esc(file.name)}</span>
            <span class="preview-size">(${formatFileSize(file.size)})</span>
            <button type="button" class="preview-remove-btn" title="Remove attachment">✕</button>
          `;
          previewBox.querySelector(".preview-remove-btn").onclick = () => {
            pendingAttachment = null;
            fileInput.value = "";
            previewBox.classList.add("hidden");
            previewBox.innerHTML = "";
          };
        };
        reader.readAsDataURL(file);
      };
    }

    const postComment = async () => {
      const body = byId("commentInput").value.trim();
      if (!body && !pendingAttachment) return;
      const postBtn = byId("commentBtn");
      postBtn.disabled = true;
      try {
        await api("/comments", {
          method: "POST",
          body: JSON.stringify({
            issue_id: existing.id,
            body,
            attachment: pendingAttachment
          })
        });
        byId("commentInput").value = "";
        pendingAttachment = null;
        if (fileInput) fileInput.value = "";
        if (previewBox) {
          previewBox.classList.add("hidden");
          previewBox.innerHTML = "";
        }
        await loadComments(existing.id);
      } catch (err) {
        showToast(err.message || "Failed to post comment", "error");
      } finally {
        postBtn.disabled = false;
      }
    };

    byId("commentBtn").onclick = postComment;
    byId("commentInput").onkeydown = e => {
      if (e.key === "Enter") {
        e.preventDefault();
        postComment();
      }
    };
  }
}

async function loadComments(issueId, isSilent = false) {
  const box = byId("commentList");
  if (!box) return;
  if (!isSilent && !box.children.length) {
    box.innerHTML = `<div class="muted">Loading…</div>`;
  }
  try {
    const comments = await api(`/comments/${issueId}`);
    if (!comments.length) {
      box.innerHTML = `<div class="muted">No comments yet.</div>`;
      return;
    }
    const html = comments.map(c => {
      let attachmentHtml = "";
      if (c.attachment && c.attachment.data) {
        const isImg = (c.attachment.type || "").startsWith("image/");
        if (isImg) {
          attachmentHtml = `
            <div class="comment-attachment-wrap">
              <a href="${esc(c.attachment.data)}" target="_blank" download="${esc(c.attachment.name || "image")}" class="comment-img-link">
                <img src="${esc(c.attachment.data)}" alt="${esc(c.attachment.name || "image")}" class="comment-img-thumb">
              </a>
              <div class="comment-file-meta">
                <span class="file-icon">🖼️</span>
                <a href="${esc(c.attachment.data)}" download="${esc(c.attachment.name || "image")}" class="file-name">${esc(c.attachment.name)}</a>
                <span class="file-size">(${formatFileSize(c.attachment.size)})</span>
              </div>
            </div>`;
        } else {
          attachmentHtml = `
            <div class="comment-attachment-wrap">
              <a href="${esc(c.attachment.data)}" download="${esc(c.attachment.name || "file")}" class="comment-file-chip">
                <span class="file-icon"><img src="image/paperclip.svg" class="app-icon" style="width:13px;height:13px;vertical-align:-1px;" alt=""></span>
                <span class="file-name">${esc(c.attachment.name || "Attachment")}</span>
                <span class="file-size">(${formatFileSize(c.attachment.size)})</span>
              </a>
            </div>`;
        }
      }
      return `
        <div class="comment-item">
          <div class="c-meta">${esc(userLabel(c.user_id))} · ${timeAgo(c.created_at)}</div>
          ${c.body ? `<div class="c-body">${esc(c.body)}</div>` : ""}
          ${attachmentHtml}
        </div>`;
    }).join("");

    const shouldScroll = !isSilent || (box.scrollTop + box.clientHeight >= box.scrollHeight - 40);
    box.innerHTML = html;
    if (shouldScroll) {
      box.scrollTop = box.scrollHeight;
    }
  } catch (err) {
    if (!isSilent) box.innerHTML = `<div class="muted">Couldn't load comments.</div>`;
  }
}

function openInviteModal(projectId = null) {
  closeAllDropdowns();
  if (!isAdmin()) {
    showToast("Only Admin users can invite new users.", "error");
    return;
  }
  const project = projectId ? findProject(projectId) : null;
  const modalRoot = byId("modal-root");

  modalRoot.innerHTML = `
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h2>Invite User</h2>
          <button class="close" onclick="closeModal()"><img src="image/close.svg" class="app-icon" alt="Close"></button>
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
              <button class="close" onclick="closeModal()"><img src="image/close.svg" class="app-icon" alt="Close"></button>
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
      showToast(err.message || "Failed to create invitation", "error");
      closeModal();
    }
  };
}

function closeModal() {
  activeModalIssueId = null;
  if (modalCommentTimer) {
    clearInterval(modalCommentTimer);
    modalCommentTimer = null;
  }
  byId("modal-root").innerHTML = "";
}

// ================= Boot =================

shell();
loadInitialData();
