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

let isDraggingCard = false;
let cardDragStartPos = null;
let cardMouseDownPos = null;
let cardMouseDownTime = 0;
let cardDidRealDrag = false;
let lastOpenedModalTime = 0;

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
  } catch { }
}

// ---------- Small helpers ----------
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m])); }
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
        <input id="navSearch" type="text" placeholder="Search tasks, projects…">
        <div id="searchResults" class="search-results hidden"></div>
      </div>

      <div class="nav-actions">
        <div class="dropdown-wrap" id="createDropdownWrap" style="${isAdmin() ? '' : 'display:none;'}">
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
  const createWrap = byId("createDropdownWrap");
  if (createWrap) {
    createWrap.style.display = isAdmin() ? "" : "none";
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
      try {
        await api(`/notifications/${n.id}/read`, { method: "POST" });
        n.read = true;
        renderNotifications();
      } catch (e) {
        console.warn("Failed marking notification read", e);
      }
    }
    if (n && n.issue_id) {
      closeAllDropdowns();
      await openIssueById(n.issue_id);
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
    const validTab = ["summary", "dashboard", "backlog", "board", "timeline"].includes(rawTab) ? rawTab : "board";

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
    const myId = currentUser ? (currentUser.id || currentUser._id || "") : "";
    const [fetchedIssues, fetchedProjects] = await Promise.all([
      myId ? api(`/issues?assignee_id=${encodeURIComponent(myId)}`) : api("/issues"),
      api("/projects")
    ]);
    myIssues = fetchedIssues || [];
    if (fetchedProjects) {
      projects = fetchedProjects;
      renderSidebarProjects();
    }
  } catch (err) {
    console.warn("Could not load foryou tasks:", err);
    myIssues = [];
  }

  const list = byId("foryouList");
  if (!myIssues.length) {
    list.innerHTML = `<div class="empty">Nothing assigned to you right now.</div>`;
    return;
  }
  list.innerHTML = myIssues.map(i => {
    const overdue = i.status !== "Done" && isOverdue(i.due_date);
    const prioClass = `prio-${(i.priority || "medium").toLowerCase()}`;
    const statusClass = `status-${(i.status || "todo").toLowerCase().replace(/\s+/g, "")}`;
    const projName = findProject(i.project_id)?.name || i.project_name || "";
    const isBug = (i.issue_type || "").toLowerCase() === "bug";
    const typeBadge = isBug
      ? `<span class="task-type-badge bug" title="Bug"><span class="task-type-dot bug"></span>Bug</span>`
      : `<span class="task-type-badge feature" title="Feature"><span class="task-type-dot feature"></span>Feature</span>`;
    return `
    <div class="list-item" data-issue="${i.id}" data-project="${i.project_id}" style="cursor:pointer">
      <div><strong>${esc(i.title)}</strong><div class="muted">${esc(projName)} · ${esc(issueKey(i))}</div></div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${typeBadge}
        <span class="pill ${prioClass}">${esc(i.priority || "Medium")}</span>
        ${i.due_date ? `<span class="due-chip ${overdue ? "overdue" : ""}">${esc(formatDate(i.due_date))}</span>` : ""}
        <span class="pill ${statusClass}">${esc(i.status)}</span>
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-issue]").forEach(el => el.onclick = async () => {
    const issueId = el.dataset.issue;
    await openIssueById(issueId);
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
      ${isAdmin() ? `<button class="primary" onclick="openProjectModal()"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> Create Project</button>` : ""}
    </div>
  `;
  c.innerHTML = `<div class="header-row"><div><h1>Projects</h1><p class="muted">Create and manage your CLOVE projects.</p></div>${isAdmin() ? `<button class="primary" onclick="openProjectModal()"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> New Project</button>` : ""}</div>
    <div class="list">${projects.map(projectRow).join("") || emptyHtml}</div>`;
  attachProjectRowHandlers();
}

function projectRow(p) {
  const isOwner = currentUser && (p.owner_id === currentUser.id || currentUser.role === "admin");
  const sprintTag = (p.sprint_start_date && p.sprint_end_date)
    ? `<span class="pill" style="font-size:10px;padding:1px 6px;gap:3px;display:inline-flex;align-items:center;" title="Sprint Duration"><img src="image/calendar.svg" class="app-icon" style="width:10px;height:10px;" alt=""> ${esc(p.sprint_start_date)} → ${esc(p.sprint_end_date)}</span>`
    : "";
  return `<div class="list-item ${p.completed ? "completed-project-card" : ""}" data-project="${p.id}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
    <div style="flex:1;min-width:0;padding-right:12px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong class="${p.completed ? "strikeout" : ""}">${esc(p.name)}</strong>
        ${p.completed ? `<span class="pill status-done sprint-done-pill" style="font-size:10px;padding:1px 7px;display:inline-flex;align-items:center;gap:3px;"><img src="image/check.svg" class="app-icon" style="width:10px;height:10px;" alt=""> Completed</span>` : ""}
        ${sprintTag}
      </div>
      <div class="muted ${p.completed ? "strikeout" : ""}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.description || "")}</div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
      ${p.starred ? `<img src="image/star-filled.svg" class="app-icon no-invert" style="width:14px;height:14px;margin-right:2px;" alt="Starred"> ` : ""}<span class="pill ${p.completed ? "strikeout" : ""}">${esc(p.key)}</span>
      ${isOwner ? `<button class="secondary small" data-edit-project="${p.id}" title="Edit Project & Sprint Dates" style="padding:4px 8px;font-size:12px;border:none;background:transparent;color:var(--text-muted);cursor:pointer;display:inline-flex;align-items:center;"><img src="image/edit.svg" class="app-icon" style="width:14px;height:14px;" alt="Edit"></button>` : ""}
      ${isOwner ? `<button class="secondary small" data-delete-project="${p.id}" title="Delete Project" style="padding:4px 8px;font-size:12px;border:none;background:transparent;color:var(--text-muted);cursor:pointer;display:inline-flex;align-items:center;"><img src="image/trash.svg" class="app-icon" style="width:14px;height:14px;" alt="Delete"></button>` : ""}
    </div>
  </div>`;
}

function attachProjectRowHandlers() {
  const content = byId("content");
  if (!content) return;
  content.querySelectorAll(".list-item[data-project]").forEach(el => el.onclick = (e) => {
    if (e.target.closest("[data-delete-project]") || e.target.closest("[data-edit-project]")) return;
    openProject(el.dataset.project);
  });
  content.querySelectorAll("[data-edit-project]").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const pId = btn.dataset.editProject;
      const proj = findProject(pId);
      if (proj) openProjectModal(proj);
    };
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

function formatSprintDaysLeft(endDateStr, isCompleted = false) {
  if (!endDateStr) return null;
  if (isCompleted) {
    return {
      days: 0,
      label: "Sprint Completed",
      pillHtml: `<span class="pill status-done" style="font-size:11px;padding:2px 8px;font-weight:600;display:inline-flex;align-items:center;gap:4px;"><img src="image/check.svg" class="app-icon" style="width:11px;height:11px;" alt=""> Completed</span>`
    };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(endDateStr);
  end.setHours(0, 0, 0, 0);
  const diffTime = end.getTime() - today.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    const overdue = Math.abs(diffDays);
    return {
      days: diffDays,
      label: `${overdue}d overdue`,
      pillHtml: `<span class="pill" style="font-size:11px;padding:2px 8px;font-weight:600;background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;display:inline-flex;align-items:center;gap:4px;" title="Sprint ended ${overdue} day${overdue === 1 ? '' : 's'} ago"><img src="image/alert-circle.svg" class="app-icon" style="width:11px;height:11px;filter:invert(27%) sepia(85%) saturate(3000%) hue-rotate(345deg);" alt=""> ${overdue}d overdue</span>`
    };
  } else if (diffDays === 0) {
    return {
      days: 0,
      label: "Ends today",
      pillHtml: `<span class="pill" style="font-size:11px;padding:2px 8px;font-weight:600;background:#FEF3C7;color:#B45309;border:1px solid #FDE68A;display:inline-flex;align-items:center;gap:4px;" title="Sprint ends today"><img src="image/timer.svg" class="app-icon" style="width:11px;height:11px;filter:invert(50%) sepia(85%) saturate(1000%) hue-rotate(10deg);" alt=""> Ends today</span>`
    };
  } else if (diffDays === 1) {
    return {
      days: 1,
      label: "1 day left",
      pillHtml: `<span class="pill" style="font-size:11px;padding:2px 8px;font-weight:600;background:#FFF7ED;color:#C2410C;border:1px solid #FFEDD5;display:inline-flex;align-items:center;gap:4px;" title="1 day remaining in sprint"><img src="image/timer.svg" class="app-icon" style="width:11px;height:11px;" alt=""> 1 day left</span>`
    };
  } else {
    return {
      days: diffDays,
      label: `${diffDays} days left`,
      pillHtml: `<span class="pill" style="font-size:11px;padding:2px 8px;font-weight:600;background:var(--primary-light);color:var(--text-orange);border:1px solid var(--primary-border);display:inline-flex;align-items:center;gap:4px;" title="${diffDays} days remaining in sprint"><img src="image/timer.svg" class="app-icon" style="width:11px;height:11px;" alt=""> ${diffDays} days left</span>`
    };
  }
}

function renderProjectShell() {
  const p = findProject(activeProjectId);
  if (!p) return;
  const isOwner = currentUser && (p.owner_id === currentUser.id || currentUser.role === "admin");
  const sprintDaysLeft = formatSprintDaysLeft(p.sprint_end_date, p.completed);
  const sprintDatesPill = (p.sprint_start_date && p.sprint_end_date)
    ? `<span class="pill" style="font-size:11px;padding:2px 8px;display:inline-flex;align-items:center;gap:4px;" title="Sprint Duration"><img src="image/calendar.svg" class="app-icon" style="width:12px;height:12px;" alt=""> ${esc(p.sprint_start_date)} to ${esc(p.sprint_end_date)}${sprintDaysLeft ? ` · <strong style="color:var(--text-orange);">${sprintDaysLeft.label}</strong>` : ""}</span>`
    : (sprintDaysLeft ? sprintDaysLeft.pillHtml : "");
  const c = byId("content");
  c.innerHTML = `
    <div class="project-title-row">
      <h1 class="${p.completed ? "strikeout" : ""}" style="margin:0">${esc(p.name)}</h1>
      <span class="pill ${p.completed ? "strikeout" : ""}">${esc(p.key)}</span>
      ${sprintDatesPill}
      ${p.completed ? `<span class="pill status-done sprint-done-pill" style="font-size:11px;padding:2px 8px;display:inline-flex;align-items:center;gap:4px;"><img src="image/check.svg" class="app-icon" style="width:12px;height:12px;" alt=""> Sprint Completed</span>` : ""}
      <button class="star-toggle ${p.starred ? "active" : ""}" id="starToggle" title="Star project" style="background:transparent;border:none;cursor:pointer;padding:4px;display:inline-flex;align-items:center;">
        <img src="image/${p.starred ? "star-filled.svg" : "star.svg"}" class="app-icon ${p.starred ? "no-invert" : ""}" style="width:18px;height:18px;" alt="Star">
      </button>
      <span style="flex:1"></span>
      ${isOwner ? `<button class="secondary" id="projectEditBtn" style="font-size:13px;padding:6px 12px;display:inline-flex;align-items:center;gap:6px;" title="Edit Sprint Dates and Details"><img src="image/calendar.svg" class="app-icon btn-icon" alt=""> Sprint Dates</button>` : ""}
      ${isAdmin() ? `<button class="secondary" id="projectInviteBtn" style="font-size:13px;padding:6px 12px;display:inline-flex;align-items:center;"><img src="image/user-plus.svg" class="app-icon btn-icon" alt=""> Invite User</button>` : ""}
    </div>
    <p class="muted ${p.completed ? "strikeout" : ""}" style="margin:4px 0 0">${esc(p.description || "")}</p>
    <div class="project-tabs">
      <button class="tab-btn" data-tab="summary">Dashboard</button>
      <button class="tab-btn" data-tab="board">Board</button>
      <button class="tab-btn" data-tab="backlog">Backlog</button>
      <button class="tab-btn" data-tab="timeline">Timeline</button>
    </div>
    <div id="tabContent"></div>`;

  byId("starToggle").onclick = async () => {
    const res = await api(`/projects/${p.id}/star`, { method: "POST" });
    p.starred = res.starred;
    renderProjectShell();
  };

  const pEditBtn = byId("projectEditBtn");
  if (pEditBtn) pEditBtn.onclick = () => openProjectModal(p);

  const pInviteBtn = byId("projectInviteBtn");
  if (pInviteBtn) pInviteBtn.onclick = () => openInviteModal(p.id);

  document.querySelectorAll(".tab-btn").forEach(b => b.onclick = () => setTab(b.dataset.tab));
  setTab(activeTab);
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => {
    const isMatch = b.dataset.tab === tab || ((tab === "dashboard" || tab === "summary") && b.dataset.tab === "summary");
    b.classList.toggle("active", isMatch);
  });
  if (tab === "summary" || tab === "dashboard") renderDashboardTab();
  else if (tab === "backlog") renderBacklogTab();
  else if (tab === "board") renderBoardTab();
  else if (tab === "timeline") renderTimelineTab();
  saveRoute();
}

function openIssueById(id) {
  const issue = issues.find(x => x.id === id);
  if (issue) {
    openIssueModal(issue);
  } else {
    api(`/issues/${id}`).then(i => {
      if (i) openIssueModal(i);
    }).catch(err => {
      showToast(err.message || "Failed to load task details", "error");
    });
  }
}

async function renderDashboardTab() {
  const p = findProject(activeProjectId);
  if (!p) return;
  const c = byId("tabContent");
  c.innerHTML = `<div class="dashboard-shell"><div class="empty" style="padding:40px;text-align:center;"><img src="image/loader.svg" class="app-icon" style="width:28px;height:28px;animation:spin 1s linear infinite;" alt=""> Loading project health dashboard...</div></div>`;

  try {
    const data = await api(`/projects/${activeProjectId}/analytics`);
    const healthClass = (data.health_status || "healthy").toLowerCase().replace(/\s+/g, "-");
    const summary = data.summary || {};
    const time = data.time_tracking || {};
    const statuses = data.status_distribution || [];
    const priorities = data.priority_distribution || [];
    const workload = data.team_workload || [];
    const overdueList = data.overdue_tasks || [];
    const burndown = data.burndown || [];

    const isOwner = currentUser && (p.owner_id === currentUser.id || currentUser.role === "admin");
    const sprintDays = data.sprint_duration_days || (burndown.length > 1 ? burndown.length - 1 : 7);
    const sprintTitle = `${sprintDays}-Day Sprint Burndown`;
    const sprintDaysLeft = formatSprintDaysLeft(data.sprint_end_date, p.completed);
    const sprintDatesTag = (data.sprint_start_date && data.sprint_end_date)
      ? `<span class="pill" style="font-size:11px;padding:2px 8px;font-weight:500;display:inline-flex;align-items:center;gap:4px;" title="Sprint Duration"><img src="image/calendar.svg" class="app-icon" style="width:11px;height:11px;vertical-align:-1px;margin-right:2px;" alt="">${esc(data.sprint_start_date)} → ${esc(data.sprint_end_date)}${sprintDaysLeft ? ` · <strong style="color:var(--text-orange);">${sprintDaysLeft.label}</strong>` : ""}</span>`
      : "";

    // SVG Burndown calculations
    const totalTasks = summary.total_tasks || 1;
    const chartW = 440;
    const chartH = 140;
    const padL = 30;
    const padR = 20;
    const padT = 20;
    const padB = 25;
    const innerW = chartW - padL - padR;
    const innerH = chartH - padT - padB;
    const n = Math.max(1, burndown.length - 1);

    const getX = (idx) => padL + (idx / n) * innerW;
    const getY = (val) => padT + innerH - (Math.min(totalTasks, Math.max(0, val)) / totalTasks) * innerH;

    const idealPoints = burndown.map((pt, idx) => `${getX(idx)},${getY(pt.ideal)}`).join(" ");

    // Only map actual points for days that have data (not null/undefined)
    const actualCoords = burndown
      .map((pt, idx) => (pt.actual !== null && pt.actual !== undefined ? { x: getX(idx), y: getY(pt.actual), pt, idx } : null))
      .filter(Boolean);

    const actualPoints = actualCoords.map(c => `${c.x},${c.y}`).join(" ");
    let areaPolygon = "";
    if (actualCoords.length > 1) {
      const firstX = actualCoords[0].x;
      const lastX = actualCoords[actualCoords.length - 1].x;
      const baseY = padT + innerH;
      const areaPoints = `${firstX},${baseY} ` + actualPoints + ` ${lastX},${baseY}`;
      areaPolygon = `<polygon points="${areaPoints}" fill="url(#burnGrad)"/>`;
    }

    // Sprint Coverage Calculations
    const sprintDuration = data.sprint_duration_days || (burndown.length > 1 ? burndown.length - 1 : 7);
    const startDt = data.sprint_start_date ? new Date(data.sprint_start_date) : new Date(Date.now() - 7 * 86400000);
    const nowDt = new Date();
    const daysPassed = Math.max(0, Math.floor((nowDt - startDt) / (1000 * 60 * 60 * 24)));
    const timeSpentPct = Math.min(100, Math.max(0, Math.round((daysPassed / Math.max(1, sprintDuration)) * 100)));

    // 1. Scope Coverage
    const doneTasksCount = summary.completed_tasks || 0;
    const realTotalTasks = summary.total_tasks || 0;
    const scopePct = realTotalTasks > 0 ? Math.round((doneTasksCount / realTotalTasks) * 100) : 0;

    // 2. Critical Priority Coverage
    const projIssues = issues || [];
    const critTasks = projIssues.filter(i => {
      const pr = (i.priority || "").toLowerCase();
      return pr === "critical" || pr === "highest" || pr === "high";
    });
    const critDone = critTasks.filter(i => (i.status || "").toLowerCase() === "done").length;
    const critTotal = critTasks.length;
    const critPct = critTotal > 0 ? Math.round((critDone / critTotal) * 100) : 100;
    const critLabel = critTotal === 0 ? "All blockers resolved" : (critPct === 100 ? "All blockers resolved" : `${critDone}/${critTotal} resolved`);

    // 3. Time vs Progress
    const paceDiff = scopePct - timeSpentPct;
    let paceStatus = "On Pace";
    let paceBadgeColor = "#10B981";
    if (paceDiff >= 10) {
      paceStatus = "Ahead of Pace";
      paceBadgeColor = "#10B981";
    } else if (paceDiff < -25) {
      paceStatus = "Behind Pace";
      paceBadgeColor = "#EF4444";
    } else if (paceDiff < -10) {
      paceStatus = "Slightly Behind";
      paceBadgeColor = "#F59E0B";
    }

    // 4. Team Allocation Coverage
    const totalProjMembers = (p.members || []).length || users.length || 1;
    const activeMembers = workload.filter(w => (w.total_assigned || 0) > 0).length;
    const allocPct = totalProjMembers > 0 ? Math.min(100, Math.round((activeMembers / totalProjMembers) * 100)) : 100;

    // Overall Coverage Score
    const overallScore = Math.min(100, Math.max(0, Math.round(
      (scopePct * 0.50) + (allocPct * 0.30) + (Math.max(0, 100 - (summary.overdue_count || 0) * 15) * 0.20)
    )));

    // 5. Work Type Distribution (Features vs. Bugs)
    const bugTasks = projIssues.filter(i => (i.issue_type || "").toLowerCase() === "bug" || /bug|defect|crash/i.test(i.title || ""));
    const bugCount = bugTasks.length;
    const featureCount = Math.max(0, realTotalTasks - bugCount);
    const featurePct = realTotalTasks > 0 ? Math.round((featureCount / realTotalTasks) * 100) : 100;
    const bugPct = 100 - featurePct;

    const activeStatuses = statuses.filter(s => s.count > 0);
    const displayStatuses = activeStatuses.length ? activeStatuses : statuses;

    c.innerHTML = `
      <div class="dashboard-shell">
        <!-- Health Banner -->
        <div class="health-banner">
          <div class="health-banner-left">
            <div class="health-score-badge ${healthClass}">
              <span class="health-score-val">${data.health_score}</span>
              <span class="health-score-sub">/ 100</span>
            </div>
            <div class="health-title-group">
              <h3>
                Project Health
                <span class="health-status-chip ${healthClass}">${esc(data.health_status)}</span>
                ${p.completed ? `<span class="pill status-done sprint-done-pill" style="font-size:11px;padding:2px 8px;display:inline-flex;align-items:center;gap:4px;"><img src="image/check.svg" class="app-icon" style="width:12px;height:12px;" alt=""> Sprint Completed</span>` : ""}
              </h3>
              <p class="muted" style="margin:2px 0 0;font-size:12.5px;">${esc(p.name)} · ${esc(p.description || "Real-time project health & performance metrics")}</p>
            </div>
          </div>
          <div class="health-banner-metrics">
            <div class="health-metric-box">
              <span class="label">Completion</span>
              <span class="value" style="color:var(--status-success);">${summary.completion_percentage || 0}%</span>
            </div>
            <div class="health-metric-box">
              <span class="label">Overdue Risk</span>
              <span class="value" style="color:${(summary.overdue_count || 0) > 0 ? "var(--status-error)" : "var(--status-success)"};">${summary.overdue_count || 0} tasks</span>
            </div>
            <div class="health-metric-box">
              <span class="label">Time Spent</span>
              <span class="value">${time.total_logged_hours || 0}h / ${time.total_estimated_hours || 0}h</span>
            </div>
            <div class="health-metric-box">
              <span class="label">Sprint Left</span>
              <span class="value" style="color:${sprintDaysLeft && sprintDaysLeft.days < 0 ? "var(--status-error)" : "var(--text-orange)"};">${sprintDaysLeft ? sprintDaysLeft.label : "—"}</span>
            </div>
          </div>
        </div>

        <!-- 5 KPI Cards -->
        <div class="dashboard-kpi-grid">
          <div class="dash-kpi-card">
            <div class="dash-kpi-icon kpi-blue"><img src="image/clipboard.svg" class="app-icon" alt=""></div>
            <div class="dash-kpi-info">
              <span class="dash-kpi-val">${summary.total_tasks || 0}</span>
              <span class="dash-kpi-lbl">Total Tasks</span>
            </div>
          </div>
          <div class="dash-kpi-card">
            <div class="dash-kpi-icon kpi-orange"><img src="image/bolt.svg" class="app-icon" alt=""></div>
            <div class="dash-kpi-info">
              <span class="dash-kpi-val">${summary.in_progress_tasks || 0}</span>
              <span class="dash-kpi-lbl">In Progress</span>
            </div>
          </div>
          <div class="dash-kpi-card">
            <div class="dash-kpi-icon kpi-green"><img src="image/check-circle.svg" class="app-icon" alt=""></div>
            <div class="dash-kpi-info">
              <span class="dash-kpi-val">${summary.completed_tasks || 0}</span>
              <span class="dash-kpi-lbl">Completed</span>
            </div>
          </div>
          <div class="dash-kpi-card">
            <div class="dash-kpi-icon kpi-red"><img src="image/alert-triangle.svg" class="app-icon" alt=""></div>
            <div class="dash-kpi-info">
              <span class="dash-kpi-val" style="color:${(summary.overdue_count || 0) > 0 ? "#DC2626" : "inherit"};">${summary.overdue_count || 0}</span>
              <span class="dash-kpi-lbl">Overdue</span>
            </div>
          </div>
          <div class="dash-kpi-card">
            <div class="dash-kpi-icon kpi-purple"><img src="image/timer.svg" class="app-icon" alt=""></div>
            <div class="dash-kpi-info">
              <span class="dash-kpi-val">${time.progress_percentage || 0}%</span>
              <span class="dash-kpi-lbl">Hours (${time.total_logged_hours || 0}h / ${time.total_estimated_hours || 0}h)</span>
            </div>
          </div>
        </div>

        <!-- 2-Column Analytics Sections -->
        <div class="dashboard-grid-2">
          <!-- Overall Sprint Coverage Card -->
          <div class="dash-card">
            <div class="dash-card-head">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <h4 style="margin:0;"><img src="image/trending-up.svg" class="app-icon" alt=""> Overall Sprint Coverage</h4>
                ${sprintDatesTag}
              </div>
              <div>
                ${isOwner ? `<button type="button" class="secondary small" id="editSprintDatesBtn" title="Edit Project Sprint Dates" style="padding:3px 8px;font-size:11px;display:inline-flex;align-items:center;gap:4px;"><img src="image/calendar.svg" class="app-icon" style="width:11px;height:11px;" alt=""> Edit Dates</button>` : ""}
              </div>
            </div>

            <!-- Sprint Coverage Content -->
            <div class="sprint-coverage-wrap">
              <div class="coverage-score-banner">
                <span style="font-weight:700;color:var(--text-primary);font-size:12.5px;">Overall Score: <strong>${overallScore}%</strong></span>
                <span class="pill" style="font-size:10.5px;font-weight:700;background:var(--bg-surface);color:${paceBadgeColor};border:1px solid ${paceBadgeColor};padding:2px 8px;">${paceStatus}</span>
              </div>

              <!-- Scope Coverage -->
              <div class="coverage-metric-row">
                <div class="coverage-metric-head">
                  <span class="coverage-metric-title">Scope Completion</span>
                  <span class="coverage-metric-info">${scopePct}% (${doneTasksCount}/${realTotalTasks} tasks done)</span>
                </div>
                <div class="coverage-bar-track">
                  <div class="coverage-bar-fill" style="width:${scopePct}%;background:linear-gradient(90deg, #3B82F6, #60A5FA);"></div>
                </div>
              </div>

              <!-- Team Allocation -->
              <div class="coverage-metric-row">
                <div class="coverage-metric-head">
                  <span class="coverage-metric-title">Team Utilization</span>
                  <span class="coverage-metric-info">${allocPct}% (${activeMembers}/${totalProjMembers} members active)</span>
                </div>
                <div class="coverage-bar-track">
                  <div class="coverage-bar-fill" style="width:${allocPct}%;background:linear-gradient(90deg, #8B5CF6, #A78BFA);"></div>
                </div>
              </div>

              <!-- Work Type Distribution (Features vs. Bugs) -->
              <div class="worktype-section">
                <div class="worktype-head">
                  <span>Work Type Distribution</span>
                  <span class="muted" style="font-size:11px;font-weight:normal;">Features vs. Bugs</span>
                </div>
                <div class="worktype-bar-track">
                  <div class="worktype-segment" style="width:${featurePct}%;background:#3B82F6;" title="Features: ${featureCount} (${featurePct}%)"></div>
                  <div class="worktype-segment" style="width:${bugPct}%;background:#EF4444;" title="Bugs: ${bugCount} (${bugPct}%)"></div>
                </div>
                <div class="worktype-legend">
                  <div class="worktype-legend-item">
                    <span class="worktype-dot" style="background:#3B82F6;"></span>
                    <span><strong>Features:</strong> ${featureCount} (${featurePct}%)</span>
                  </div>
                  <div class="worktype-legend-item">
                    <span class="worktype-dot" style="background:#EF4444;"></span>
                    <span><strong>Bugs:</strong> ${bugCount} (${bugPct}%)</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Status & Priority Distribution -->
          <div class="dash-card">
            <div class="dash-card-head">
              <h4><img src="image/layers.svg" class="app-icon" alt=""> Status Distribution</h4>
              <span class="pill" style="font-size:11px;padding:2px 8px;font-weight:600;">${summary.total_tasks || 0} Total Tasks</span>
            </div>
            <div class="stacked-progress-bar">
              ${statuses.map(s => `
                <div class="stacked-segment" style="width:${s.percentage}%;background:${s.color || '#3B82F6'};" title="${esc(s.name)}: ${s.count} (${s.percentage}%)"></div>
              `).join("")}
            </div>
            <div class="status-legend-list">
              ${displayStatuses.map(s => {
      const displayName = s.name.charAt(0).toUpperCase() + s.name.slice(1);
      return `
                <div class="status-legend-item">
                  <span class="status-legend-dot" style="background:${s.color || '#3B82F6'};"></span>
                  <span style="font-weight:600;color:var(--text-primary);">${esc(displayName)}:</span>
                  <span class="muted">${s.count} (${s.percentage}%)</span>
                </div>`;
    }).join("")}
            </div>

            <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border-subtle);">
              <div style="font-size:11px;font-weight:800;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em;">Priority Breakdown</div>
              <div class="priority-bars-list">
                ${priorities.map(pr => {
      const pct = totalTasks > 0 ? Math.round((pr.count / totalTasks) * 100) : 0;
      return `
                    <div class="priority-bar-row">
                      <span style="font-weight:600;color:var(--text-primary);font-size:12px;">${esc(pr.priority)}</span>
                      <div class="prio-bar-track">
                        <div class="prio-bar-fill" style="width:${pct}%;background:${pr.color};"></div>
                      </div>
                      <span class="prio-count-chip">${pr.count}</span>
                    </div>`;
    }).join("")}
              </div>
            </div>
          </div>

          <!-- Team Workload Matrix -->
          <div class="dash-card" style="grid-column: 1 / -1;">
            <div class="dash-card-head">
              <h4><img src="image/users.svg" class="app-icon" alt=""> Team Workload & Time Allocation</h4>
              <span class="pill" style="font-size:11px;padding:2px 8px;font-weight:600;">${workload.length} Members</span>
            </div>
            <div class="workload-table-container">
              <table class="workload-table">
                <thead>
                  <tr>
                    <th style="width:25%;">Member</th>
                    <th style="width:12%;">Role</th>
                    <th style="width:10%;text-align:center;">Assigned</th>
                    <th style="width:11%;text-align:center;">In Progress</th>
                    <th style="width:11%;text-align:center;">Completed</th>
                    <th style="width:10%;text-align:center;">Overdue</th>
                    <th style="width:21%;">Logged vs Estimated</th>
                  </tr>
                </thead>
                <tbody>
                  ${workload.length === 0 ? `<tr><td colspan="7" class="empty" style="text-align:center;padding:32px;">No team members assigned yet.</td></tr>` : workload.map(m => {
      const estHours = Math.round(m.estimated_days * 8);
      const logHours = Math.round(m.logged_hours * 10) / 10;
      const timePct = estHours > 0 ? Math.min(100, Math.round((logHours / estHours) * 100)) : 0;
      const isOver = logHours > estHours && estHours > 0;
      const roleColor = (m.role || "").toLowerCase() === "admin" ? "var(--text-orange)" : "var(--text-secondary)";
      const roleBg = (m.role || "").toLowerCase() === "admin" ? "rgba(242, 106, 27, 0.1)" : "var(--slate-100)";
      return `
                      <tr>
                        <td>
                          <div style="display:flex;align-items:center;gap:10px;">
                            <span class="assignee-chip" style="width:26px;height:26px;font-size:10.5px;">${esc(initials(m.name))}</span>
                            <div style="overflow:hidden;">
                              <div style="font-weight:600;color:var(--text-primary);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.name)}</div>
                              <div class="muted" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.email)}</div>
                            </div>
                          </div>
                        </td>
                        <td><span class="pill" style="font-size:10.5px;text-transform:capitalize;background:${roleBg};color:${roleColor};border:none;">${esc(m.role || "member")}</span></td>
                        <td style="text-align:center;"><strong style="font-size:13px;">${m.total_assigned}</strong></td>
                        <td style="text-align:center;">${m.in_progress > 0 ? `<span style="color:#F97316;font-weight:700;">${m.in_progress}</span>` : `<span class="muted">—</span>`}</td>
                        <td style="text-align:center;">${m.completed > 0 ? `<span style="color:#10B981;font-weight:700;">${m.completed}</span>` : `<span class="muted">—</span>`}</td>
                        <td style="text-align:center;">${m.overdue > 0 ? `<span style="color:#EF4444;font-weight:700;">${m.overdue}</span>` : `<span class="muted">—</span>`}</td>
                        <td>
                          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px;">
                            <span style="font-weight:600;color:var(--text-primary);">${logHours}h logged</span>
                            <span class="muted">${estHours}h est ${estHours > 0 ? `(${timePct}%)` : ""}</span>
                          </div>
                          <div style="height:6px;background:var(--border-subtle);border-radius:3px;overflow:hidden;">
                            <div style="height:100%;width:${timePct}%;background:${isOver ? '#EF4444' : 'var(--primary)'};border-radius:3px;transition:width 0.3s ease;"></div>
                          </div>
                        </td>
                      </tr>`;
    }).join("")}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Overdue Tasks Radar -->
          <div class="dash-card" style="grid-column: 1 / -1;">
            <div class="dash-card-head">
              <h4><img src="image/alert-circle.svg" class="app-icon" alt=""> Overdue Tasks Radar (${overdueList.length})</h4>
              ${overdueList.length > 0 ? `<span style="color:#EF4444;font-weight:600;font-size:11.5px;">Urgent attention required</span>` : `<span style="color:#10B981;font-weight:600;font-size:11.5px;">All tasks on schedule</span>`}
            </div>
            ${overdueList.length === 0 ? `
              <div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:20px 16px;background:rgba(16, 185, 129, 0.05);border:1px dashed rgba(16, 185, 129, 0.25);border-radius:var(--radius-md);">
                <img src="image/check-circle.svg" class="app-icon" style="width:22px;height:22px;filter:invert(50%) sepia(85%) saturate(600%) hue-rotate(95deg);" alt="">
                <div><strong style="color:var(--text-primary);font-size:13px;">All tasks are on track!</strong><span class="muted" style="font-size:12px;margin-left:6px;">There are no overdue tasks in this project right now.</span></div>
              </div>
            ` : `
              <div class="overdue-list">
                ${overdueList.map(item => `
                  <div class="overdue-item" onclick="openIssueById('${item.id}')">
                    <div style="display:flex;align-items:center;gap:10px;">
                      <span class="task-key" style="font-size:11.5px;">${esc(item.key)}</span>
                      <span class="overdue-item-title">${esc(item.title)}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <span class="pill prio-${(item.priority || "medium").toLowerCase()}" style="font-size:10px;">${esc(item.priority)}</span>
                      <span class="due-chip overdue" style="font-size:10.5px;">Due: ${esc(formatDate(item.due_date))}</span>
                      <span class="muted" style="font-size:11px;">${esc(item.assignee_name)}</span>
                    </div>
                  </div>
                `).join("")}
              </div>
            `}
          </div>
        </div>
      </div>`;

    const editDatesBtn = byId("editSprintDatesBtn");
    if (editDatesBtn) {
      editDatesBtn.onclick = () => openProjectModal(p);
    }
  } catch (err) {
    c.innerHTML = `<div class="dashboard-shell"><div class="empty" style="color:var(--status-error);">Failed to load analytics: ${esc(err.message)}</div></div>`;
  }
}

function renderTimelineTab() {
  const p = findProject(activeProjectId);
  if (!p) return;
  const c = byId("tabContent");

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Generate 21 consecutive days centered around today (starting 4 days ago)
  const daysCount = 21;
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 4);

  const days = [];
  for (let i = 0; i < daysCount; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
    const dayNum = d.getDate();
    const isToday = d.getTime() === today.getTime();
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const ymd = d.toISOString().slice(0, 10);
    days.push({ date: d, dayName, dayNum, isToday, isWeekend, ymd });
  }

  const todayIndex = days.findIndex(d => d.isToday);
  const cellWidth = 44;
  const todayMarkLeft = todayIndex >= 0 ? todayIndex * cellWidth + Math.round(cellWidth / 2) : -100;

  c.innerHTML = `
    <div class="timeline-shell">
      <div class="timeline-toolbar">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-weight:700;font-size:15px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
            <img src="image/calendar.svg" class="app-icon" alt=""> Project Timeline & Gantt
          </span>
          <span class="pill" style="font-size:11px;">${issues.length} Tasks Scheduled</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${isAdmin() ? `<button class="primary" onclick="openIssueModal()"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> New Task</button>` : ""}
        </div>
      </div>

      <div class="timeline-frame">
        <!-- Fixed Left Sidebar -->
        <div class="timeline-sidebar">
          <div class="timeline-sidebar-head">Tasks (${issues.length})</div>
          <div class="timeline-sidebar-rows">
            ${issues.length === 0 ? `<div class="empty" style="padding:20px;font-size:12px;">No tasks yet</div>` : issues.map(i => {
    const prioClass = `prio-${(i.priority || "medium").toLowerCase()}`;
    return `
                <div class="timeline-sidebar-row" onclick="openIssueById('${i.id}')" title="Click to view/edit">
                  <span class="task-key" style="font-size:11px;">${esc(issueKey(i))}</span>
                  <span style="font-size:12px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(i.title)}</span>
                  ${i.is_blocked ? `<span class="blocked-card-chip" style="font-size:9.5px;padding:1px 4px;">Blocked</span>` : ""}
                  ${i.assignee_id ? `<span class="assignee-chip" style="width:20px;height:20px;font-size:9.5px;">${esc(initials(userLabel(i.assignee_id)))}</span>` : ""}
                </div>`;
  }).join("")}
          </div>
        </div>

        <!-- Scrollable Timeline Grid -->
        <div class="timeline-grid-wrap">
          <div class="timeline-canvas-inner" style="width:${daysCount * cellWidth}px;">
            <!-- Day Headers -->
            <div class="timeline-canvas-head">
              ${days.map(d => `
                <div class="timeline-day-cell ${d.isToday ? "is-today" : ""} ${d.isWeekend ? "is-weekend" : ""}">
                  <span style="font-size:9.5px;opacity:0.8;">${d.dayName}</span>
                  <span style="font-size:12px;font-weight:700;">${d.dayNum}</span>
                </div>
              `).join("")}
            </div>

            <!-- Task Bar Rows -->
            <div class="timeline-canvas-rows" style="position:relative;">
              <div class="timeline-today-mark" style="left:${todayMarkLeft}px;"></div>

              <div class="timeline-grid-lines">
                ${days.map(() => `<div class="timeline-grid-line"></div>`).join("")}
              </div>

              ${issues.map(i => {
    const dueStr = i.due_date ? String(i.due_date).slice(0, 10) : null;
    const startStr = i.start_date ? String(i.start_date).slice(0, 10) : (i.created_at ? String(i.created_at).slice(0, 10) : null);

    let startIdx = 0;
    let endIdx = 0;

    if (dueStr) {
      const dueDate = new Date(dueStr);
      dueDate.setHours(0, 0, 0, 0);
      const diffDays = Math.round((dueDate - startDate) / (86400000));
      endIdx = Math.max(0, Math.min(daysCount - 1, diffDays));
    } else {
      endIdx = Math.min(daysCount - 1, todayIndex + 2);
    }

    if (startStr) {
      const sDate = new Date(startStr);
      sDate.setHours(0, 0, 0, 0);
      const diffDays = Math.round((sDate - startDate) / (86400000));
      startIdx = Math.max(0, Math.min(endIdx, diffDays));
    } else {
      startIdx = Math.max(0, endIdx - Math.max(1, Math.round(i.estimation || 1)));
    }

    if (startIdx > endIdx) startIdx = endIdx;

    const barLeft = startIdx * cellWidth + 4;
    const barWidth = Math.max(34, (endIdx - startIdx + 1) * cellWidth - 8);

    const statusLower = (i.status || "").toLowerCase();
    let barBg = "#6B7280";
    if (statusLower === "done") barBg = "#10B981";
    else if (statusLower === "in progress" || statusLower === "inprogress") barBg = "#F26A1B";
    else if (i.is_blocked) barBg = "#DC2626";

    return `
                  <div class="timeline-canvas-row">
                    <div class="timeline-task-bar" style="left:${barLeft}px;width:${barWidth}px;background:${barBg};" onclick="openIssueById('${i.id}')" title="${esc(issueKey(i))}: ${esc(i.title)} | Due: ${esc(formatDate(i.due_date))} | Logged: ${i.logged_hours || 0}h">
                      <span>${esc(issueKey(i))}</span>
                      <span style="margin-left:5px;opacity:0.9;">${esc(i.title)}</span>
                    </div>
                  </div>`;
  }).join("")}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderBacklogTab() {
  const c = byId("tabContent");
  c.innerHTML = `
    <div class="backlog-toolbar">
      <div class="backlog-toolbar-left">
        <h3 class="backlog-heading">Backlog <span class="backlog-count-badge">${issues.length}</span></h3>
        <p class="muted backlog-subtext">Manage, prioritize, and track all tasks in this project.</p>
      </div>
      <div class="backlog-toolbar-right">
        ${isAdmin() ? `<button class="primary" onclick="openIssueModal()"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> New Task</button>` : ""}
      </div>
    </div>
    <div class="backlog-table-container">
      <div class="backlog-head">
        <div>Task</div>
        <div>Priority</div>
        <div>Status</div>
        <div>Due Date</div>
        <div>Logged / Est</div>
        <div>Assignee</div>
      </div>
      <div id="backlogRows"></div>
    </div>`;
  const rows = byId("backlogRows");
  if (!issues.length) {
    rows.innerHTML = `<div class="empty" style="padding:48px 16px;">No tasks yet. Create one to get started.</div>`;
    return;
  }
  rows.innerHTML = issues.map(i => {
    const overdue = i.status !== "Done" && isOverdue(i.due_date);
    const prioClass = `prio-${(i.priority || "medium").toLowerCase()}`;
    const statusClass = `status-${(i.status || "todo").toLowerCase().replace(/\s+/g, "")}`;
    const estHours = (i.estimation || 1) * 8;
    const logHours = i.logged_hours || 0;
    const isOver = logHours > estHours;
    const isBug = (i.issue_type || "").toLowerCase() === "bug";
    const typeBadge = isBug
      ? `<span class="task-type-badge bug" title="Bug"><span class="task-type-dot bug"></span>Bug</span>`
      : `<span class="task-type-badge feature" title="Feature"><span class="task-type-dot feature"></span>Feature</span>`;
    const assigneeName = i.assignee_id ? userLabel(i.assignee_id) : "";
    return `
    <div class="backlog-row" data-issue="${i.id}">
      <div class="b-title">
        <span class="backlog-key">${esc(issueKey(i))}</span>
        ${typeBadge}
        <span class="backlog-title-text" title="${esc(i.title)}">${esc(i.title)}</span>
        ${i.is_blocked ? `<span class="backlog-blocked-chip">🛑 Blocked</span>` : ""}
      </div>
      <div><span class="pill ${prioClass}">${esc(i.priority || "Medium")}</span></div>
      <div><span class="pill ${statusClass}">${esc(i.status)}</span></div>
      <div>${i.due_date ? `<span class="due-chip ${overdue ? "overdue" : ""}">${esc(formatDate(i.due_date))}</span>` : '<span class="backlog-empty-dash">—</span>'}</div>
      <div>
        <span class="time-card-chip ${isOver ? "over" : ""}" title="Logged: ${logHours}h / Estimated: ${estHours}h">
          <img src="image/timer.svg" class="app-icon" style="width:11px;height:11px;" alt=""> ${logHours}h / ${estHours}h
        </span>
      </div>
      <div>
        ${i.assignee_id ? `
          <div class="backlog-assignee">
            <span class="assignee-chip" style="width:22px;height:22px;font-size:10px;">${esc(initials(assigneeName))}</span>
            <span class="assignee-name" title="${esc(assigneeName)}">${esc(assigneeName)}</span>
          </div>` : `
          <div class="backlog-assignee unassigned">
            <span class="assignee-empty-dot"></span>
            <span>Unassigned</span>
          </div>`}
      </div>
    </div>`;
  }).join("");
  rows.querySelectorAll("[data-issue]").forEach(el => el.onclick = () => {
    openIssueById(el.dataset.issue);
  });
}

// ================= Realtime & Board Sync =================

function connectProjectWebSocket(projectId) {
  disconnectProjectWebSocket();

  const token = localStorage.getItem("clove_token");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = (window.CLOVE_CONFIG && window.CLOVE_CONFIG.getWsUrl)
    ? window.CLOVE_CONFIG.getWsUrl(projectId, token)
    : `${protocol}//127.0.0.1:8000/ws/projects/${projectId}?token=${encodeURIComponent(token || "")}`;

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
    try { projectSocket.close(); } catch { }
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
    } else {
      refreshCurrentTab();
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
    } else {
      refreshCurrentTab();
    }
  } else if (msg.type === "issue_deleted") {
    issues = issues.filter(i => i.id !== msg.issue_id);
    refreshCurrentTab();
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
  } else if (msg.type === "user_mentioned") {
    const myId = currentUser ? (currentUser.id || currentUser._id || "") : "";
    if (myId && String(msg.target_user_id) === String(myId)) {
      showToast(`🔔 ${msg.message}`, "info");
      api("/notifications").then(notifs => {
        notifications = notifs || [];
        renderNotifications();
      }).catch(() => { });
    }
  }
}

function refreshCurrentTab() {
  if (activeTab === "board") {
    const settings = getBoardSettings(activeProjectId);
    renderBoardColumns(settings.showDueDates !== false);
  } else if (activeTab === "backlog") {
    renderBacklogTab();
  } else if (activeTab === "summary" || activeTab === "dashboard") {
    renderDashboardTab();
  } else if (activeTab === "timeline") {
    renderTimelineTab();
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
        refreshCurrentTab();
      }
    } catch { }
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

function getProjectStatuses(projId) {
  const p = findProject(projId);
  const defMap = {
    "to do": "#6B7280",
    "in progress": "#3B82F6",
    "hold": "#F59E0B",
    "on hold": "#F59E0B",
    "done": "#10B981"
  };
  let list = [];
  if (p && p.statuses && Array.isArray(p.statuses) && p.statuses.length) {
    list = p.statuses.map(s => {
      if (typeof s === "string") {
        const low = s.toLowerCase();
        return { name: s, color: defMap[low] || "#3B82F6", category: (low === "hold" || low === "on hold") ? "hold" : "inprogress" };
      }
      const low = (s.name || "").toLowerCase();
      let col = s.color;
      // Normalize legacy brown color on in-progress to standard blue
      if (low === "in progress" && (!col || col === "#A16207")) {
        col = "#3B82F6";
      }
      if ((low === "hold" || low === "on hold") && (!col || col === "#A16207")) {
        col = "#F59E0B";
      }
      return {
        name: s.name || "Custom",
        color: col || defMap[low] || "#3B82F6",
        category: s.category || ((low === "hold" || low === "on hold") ? "hold" : "inprogress")
      };
    });
  } else {
    list = [
      { name: "To Do", color: "#6B7280", category: "todo" },
      { name: "In Progress", color: "#3B82F6", category: "inprogress" },
      { name: "Hold", color: "#F59E0B", category: "hold" },
      { name: "Done", color: "#10B981", category: "done" }
    ];
  }

  // Only show Hold status when at least one task is blocked (or on Hold)
  const projIssues = (issues || []).filter(i => String(i.project_id) === String(projId));
  const currentIssues = projIssues.length ? projIssues : (issues || []);
  const anyBlocked = currentIssues.some(i => {
    return i.is_blocked || (i.status || "").trim().toLowerCase() === "hold" || (i.status || "").trim().toLowerCase() === "on hold";
  });

  if (anyBlocked) {
    const hasHold = list.some(s => {
      const low = (s.name || "").trim().toLowerCase();
      return low === "hold" || low === "on hold";
    });
    if (!hasHold) {
      const doneIdx = list.findIndex(s => (s.name || "").trim().toLowerCase() === "done");
      const holdObj = { name: "Hold", color: "#F59E0B", category: "hold" };
      if (doneIdx !== -1) {
        list.splice(doneIdx, 0, holdObj);
      } else {
        list.push(holdObj);
      }
    }
  } else {
    // No one is blocked: do NOT show Hold status!
    list = list.filter(s => {
      const low = (s.name || "").trim().toLowerCase();
      return low !== "hold" && low !== "on hold";
    });
  }

  return list;
}

function openWorkflowSettingsModal() {
  const p = findProject(activeProjectId);
  if (!p) return;

  const currentStatuses = JSON.parse(JSON.stringify(getProjectStatuses(activeProjectId)));

  const renderList = () => {
    const listEl = byId("wfStatusList");
    if (!listEl) return;
    listEl.innerHTML = currentStatuses.map((st, idx) => {
      const isCoreDefault = ["to do", "in progress", "hold", "on hold", "done"].includes((st.name || "").trim().toLowerCase());
      const canDelete = !isCoreDefault && currentStatuses.length > 4;
      return `
      <div class="workflow-col-row" data-idx="${idx}" draggable="true">
        <label class="workflow-color-preview" style="background:${st.color || '#3B82F6'};" title="Click to choose status color">
          <input type="color" class="workflow-color-circle" value="${st.color || '#3B82F6'}" data-idx="${idx}">
        </label>
        <input type="text" class="workflow-col-input" value="${esc(st.name)}" data-idx="${idx}">
        <select class="workflow-category-select" data-idx="${idx}">
          <option value="todo" ${st.category === "todo" ? "selected" : ""}>To Do</option>
          <option value="inprogress" ${st.category === "inprogress" ? "selected" : ""}>In Progress</option>
          <option value="done" ${st.category === "done" ? "selected" : ""}>Done</option>
        </select>
        <div class="workflow-drag-handle" title="Drag to reorder column" data-idx="${idx}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="2"/>
            <circle cx="15" cy="6" r="2"/>
            <circle cx="9" cy="12" r="2"/>
            <circle cx="15" cy="12" r="2"/>
            <circle cx="9" cy="18" r="2"/>
            <circle cx="15" cy="18" r="2"/>
          </svg>
        </div>
        ${canDelete ? `<button type="button" class="danger-btn" onclick="deleteWorkflowStatus(${idx})" title="Delete status">✕</button>` : ""}
      </div>
    `;
    }).join("");

    listEl.querySelectorAll(".workflow-col-input").forEach(inp => {
      inp.oninput = (e) => { currentStatuses[e.target.dataset.idx].name = e.target.value; };
    });

    listEl.querySelectorAll(".workflow-color-circle").forEach(inp => {
      const preview = inp.closest(".workflow-color-preview");
      const updateColor = (e) => {
        currentStatuses[e.target.dataset.idx].color = e.target.value;
        if (preview) preview.style.backgroundColor = e.target.value;
      };
      inp.oninput = updateColor;
      inp.onchange = updateColor;
    });

    listEl.querySelectorAll(".workflow-category-select").forEach(sel => {
      sel.onchange = (e) => { currentStatuses[e.target.dataset.idx].category = e.target.value; };
    });

    // Drag and Drop implementation
    let dragSrcIdx = null;
    const rows = listEl.querySelectorAll(".workflow-col-row");
    rows.forEach(row => {
      row.addEventListener("dragstart", (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "BUTTON") {
          e.preventDefault();
          return;
        }
        dragSrcIdx = parseInt(row.dataset.idx, 10);
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragSrcIdx));
      });

      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        rows.forEach(r => r.classList.remove("drag-over-top", "drag-over-bottom"));
        dragSrcIdx = null;
      });

      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const targetIdx = parseInt(row.dataset.idx, 10);
        if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;

        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        rows.forEach(r => r.classList.remove("drag-over-top", "drag-over-bottom"));
        if (e.clientY < midY) {
          row.classList.add("drag-over-top");
        } else {
          row.classList.add("drag-over-bottom");
        }
      });

      row.addEventListener("dragleave", () => {
        row.classList.remove("drag-over-top", "drag-over-bottom");
      });

      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const targetIdx = parseInt(row.dataset.idx, 10);
        if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;

        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        let newIdx = e.clientY < midY ? targetIdx : targetIdx + 1;
        if (dragSrcIdx < newIdx) newIdx--;

        const [movedItem] = currentStatuses.splice(dragSrcIdx, 1);
        currentStatuses.splice(newIdx, 0, movedItem);
        renderList();
      });
    });
  };

  window.deleteWorkflowStatus = (idx) => {
    const target = currentStatuses[idx];
    if (target && ["to do", "in progress", "done"].includes((target.name || "").trim().toLowerCase())) {
      showToast("Default workflow status cannot be removed.", "error");
      return;
    }
    if (currentStatuses.length <= 3) {
      showToast("A project must maintain its core workflow statuses.", "error");
      return;
    }
    currentStatuses.splice(idx, 1);
    renderList();
  };

  byId("modal-root").innerHTML = `
    <div class="modal"><div class="modal-card workflow-modal-card">
      <div class="modal-head">
        <h2>Project Workflow & Columns</h2>
        <button class="close" onclick="closeModal()"><img src="image/close.svg" class="app-icon" alt="Close"></button>
      </div>
      <p class="muted" style="margin-top:6px;font-size:13px;">
        Customize columns and task lifecycle for <strong>${esc(p.name)}</strong>. Changes reflect instantly on your Kanban Board, Backlog, and task modals.
      </p>

      <div id="wfStatusList" class="workflow-status-list"></div>

      <div class="workflow-add-box">
        <label class="workflow-color-preview" id="newWfColorPreview" style="background:#8B5CF6;" title="Choose color">
          <input type="color" id="newWfColor" value="#8B5CF6" class="workflow-color-circle">
        </label>
        <input type="text" id="newWfName" style="flex:1;padding:6px 10px;font-size:13px;border-radius:6px;border:1px solid var(--border-default);background:var(--bg-surface);">
        <select id="newWfCat" class="workflow-category-select">
          <option value="todo">To Do</option>
          <option value="inprogress" selected>In Progress</option>
          <option value="done">Done</option>
        </select>
        <button type="button" class="secondary" id="addNewWfBtn" style="font-size:12px;padding:6px 12px;">+ Add</button>
      </div>

      <div class="actions" style="margin-top:20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <button type="button" class="secondary" id="resetWfBtn" title="Reset workflow statuses to default To Do, In Progress, Done" style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
          Reset to Default
        </button>
        <div style="display:flex;gap:10px;align-items:center;">
          <button type="button" class="secondary" onclick="closeModal()">Cancel</button>
          <button type="button" class="primary" id="saveWfBtn">Save Workflow</button>
        </div>
      </div>
    </div></div>`;

  renderList();

  const newColorInp = byId("newWfColor");
  const newColorPrev = byId("newWfColorPreview");
  if (newColorInp && newColorPrev) {
    const updateNewColor = (e) => { newColorPrev.style.backgroundColor = e.target.value; };
    newColorInp.oninput = updateNewColor;
    newColorInp.onchange = updateNewColor;
  }

  byId("addNewWfBtn").onclick = () => {
    const name = byId("newWfName").value.trim();
    if (!name) {
      showToast("Please enter a status name.", "error");
      return;
    }
    const color = byId("newWfColor").value;
    const category = byId("newWfCat").value;
    currentStatuses.push({ name, color, category });
    byId("newWfName").value = "";
    renderList();
  };

  byId("resetWfBtn").onclick = () => {
    currentStatuses.splice(0, currentStatuses.length,
      { name: "To Do", color: "#6B7280", category: "todo" },
      { name: "In Progress", color: "#3B82F6", category: "inprogress" },
      { name: "Done", color: "#10B981", category: "done" }
    );
    renderList();
    showToast("Workflow reset to default (To Do, In Progress, Done)", "info");
  };

  byId("saveWfBtn").onclick = async () => {
    try {
      const res = await api(`/projects/${p.id}/statuses`, {
        method: "PUT",
        body: JSON.stringify({ statuses: currentStatuses })
      });
      p.statuses = res.statuses;
      closeModal();
      showToast("Custom workflow updated successfully!", "success");
      if (activeTab === "board") renderBoardTab();
      else if (activeTab === "backlog") renderBacklogTab();
      else if (activeTab === "summary" || activeTab === "dashboard") renderDashboardTab();
    } catch (err) {
      showToast(err.message || "Failed to update workflow", "error");
    }
  };
}

function renderBoardTab() {
  const c = byId("tabContent");
  const settings = getBoardSettings(activeProjectId);
  const showDue = settings.showDueDates !== false;
  const proj = findProject(activeProjectId);
  const isCompletedProj = proj && proj.completed;
  const colStatuses = getProjectStatuses(activeProjectId);

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
      <button class="secondary" id="workflowSettingsBtn" title="Customize Workflow and Columns">
        <img src="image/settings.svg" class="app-icon btn-icon" alt=""> Workflow
      </button>
      <button class="secondary" id="completeSprintBtn">${isCompletedProj ? "Reopen Sprint" : "Complete Sprint"}</button>
      ${isAdmin() ? `<button class="primary" onclick="openIssueModal()"><img src="image/plus.svg" class="app-icon btn-icon" alt=""> Create Task</button>` : ""}
    </div>
    <div class="board-columns">
      ${colStatuses.map(s => {
    const borderCol = s.color || "#3B82F6";
    return `
        <div class="board-column" data-status="${esc(s.name)}" style="border-top: 3px solid ${borderCol};">
          <div class="board-col-head">
            <h4 style="display:flex;align-items:center;gap:6px;">
              <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${borderCol};"></span>
              ${esc(s.name)}
            </h4>
            <span class="col-count" data-count="${esc(s.name)}">0</span>
          </div>
          <div class="col-dropzone" data-status="${esc(s.name)}"></div>
        </div>`;
  }).join("")}
    </div>`;

  byId("filterPriority").value = boardFilters.priority;
  byId("filterAssignee").value = boardFilters.assignee_id;
  byId("groupBy").value = boardGroupBy;

  byId("filterPriority").onchange = async (e) => { boardFilters.priority = e.target.value; await reloadBoardIssues(); };
  byId("filterAssignee").onchange = async (e) => { boardFilters.assignee_id = e.target.value; await reloadBoardIssues(); };
  byId("groupBy").onchange = (e) => { boardGroupBy = e.target.value; renderBoardColumns(showDue); };
  byId("workflowSettingsBtn").onclick = () => openWorkflowSettingsModal();

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
  const colStatuses = getProjectStatuses(activeProjectId);

  // If column set changed (e.g. Hold column dynamically appeared or disappeared), re-render board column elements
  const existingColEls = Array.from(document.querySelectorAll(".board-column"));
  const existingColNames = existingColEls.map(c => c.dataset.status);
  const targetColNames = colStatuses.map(s => s.name);
  if (existingColNames.length !== targetColNames.length || !existingColNames.every((n, idx) => n === targetColNames[idx])) {
    const boardColsEl = document.querySelector(".board-columns");
    if (boardColsEl) {
      boardColsEl.innerHTML = colStatuses.map(s => {
        const borderCol = s.color || "#3B82F6";
        return `
        <div class="board-column" data-status="${esc(s.name)}" style="border-top: 3px solid ${borderCol};">
          <div class="board-col-head">
            <h4 style="display:flex;align-items:center;gap:6px;">
              <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${borderCol};"></span>
              ${esc(s.name)}
            </h4>
            <span class="col-count" data-count="${esc(s.name)}">0</span>
          </div>
          <div class="col-dropzone" data-status="${esc(s.name)}"></div>
        </div>`;
      }).join("");
      setupDropzones();
    }
  }

  colStatuses.forEach(st => {
    const status = st.name;
    const col = document.querySelector(`.board-column[data-status="${CSS.escape ? CSS.escape(status) : status}"]`);
    if (col) {
      col.style.borderTop = `3px solid ${st.color || "#3B82F6"}`;
    }
    const zone = document.querySelector(`.col-dropzone[data-status="${CSS.escape ? CSS.escape(status) : status}"]`);
    const countBadge = document.querySelector(`.col-count[data-count="${CSS.escape ? CSS.escape(status) : status}"]`);
    if (!zone || !countBadge) return;

    const columnIssues = issues.filter(i => {
      const s = (i.status || "").trim().toLowerCase();
      const target = status.toLowerCase();

      // Blocked tasks or tasks set to Hold separately come under Hold status column
      if (target === "hold" || target === "on hold") {
        return s === "hold" || s === "on hold" || i.is_blocked;
      }

      // If a task is blocked, it is separately under Hold column, so don't show it in To Do or In Progress
      if (i.is_blocked) {
        return false;
      }

      if (target === "to do") {
        return s === "to do" || s === "todo" || s === "backlog" || !s;
      }
      if (target === "in progress") {
        return s === "in progress" || s === "inprogress";
      }
      if (target === "done") {
        return s === "done";
      }
      return s === target;
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

  const container = document.querySelector(".board-columns");
  if (container && !container.dataset.hasDelegatedClick) {
    container.dataset.hasDelegatedClick = "true";
    container.addEventListener("click", (e) => {
      const card = e.target.closest(".task-card");
      if (!card) return;
      if (cardDidRealDrag) return;
      if (e.target.closest(".card-status-select, button, a, input, select")) return;
      if (Date.now() - lastOpenedModalTime < 350) return;
      const id = card.dataset.id;
      if (id) openIssueById(id);
    });
  }

  document.querySelectorAll(".board-columns .task-card").forEach(card => {
    card.addEventListener("mousedown", (e) => {
      if (e.target.closest(".card-status-select, button, a, input, select")) return;
      cardMouseDownPos = { x: e.clientX, y: e.clientY };
      cardMouseDownTime = Date.now();
      cardDidRealDrag = false;
    });

    card.addEventListener("dragstart", (e) => {
      if (e.target.closest(".card-status-select, button, a, input, select")) {
        e.preventDefault();
        return;
      }
      isDraggingCard = true;
      cardDidRealDrag = false;
      cardDragStartPos = { x: e.clientX, y: e.clientY };
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", card.dataset.id);
      e.dataTransfer.effectAllowed = "move";
    });

    card.addEventListener("drag", (e) => {
      if (e.clientX !== 0 || e.clientY !== 0) {
        if (cardDragStartPos) {
          const dist = Math.hypot(e.clientX - cardDragStartPos.x, e.clientY - cardDragStartPos.y);
          if (dist > 8) {
            cardDidRealDrag = true;
          }
        }
      }
    });

    card.addEventListener("dragend", (e) => {
      card.classList.remove("dragging");
      const wasRealDrag = cardDidRealDrag;
      const endDist = (cardDragStartPos && (e.clientX !== 0 || e.clientY !== 0))
        ? Math.hypot(e.clientX - cardDragStartPos.x, e.clientY - cardDragStartPos.y)
        : 0;

      setTimeout(() => {
        isDraggingCard = false;
        cardDidRealDrag = false;
        cardDragStartPos = null;
      }, 120);

      // If drag ended without real motion (< 8px) and was quick (< 600ms),
      // it was an intended click that the browser converted into a dragstart!
      // Open the modal if click was suppressed by the browser:
      if (!wasRealDrag && endDist < 8 && (Date.now() - cardMouseDownTime < 600)) {
        if (Date.now() - lastOpenedModalTime > 350) {
          openIssueById(card.dataset.id);
        }
      }
    });

    card.addEventListener("click", (e) => {
      if (cardDidRealDrag) return;
      if (e.target.closest(".card-status-select, button, a, input, select")) return;
      if (Date.now() - lastOpenedModalTime < 350) return;
      openIssueById(card.dataset.id);
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
  const isBug = (i.issue_type || "").toLowerCase() === "bug";
  const typeBadge = isBug
    ? `<span class="task-type-badge bug" title="Bug"><span class="task-type-dot bug"></span>Bug</span>`
    : `<span class="task-type-badge feature" title="Feature"><span class="task-type-dot feature"></span>Feature</span>`;

  return `
    <div class="task-card" draggable="true" data-id="${i.id}" data-priority="${esc(i.priority)}">
      <div class="task-card-header">
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="task-key">${esc(issueKey(i))}</span>
          ${typeBadge}
        </div>
        ${i.is_blocked ? `<span class="blocked-card-chip" title="Task is blocked by another task">🛑 Blocked</span>` : ""}
      </div>
      <div class="task-card-title">${esc(i.title)}</div>
      <div class="task-card-meta">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <span class="pill ${prioClass}" style="font-size:10px;padding:2px 7px;font-weight:700;">${esc(i.priority)}</span>
          ${showDue && i.due_date ? `<span class="due-chip ${overdue ? "overdue" : ""}">${esc(formatDate(i.due_date))}</span>` : ""}
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
      cardDidRealDrag = true;
      const issueId = e.dataTransfer.getData("text/plain");
      if (!issueId) return;

      const issue = issues.find(i => String(i.id) === String(issueId));
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

function openProjectModal(existingProject = null) {
  closeAllDropdowns();
  const isEdit = !!existingProject;
  if (!isEdit && !isAdmin()) {
    showToast("Only administrators have permission to create projects.", "error");
    return;
  }
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const endDefault = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const initName = isEdit ? (existingProject.name || "") : "";
  const initKey = isEdit ? (existingProject.key || "") : "";
  const initDesc = isEdit ? (existingProject.description || "") : "";
  const initStart = isEdit ? (existingProject.sprint_start_date || todayStr) : todayStr;
  const initEnd = isEdit ? (existingProject.sprint_end_date || endDefault) : endDefault;

  byId("modal-root").innerHTML = `
    <div class="modal">
      <div class="modal-card">
        <div class="modal-head">
          <h2>${isEdit ? "Edit Project" : "New Project"}</h2>
          <button type="button" class="close" onclick="closeModal()"><img src="image/close.svg" class="app-icon" alt="Close"></button>
        </div>
        <div id="projectErrorBox" class="form-error-banner hidden"></div>
        <form id="projectForm" novalidate>
          <label class="task-form-field">
            <span>Project name <span class="req-star">*</span></span>
            <input id="pname" value="${esc(initName)}" required autocomplete="off">
          </label>
          <label class="task-form-field">
            <span>Project key <span class="req-star">*</span></span>
            <input id="pkey" maxlength="10" value="${esc(initKey)}" ${isEdit ? 'disabled title="Project key cannot be changed"' : ''} required autocomplete="off" style="text-transform:uppercase;">
          </label>
          <div style="display:flex;gap:12px;">
            <label class="task-form-field" style="flex:1;">
              <span>Sprint start date <span class="req-star">*</span></span>
              <input type="date" id="pstart" value="${initStart}" required>
            </label>
            <label class="task-form-field" style="flex:1;">
              <span>Sprint end date <span class="req-star">*</span></span>
              <input type="date" id="pend" value="${initEnd}" min="${initStart}" required>
            </label>
          </div>
          <label class="task-form-field">
            <span>Description</span>
            <textarea id="pdesc">${esc(initDesc)}</textarea>
          </label>
          <div class="actions">
            <button type="button" class="secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="primary" id="createProjectSubmitBtn">${isEdit ? "Save Changes" : "Create"}</button>
          </div>
        </form>
      </div>
    </div>`;

  const pname = byId("pname");
  const pkey = byId("pkey");
  const pdesc = byId("pdesc");
  const pstart = byId("pstart");
  const pend = byId("pend");
  const errorBox = byId("projectErrorBox");
  const submitBtn = byId("createProjectSubmitBtn");

  const clearError = () => {
    errorBox.classList.add("hidden");
    errorBox.textContent = "";
    pname.classList.remove("field-invalid");
    pkey.classList.remove("field-invalid");
    if (pstart) pstart.classList.remove("field-invalid");
    if (pend) pend.classList.remove("field-invalid");
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

  if (!isEdit) {
    pkey.addEventListener("input", () => {
      pkey.value = pkey.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
      pkey.classList.remove("field-invalid");
      if (errorBox.textContent) clearError();
    });
  }

  pstart.addEventListener("change", () => {
    pstart.classList.remove("field-invalid");
    if (pstart.value) {
      pend.min = pstart.value;
      if (pend.value && pend.value < pstart.value) {
        pend.value = pstart.value;
      }
    }
    if (errorBox.textContent) clearError();
  });

  pend.addEventListener("change", () => {
    pend.classList.remove("field-invalid");
    if (errorBox.textContent) clearError();
  });

  byId("projectForm").onsubmit = async e => {
    e.preventDefault();
    clearError();

    const nameVal = pname.value.trim();
    const keyVal = pkey.value.trim().toUpperCase();
    const descVal = pdesc.value.trim();
    const startVal = pstart.value.trim();
    const endVal = pend.value.trim();

    if (!nameVal) {
      showError("Project name is required.", "pname");
      return;
    }
    if (nameVal.length < 2) {
      showError("Project name must be at least 2 characters.", "pname");
      return;
    }

    if (!isEdit) {
      if (!keyVal) {
        showError("Project key is required.", "pkey");
        return;
      }
      if (keyVal.length < 2) {
        showError("Project key must be at least 2 characters.", "pkey");
        return;
      }
    }

    if (!startVal) {
      showError("Sprint start date is required.", "pstart");
      return;
    }
    if (!endVal) {
      showError("Sprint end date is required.", "pend");
      return;
    }
    if (endVal < startVal) {
      showError("Sprint end date cannot be earlier than sprint start date.", "pend");
      return;
    }

    // Client-side uniqueness check for Project Name (case-insensitive)
    const duplicateName = projects.find(p => p.name.trim().toLowerCase() === nameVal.toLowerCase() && (!isEdit || p.id !== existingProject.id));
    if (duplicateName) {
      showError(`A project named '${nameVal}' already exists. All project names must be unique.`, "pname");
      return;
    }

    if (!isEdit) {
      // Client-side uniqueness check for Project Key (case-insensitive)
      const duplicateKey = projects.find(p => p.key.trim().toUpperCase() === keyVal);
      if (duplicateKey) {
        showError(`Project key '${keyVal}' already exists. All project keys must be unique.`, "pkey");
        return;
      }
    }

    submitBtn.disabled = true;
    submitBtn.textContent = isEdit ? "Saving..." : "Creating...";

    if (isEdit) {
      try {
        const updated = await api(`/projects/${existingProject.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: nameVal,
            description: descVal,
            sprint_start_date: startVal,
            sprint_end_date: endVal
          })
        });
        const idx = projects.findIndex(p => p.id === existingProject.id);
        if (idx !== -1) {
          projects[idx] = { ...projects[idx], ...updated };
        }
        closeModal();
        renderSidebarProjects();
        if (activeProjectId === existingProject.id) {
          renderProjectShell();
        } else if (view === "projects") {
          renderAllProjects();
        }
        showToast("Project sprint settings updated successfully", "success");
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save Changes";
        showError(err.message || "Failed to update project", "pname");
      }
    } else {
      try {
        const project = await api("/projects", {
          method: "POST",
          body: JSON.stringify({
            name: nameVal,
            key: keyVal,
            description: descVal,
            sprint_start_date: startVal,
            sprint_end_date: endVal
          })
        });
        projects.push(project);
        closeModal();
        renderSidebarProjects();
        openProject(project.id);
        showToast("Project created successfully", "success");
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
    }
  };
}

async function openIssueById(issueId) {
  if (!issueId) return;
  const now = Date.now();
  if (now - lastOpenedModalTime < 350) return;
  lastOpenedModalTime = now;

  let issue = issues.find(x => String(x.id) === String(issueId));
  if (!issue) {
    try {
      issue = await api(`/issues/${issueId}`);
    } catch (err) {
      console.warn("Could not fetch issue by ID:", err);
    }
  }

  if (issue) {
    await openIssueModal(issue);
  } else {
    showToast("Task details not found.", "info");
  }
}
window.openIssueById = openIssueById;

async function openIssueModal(existing) {
  closeAllDropdowns();
  const isEdit = !!existing;
  if (!isEdit && !isAdmin()) {
    showToast("Only administrators have permission to create tasks.", "error");
    return;
  }
  if (!existing && !activeProjectId && !projects.length) {
    showToast("Create a project first.", "info");
    return;
  }

  // Instant response: do not block modal rendering if users already loaded
  if (!users || !users.length) {
    try { await refreshUsers(); } catch (e) { console.warn("Failed to fetch users", e); }
  } else {
    refreshUsers().catch(e => console.warn(e));
  }

  try {
    const projectId = existing ? existing.project_id : activeProjectId;
    const todayStr = getTodayString();
    const projStatuses = getProjectStatuses(projectId);

    const estDays = (existing && existing.estimation != null) ? existing.estimation : 1;
    const estHours = Math.round(estDays * 8);
    const loggedHours = (existing && existing.logged_hours != null) ? Math.round(existing.logged_hours * 10) / 10 : 0;
    const remHours = Math.max(0, Math.round((estHours - loggedHours) * 10) / 10);
    const timePercent = estHours > 0 ? Math.min(100, Math.round((loggedHours / estHours) * 100)) : 0;
    const isOverBudget = loggedHours > estHours;

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
            <input id="ititle" value="${isEdit ? esc(existing.title) : ""}">
          </label>
          <label class="task-form-field ${isEdit ? "task-field-desc" : "task-field-desc-new"}">
            <span>Description <span class="req-star">*</span></span>
            <textarea id="idesc">${isEdit ? esc(existing.description || "") : ""}</textarea>
          </label>
          ${isEdit ? `
            <div class="task-comments-wrapper">
              <div class="task-comments-title">Comments</div>
              <div class="comment-add-row">
                <input id="commentInput" autocomplete="off">
                <input type="file" id="commentFileInput" style="display:none">
                <button type="button" class="comment-improve-btn" id="commentImproveBtn" title="Improve sentence"><img src="image/wand.svg" class="app-icon" alt="Improve"></button>
                <button type="button" class="comment-attach-btn" id="commentAttachBtn" title="Attach file"><img src="image/paperclip.svg" class="app-icon" alt="Attach"></button>
                <button type="button" class="secondary" id="commentBtn">Post</button>
              </div>
              <div id="commentAttachmentPreview" class="comment-attachment-preview hidden"></div>
              <div id="commentList" class="comment-list-scroll"></div>
            </div>` : ""}
        </div>
        <div class="task-modal-col-side">
          <div class="task-side-card">
            <div class="task-side-title">Task Details</div>
            <label class="task-form-field">
              <span>Issue Type <span class="req-star">*</span></span>
              <select id="itype">
                <option value="Feature" ${(!isEdit || (existing.issue_type || "Feature").toLowerCase() === "feature") ? "selected" : ""}>Feature</option>
                <option value="Bug" ${(isEdit && (existing.issue_type || "").toLowerCase() === "bug") ? "selected" : ""}>Bug</option>
              </select>
            </label>
            <label class="task-form-field">
              <span>Status <span class="req-star">*</span></span>
              <select id="istatus">
                ${projStatuses.map(s => `<option ${isEdit && existing.status === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
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
              <span>Start Date</span>
              <input type="date" id="istart" value="${isEdit && existing.start_date ? String(existing.start_date).slice(0, 10) : ""}">
            </label>
            <label class="task-form-field">
              <span>Due Date <span class="req-star">*</span></span>
              <input type="date" id="idue" ${isEdit ? "" : `min="${todayStr}"`} value="${isEdit && existing.due_date ? String(existing.due_date).slice(0, 10) : ""}">
            </label>
            <label class="task-form-field">
              <span>Estimation (Days) <span class="req-star">*</span></span>
              <input type="number" id="iestimation" step="1" min="1" value="${isEdit && existing.estimation != null ? Math.round(existing.estimation) : ""}">
            </label>
            <label class="task-form-field">
              <span>Assignee</span>
              <select id="iassignee">
                <option value="">Unassigned</option>
                ${users.map(u => `<option value="${u.id}" ${isEdit && existing.assignee_id === u.id ? "selected" : ""}>${esc(u.name)} (${esc(u.role || "member")})</option>`).join("")}
              </select>
            </label>
          </div>

          ${isEdit ? `
            <!-- Time Tracking Card -->
            <div class="task-side-card time-tracking-box">
              <div class="time-tracking-head">
                <h4><img src="image/timer.svg" class="app-icon" style="width:14px;height:14px;" alt=""> Time Tracking</h4>
                <button type="button" class="secondary" id="toggleLogWorkBtn" style="font-size:11px;padding:3px 8px;">+ Log Time</button>
              </div>
              <div class="time-progress-bar">
                <div id="modalTimeFill" class="time-progress-fill ${isOverBudget ? "over-budget" : ""}" style="width:${timePercent}%;"></div>
              </div>
              <div class="time-metrics-row">
                <span><strong id="modalLoggedHours">${loggedHours}h</strong> logged</span>
                <span class="muted"><span id="modalRemainingHours">${remHours}h</span> rem</span>
                <span><strong>${estHours}h</strong> est</span>
              </div>

              <div id="logTimeForm" class="log-time-form hidden">
                <div style="font-size:11.5px;font-weight:700;color:var(--text-primary);margin-bottom:4px;">Log Work</div>
                <div style="display:flex;gap:6px;flex-direction:column;">
                  <div style="display:flex;gap:6px;">
                    <input type="number" id="logHoursInput" step="0.25" min="0.1" style="width:90px;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border-default);background:var(--bg-surface);">
                    <input type="date" id="logDateInput" value="${todayStr}" style="flex:1;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border-default);background:var(--bg-surface);">
                  </div>
                  <button type="button" class="primary" id="saveLogWorkBtn" style="font-size:11.5px;padding:5px 10px;margin-top:2px;">Save Worklog</button>
                </div>
              </div>

              <div id="worklogList" class="worklog-list"></div>
            </div>

            <!-- Dependencies Card -->
            <div class="task-side-card task-dep-box">
              <div class="task-dep-head">
                <h4><img src="image/link.svg" class="app-icon" style="width:14px;height:14px;" alt=""> Dependencies</h4>
              </div>
              
              <div id="depListContainer"></div>

              <div class="dep-add-row">
                <input type="hidden" id="newDepType" value="blocked_by">
                <span style="font-size:11.5px;font-weight:600;color:var(--text-secondary);white-space:nowrap;padding:5px 4px;display:inline-flex;align-items:center;">Blocked by</span>
                <select id="newDepTarget" style="font-size:11px;padding:5px 8px;flex:1;min-width:110px;">
                  <option value="">Select task…</option>
                  ${issues.filter(x => String(x.id) !== String(existing.id)).length > 0
          ? issues.filter(x => String(x.id) !== String(existing.id)).map(x => `<option value="${x.id}">${esc(issueKey(x))} — ${esc(x.title)}</option>`).join("")
          : `<option value="" disabled>(No other tasks in this project)</option>`}
                </select>
                <button type="button" class="secondary" id="addDepBtn" style="font-size:11px;padding:5px 10px;flex-shrink:0;">Link</button>
              </div>
            </div>
          ` : ""}
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

    ["ititle", "idesc", "itype", "istatus", "ipriority", "idue", "iestimation"].forEach(id => {
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

      const typeVal = byId("itype") ? byId("itype").value : "Feature";

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
      if (!isEdit && dueVal < todayStr) {
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
        issue_type: typeVal,
        status: statusVal,
        priority: priorityVal,
        start_date: byId("istart") ? (byId("istart").value || null) : null,
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
        if (view === "foryou") {
          renderForYou();
        } else if (activeProjectId) {
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

      // Time Tracking & Worklog logic
      const loadWorklogs = async () => {
        const listEl = byId("worklogList");
        if (!listEl) return;
        try {
          const logs = await api(`/issues/${existing.id}/worklog`);
          if (!logs.length) {
            listEl.innerHTML = `<div class="muted" style="font-size:11px;padding:4px 0;">No work logged yet.</div>`;
            return;
          }
          listEl.innerHTML = logs.map(l => `
          <div class="worklog-entry">
            <div class="worklog-entry-left">
              <span class="worklog-entry-hours">${l.hours}h</span>
              <div>
                <div style="font-weight:600;">${esc(l.user_name)}</div>
                <div class="muted" style="font-size:10px;">${esc(l.date)} ${l.comment ? `• ${esc(l.comment)}` : ""}</div>
              </div>
            </div>
            ${(l.user_id === String(currentUser.id || currentUser._id) || isAdmin()) ? `
              <button type="button" class="worklog-delete-btn" onclick="deleteWorklogEntry('${l.id}')" title="Delete worklog">
                <img src="image/close.svg" class="app-icon" style="width:11px;height:11px;" alt="">
              </button>
            ` : ""}
          </div>
        `).join("");
        } catch { }
      };

      window.deleteWorklogEntry = async (worklogId) => {
        try {
          await api(`/issues/${existing.id}/worklog/${worklogId}`, { method: "DELETE" });
          const updated = await api(`/issues/${existing.id}`);
          Object.assign(existing, updated);
          const idx = issues.findIndex(i => i.id === existing.id);
          if (idx !== -1) issues[idx] = existing;
          updateTimeTrackerUI();
          await loadWorklogs();
          showToast("Worklog entry deleted", "info");
          refreshCurrentTab();
        } catch (err) {
          showToast(err.message || "Failed to delete worklog", "error");
        }
      };

      const updateTimeTrackerUI = () => {
        const est = (existing.estimation || 1) * 8;
        const log = existing.logged_hours || 0;
        const rem = Math.max(0, Math.round((est - log) * 10) / 10);
        const pct = est > 0 ? Math.min(100, Math.round((log / est) * 100)) : 0;
        const fillEl = byId("modalTimeFill");
        if (fillEl) {
          fillEl.style.width = `${pct}%`;
          fillEl.classList.toggle("over-budget", log > est);
        }
        if (byId("modalLoggedHours")) byId("modalLoggedHours").textContent = `${log}h`;
        if (byId("modalRemainingHours")) byId("modalRemainingHours").textContent = `${rem}h`;
      };

      const logToggleBtn = byId("toggleLogWorkBtn");
      const logForm = byId("logTimeForm");
      if (logToggleBtn && logForm) {
        logToggleBtn.onclick = () => {
          logForm.classList.toggle("hidden");
          if (!logForm.classList.contains("hidden")) {
            byId("logHoursInput").focus();
          }
        };
      }

      const saveLogBtn = byId("saveLogWorkBtn");
      if (saveLogBtn) {
        saveLogBtn.onclick = async () => {
          const hoursVal = parseFloat(byId("logHoursInput").value);
          if (isNaN(hoursVal) || hoursVal <= 0) {
            showToast("Please enter a valid number of hours.", "error");
            return;
          }
          const dateVal = byId("logDateInput").value || todayStr;

          saveLogBtn.disabled = true;
          try {
            await api(`/issues/${existing.id}/worklog`, {
              method: "POST",
              body: JSON.stringify({ hours: hoursVal, date: dateVal, comment: "" })
            });
            const updated = await api(`/issues/${existing.id}`);
            Object.assign(existing, updated);
            const idx = issues.findIndex(i => i.id === existing.id);
            if (idx !== -1) issues[idx] = existing;

            byId("logHoursInput").value = "";
            logForm.classList.add("hidden");
            updateTimeTrackerUI();
            await loadWorklogs();
            showToast("Work logged successfully!", "success");
            refreshCurrentTab();
          } catch (err) {
            showToast(err.message || "Failed to log work", "error");
          } finally {
            saveLogBtn.disabled = false;
          }
        };
      }

      loadWorklogs();

      // Dependencies logic
      const renderDependencies = () => {
        const depContainer = byId("depListContainer");
        if (!depContainer) return;
        const blockedByList = existing.blocked_by || [];

        if (!blockedByList.length) {
          depContainer.innerHTML = `<div class="muted" style="font-size:11px;padding:4px 0;">No dependencies linked.</div>`;
          return;
        }

        let html = "";
        blockedByList.forEach(bid => {
          const target = issues.find(x => String(x.id) === String(bid));
          const isDone = target && (target.status || "").toLowerCase() === "done";
          html += `
          <div class="dep-item ${isDone ? "dep-item-resolved" : "dep-item-blocked"}">
            <div class="dep-item-content">
              <span class="dep-item-badge ${isDone ? "badge-resolved" : "badge-blocked"}" title="${isDone ? "Dependency resolved" : "Blocking this task"}">
                ${isDone ? "✓ Done" : "🛑 Blocked by"}
              </span>
              <span class="dep-item-key" onclick="openIssueById('${bid}')" title="View task ${target ? esc(issueKey(target)) : bid}">${target ? esc(issueKey(target)) : bid}</span>
              <span class="dep-item-title" title="${target ? esc(target.title) : ""}">${target ? esc(target.title) : ""}</span>
            </div>
            <button type="button" class="dep-cancel-btn" onclick="removeDependencyLink('${bid}')" title="Cancel dependency link">✕</button>
          </div>`;
        });

        depContainer.innerHTML = html;
      };

      window.removeDependencyLink = async (targetId) => {
        try {
          const res = await api(`/issues/${existing.id}/dependencies/${targetId}`, { method: "DELETE" });
          Object.assign(existing, res.issue);
          const idx = issues.findIndex(i => i.id === existing.id);
          if (idx !== -1) issues[idx] = existing;
          renderDependencies();

          // If no longer blocked, automatically go to In Progress status!
          if (!existing.is_blocked) {
            existing.status = "In Progress";
            const stSelect = byId("istatus");
            if (stSelect) {
              const statuses = getProjectStatuses(activeProjectId);
              stSelect.innerHTML = statuses.map(s => `<option value="${esc(s.name)}" ${existing.status === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("");
              stSelect.value = "In Progress";
            }
          }
          showToast("Dependency unlinked. Task moved to In Progress.", "success");
          refreshCurrentTab();
        } catch (err) {
          showToast(err.message || "Failed to remove dependency", "error");
        }
      };

      const addDepBtn = byId("addDepBtn");
      if (addDepBtn) {
        addDepBtn.onclick = async () => {
          const targetId = byId("newDepTarget").value;
          const depType = byId("newDepType").value;
          if (!targetId) {
            showToast("Please select a target task.", "error");
            return;
          }
          addDepBtn.disabled = true;
          try {
            const res = await api(`/issues/${existing.id}/dependencies`, {
              method: "POST",
              body: JSON.stringify({ target_issue_id: targetId, type: depType })
            });
            Object.assign(existing, res.issue);
            const idx = issues.findIndex(i => String(i.id) === String(existing.id));
            if (idx !== -1) issues[idx] = existing;
            byId("newDepTarget").value = "";
            renderDependencies();

            // Whenever blocked is linked -> move to Hold status!
            if (existing.is_blocked) {
              existing.status = "Hold";
              const stSelect = byId("istatus");
              if (stSelect) {
                const statuses = getProjectStatuses(activeProjectId);
                stSelect.innerHTML = statuses.map(s => `<option value="${esc(s.name)}" ${existing.status === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("");
                stSelect.value = "Hold";
              }
            }
            showToast("Task is blocked — moved to Hold status.", "info");
            refreshCurrentTab();
          } catch (err) {
            showToast(err.message || "Failed to link dependency", "error");
          } finally {
            addDepBtn.disabled = false;
          }
        };
      }

      renderDependencies();

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

      const improveBtn = byId("commentImproveBtn");
      if (improveBtn) {
        improveBtn.onclick = () => {
          const input = byId("commentInput");
          const val = input.value;
          if (!val || !val.trim()) {
            showToast("Type a sentence first to improve it", "info");
            input.focus();
            return;
          }
          const improved = improveSentence(val);
          if (improved === val) {
            showToast("Sentence looks great already!", "info");
          } else {
            input.value = improved;
            input.classList.remove("comment-improved-flash");
            void input.offsetWidth;
            input.classList.add("comment-improved-flash");
            showToast("Sentence improved!", "success");
          }
          input.focus();
        };
      }
      const commentInput = byId("commentInput");
      if (commentInput) setupMentionAutocomplete(commentInput);
      const descInput = byId("idesc");
      if (descInput) setupMentionAutocomplete(descInput);
    }
  } catch (err) {
    console.error("Error opening task modal:", err);
    showToast("Could not open task details: " + (err.message || err), "error");
  }
}

// --- Automatic Spell Correction & Sentence Improvement Engine ---
const SPELL_VOCABULARY = (
  "the of and a to in is you that it he was for on are as with his they i at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part " +
  "over new sound take only little work know place year live me back give most very after thing our just name good sentence sentences man think say great where much through before line right too mean old any same tell boy follow came want show also around form three small set put end does another well large must big even such because turn here why ask went men read need land different home us move try kind hand picture again change off play spell air away animal house point page letter mother answer found study still learn should world high every near add food between own below country plant last school father keep tree never start city earth eye light thought head under story saw left few while along might close something seem next hard open example begin life always those both paper together got group often run important until children side feet car mile night walk white sea began grow took river four carry state once book hear stop without second late miss idea enough eat face watch far real almost let above sometimes mountain cut young talk soon list song being leave family " +
  "able about above absolute accept accepted accepting accepts acceptance account accounts across action actions actual actually adjust adjusted adjusting adjustment agree agreed agreeing ahead allow allowed allowing allows almost already alright always among amount another answer answered answering answers anyway appear appeared appearing appearance apply applied applying approve approved approving approval area argue around arrange arranged arrangement article aspect attach attached attaching attachment attachments attempt attempted attend attitude author aware basic basis battle beautiful become became becoming begin began beginning begins believe believed believing belongs beside beyond block blocked blocking blocks board boards branch branches brief bring brought bringing build built building builds cause caused causing causes central certain certainly chain chair change changed changing changes charge charged check checked checking checks choose chose chosen claim clear cleared clearly close closed closing closes collect collected common compare compared comparison concern confirm confirmed confirming confirmation consider contain contains continue continued control controlled controls correct corrected correcting corrects correction corrections could course cover covered create created creating creates creation credit cross current currently danger decide decided declare default define defined definition degree deliver delivered depend depended dependent dependency dependencies derive design designed detail detailed details detect detected determine develop developed developer development device differ direct direction discuss discussed discussing discussion display displayed divide double doubt draft draw drive drop dropped early easy easily effect either elect element enable enabled enjoy ensure enter entered entire equal equip escape event events every exact exactly except expect expected explain explained extend factor failure failures faith false famous fast faster fastest fear field fight figure final finally find found first fixed focus force forget forgot forgotten form found free fresh front full fully function functions functional functionality future general generally gentle gift glad global grade grant great greatly green ground group groups grow grew growing guess guide handle handled handling happen happened happening happy hard hardly heart heavy help helped helping helps helper helpful hide hid hidden high higher highest hold held hope huge human ideal ignore ignored image imagine impact imply impose improve improved improving improves improvement improvements include included including includes index inform inject inside insist intend introduce invest issue issues issued join joined judge keep kept kill know knew known knowledge lack large larger largest late later latest laugh lead led leading learn learned leave left level light limit limited list listed listing live load loaded loading local lock locked logic logical login logout long look looked looking looks loose lose lost loss love main maintain maintained maintenance major make made making makes manage managed managing management manager managers market mass master match matched matches material matter mean meant measure meet met member members memory mention mentioned message messages messaging method methods middle might mind minute minutes modern moment move moved moving movement name named names nation natural near nearly neat need needed needs never new next nice night normal normally note noted notes notice noticed number numbers object objects obtain occur occurred occurring occurs offer offered old once open opened opening opens operate operated operation operations operator operators opinion opinions option options order ordered orders ordinal organization organized original orphan other others ought outcome output outside over own page pages part parts path peace peak period person persons personal phrase pick picked place placed plan planned planning plans plant point pointed points policy poor popular position positive possible post posted posting posts potential power prepare prepared present press price primary print prior private privilege problem problems proceed process processed processes processing produce produced product production profession professional program programs progress project projects prompt proper properly protect protected protection provide provided public publish published pull pulled pulling push pushed pushing quality quick quickly quiet quite raise raised range rate reach reached reaching reaction read reading ready real really reason recall receive received receiving receives receiver recognize recognized record recorded recording reduce reduced region regular reject rejected relation relationship release released releasing releases reliability reliable remain remained remember remind reminder remote remove removed removing removes repeat replace replaced report reported reporting reports request requested requesting requests require required requiring requirements resolve resolved resolving resolution respect respond responded responding response responses responsive rest restart restore result resulted results resume retain return returned reveal review reviewed reviewing reviews revise revised revision rich right role room round routine routing row rule runner running runtime safe safety save saved saving scalar scale scan scenario scene schedule scheduled scheduling schema scope score screen search searched searching season second section security see seek seem select selected send sent sending sense serve server servers service services session session settle severe shade shape share shared sharing shift shock shoot short should show showed shown showing side sight sign signature simple simply simulation since single site skill sleep slow small smart smooth social software solution solutions solve solved solving some sometimes sort sorted sorting sound source space speak special speed spend spent stage standard standards start started starting state stated static status stay stayed step steps still stop stopped stopping storage store strategy street stress strict strong structure style submit submitted submitting submits subscription success successful successfully sudden suggest suggested suggestion suggestions suit suitable support supported supporting sure switch system systems table tables take took taken target task tasks teach team teams temporary term terms test tested testing tests text thank thanked thanks theme then theory there therefore thing things think thought threat three through time timeline timeout tiny title titles today together tomorrow tonight top total touch tough trace track transaction transfer transient transform transition translate transmit travel treat trend trouble true truly trust try tried trying turn turned type types typed typing unable under understand understood unit unless until update updated updating updates upgrade upload uploaded upon upper urge usage user users usual valid validate validation validator value values variable variables various version versions view viewed viewing views visit voice wait waited waiting walk want wanted warn warning watch watched water weapon week weeks weight welcome well whatever whenever whereas whether which while white whole wide will window wipe wish with within without word words work worked working works worker workflow workload workspace world worry worse worth would write wrote written writing wrong yard year years young"
);

const SPELL_SET = new Set(
  SPELL_VOCABULARY.toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
);

// Group words by their first letter for instant sub-millisecond Levenshtein-2 lookups
const DICT_BY_LETTER = {};
for (const w of SPELL_SET) {
  const ch = w[0];
  if (!DICT_BY_LETTER[ch]) DICT_BY_LETTER[ch] = [];
  DICT_BY_LETTER[ch].push(w);
}

// Fast Damerau-Levenshtein distance (supports swaps, deletions, insertions, substitutions)
function getDamerauLevenshtein(a, b) {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > 2) return 99;
  const d = [];
  for (let i = 0; i <= al; i++) d[i] = [i];
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}

const EXPLICIT_TYPOS = {
  // Slang & informal abbreviations
  "pls": "please",
  "plz": "please",
  "thx": "thank you",
  "ty": "thank you",
  "u": "you",
  "ur": "your",
  "r": "are",
  "b/c": "because",
  "bc": "because",
  "w/": "with",
  "w/o": "without",
  "gonna": "going to",
  "wanna": "want to",
  "gotta": "got to",
  "asap": "ASAP",
  "fyi": "FYI",
  "btw": "by the way",
  "imo": "in my opinion",
  "imho": "in my opinion",
  "idk": "I don't know",
  "tbh": "to be honest",
  "np": "no problem",
  "omw": "on my way",
  "eta": "ETA",
  "alot": "a lot",
  "noone": "no one",
  "prolly": "probably",
  "cuz": "because",

  // Missing apostrophes & contractions
  "dont": "don't",
  "doesnt": "doesn't",
  "didnt": "didn't",
  "cant": "can't",
  "wont": "won't",
  "wouldnt": "wouldn't",
  "couldnt": "couldn't",
  "shouldnt": "shouldn't",
  "isnt": "isn't",
  "arent": "aren't",
  "wasnt": "wasn't",
  "werent": "weren't",
  "hasnt": "hasn't",
  "havent": "haven't",
  "hadnt": "hadn't",
  "youre": "you're",
  "theyre": "they're",
  "weve": "we've",
  "theyve": "they've",
  "youve": "you've",
  "im": "I'm",
  "ill": "I'll",
  "ive": "I've",
  "id": "I'd",
  "lets": "let's",
  "thats": "that's",
  "whats": "what's",
  "heres": "here's",
  "theres": "there's",
  "itll": "it'll",
  "whos": "who's",

  // Common misspellings (explicit overrides for guaranteed accuracy)
  "teh": "the",
  "recieve": "receive",
  "recieved": "received",
  "recieving": "receiving",
  "seperate": "separate",
  "seperated": "separated",
  "seperating": "separating",
  "definately": "definitely",
  "definitly": "definitely",
  "untill": "until",
  "wierd": "weird",
  "occured": "occurred",
  "occuring": "occurring",
  "neccessary": "necessary",
  "necesary": "necessary",
  "acheive": "achieve",
  "acheived": "achieved",
  "accomodate": "accommodate",
  "calender": "calendar",
  "tommorrow": "tomorrow",
  "tomorow": "tomorrow",
  "goverment": "government",
  "enviornment": "environment",
  "sucess": "success",
  "sucessful": "successful",
  "truely": "truly",
  "beleive": "believe",
  "beleived": "believed",
  "recomended": "recommended",
  "reccomend": "recommend",
  "reccomended": "recommended",
  "maintainance": "maintenance",
  "privilege": "privilege",
  "privelege": "privilege",
  "begining": "beginning",
  "adress": "address",
  "writting": "writing",
  "documantation": "documentation",
  "runing": "running",
  "conection": "connection",
  "authntication": "authentication",
  "atachment": "attachment",
  "asignee": "assignee",
  "requirment": "requirement",
  "requierd": "required",
  "prioriy": "priority",
  "staus": "status",
  "submited": "submitted",
  "upldated": "updated",
  "mesage": "message",
  "relese": "release",
  "feautre": "feature",
  "compelted": "completed",
  "finsihed": "finished",
  "functon": "function",
  "problm": "problem",
  "libary": "library",
  "responce": "response",
  "correvtion": "correction",
  "corection": "correction"
};

function correctWordSpelling(word) {
  if (!word || word.length < 2) return word;

  // Preserve acronyms, URLs, snake_case, or numbers
  if (!/^[a-zA-Z']+$/.test(word)) return word;

  const lower = word.toLowerCase();

  // 1. Check explicit typo / slang dictionary
  if (EXPLICIT_TYPOS[lower]) {
    const repl = EXPLICIT_TYPOS[lower];
    if (word === word.toUpperCase() && word.length > 1) return repl.toUpperCase();
    if (word[0] === word[0].toUpperCase()) return repl.charAt(0).toUpperCase() + repl.slice(1);
    return repl;
  }

  // 2. If already valid in dictionary, keep
  if (SPELL_SET.has(lower)) {
    return lower === "i" ? "I" : word;
  }

  // 3. Edit-distance-1 Candidate Generation (Norvig Levenshtein)
  const n = lower.length;
  if (n < 4) {
    return lower === "i" ? "I" : word;
  }

  const candidates = [];

  // Transpositions (e.g., "teh" -> "the", "feautre" -> "feature", "compelted" -> "completed")
  for (let i = 0; i < n - 1; i++) {
    const trans = lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2);
    if (SPELL_SET.has(trans)) candidates.push({ word: trans, prio: 1 });
  }

  // Deletions (e.g., "writting" -> "writing")
  for (let i = 0; i < n; i++) {
    const del = lower.slice(0, i) + lower.slice(i + 1);
    if (SPELL_SET.has(del)) candidates.push({ word: del, prio: 2 });
  }

  // Insertions (e.g., "runing" -> "running", "mesage" -> "message", "problm" -> "problem")
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j < 26; j++) {
      const ins = lower.slice(0, i) + alphabet[j] + lower.slice(i);
      if (SPELL_SET.has(ins)) candidates.push({ word: ins, prio: 3 });
    }
  }

  // Substitutions (e.g., "correvtion" -> "correction", "documantation" -> "documentation")
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 26; j++) {
      if (alphabet[j] === lower[i]) continue;
      const sub = lower.slice(0, i) + alphabet[j] + lower.slice(i + 1);
      if (SPELL_SET.has(sub)) candidates.push({ word: sub, prio: 4 });
    }
  }

  if (candidates.length > 0) {
    // Pick candidate with highest priority (transposition > deletion > insertion > substitution)
    candidates.sort((a, b) => a.prio - b.prio);
    const chosen = candidates[0].word;
    if (word === word.toUpperCase() && word.length > 1) return chosen.toUpperCase();
    if (word[0] === word[0].toUpperCase()) return chosen.charAt(0).toUpperCase() + chosen.slice(1);
    return chosen;
  }

  // 4. Edit-distance-2 Fallback via Damerau-Levenshtein on letter-indexed bucket
  const firstChar = lower[0];
  const bucket = DICT_BY_LETTER[firstChar] || [];
  let bestWord = null;
  let bestDist = 3;

  for (let i = 0; i < bucket.length; i++) {
    const candidate = bucket[i];
    if (Math.abs(candidate.length - n) <= 2) {
      const dist = getDamerauLevenshtein(lower, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
        if (dist === 1) break;
      }
    }
  }

  if (bestWord && bestDist <= 2) {
    if (word === word.toUpperCase() && word.length > 1) return bestWord.toUpperCase();
    if (word[0] === word[0].toUpperCase()) return bestWord.charAt(0).toUpperCase() + bestWord.slice(1);
    return bestWord;
  }

  return word;
}

function improveSentence(text) {
  if (!text || typeof text !== "string") return text;
  let s = text.trim();
  if (!s) return s;

  // 1. Collapse multiple spaces
  s = s.replace(/[ \t]+/g, " ");

  // 2. Clean punctuation spacing
  s = s.replace(/\s+([,.:;!?])/g, "$1");
  s = s.replace(/([,.:;!?])([A-Za-z0-9])/g, "$1 $2");

  // 3. Normalize repeated punctuation
  s = s.replace(/\.{4,}/g, "...");
  s = s.replace(/(?<!\.)\.{2}(?!\.)/g, ".");
  s = s.replace(/!{2,}/g, "!");
  s = s.replace(/\?{2,}/g, "?");
  s = s.replace(/,{2,}/g, ",");

  // 4. Automatic Spell Correction & Word Transformation
  s = s.replace(/\b[a-zA-Z']+\b/g, match => {
    return correctWordSpelling(match);
  });

  // 5. Sentence capitalization
  s = s.charAt(0).toUpperCase() + s.slice(1);
  s = s.replace(/([.!?]\s+)([a-z])/g, (_, p1, p2) => p1 + p2.toUpperCase());
  s = s.replace(/(\n\s*)([a-z])/g, (_, p1, p2) => p1 + p2.toUpperCase());

  // 6. Ensure terminal punctuation if multiple words
  if (s.includes(" ") && !/[.!?:\-]$/.test(s)) {
    s += ".";
  }

  return s;
}

function formatCommentBody(text) {
  if (!text) return "";
  let safe = esc(text);
  const pool = Array.isArray(users) ? users : [];

  const targetMap = new Map();
  pool.forEach(u => {
    if (u.name && u.name.trim()) {
      targetMap.set(u.name.trim().toLowerCase(), u.name.trim());
    }
    if (u.email) {
      const handle = u.email.split("@")[0].trim();
      if (handle && !targetMap.has(handle.toLowerCase())) {
        targetMap.set(handle.toLowerCase(), u.name ? u.name.trim() : handle);
      }
    }
  });

  const keys = Array.from(targetMap.keys()).sort((a, b) => b.length - a.length);
  const MENTION_STYLE = "border:none!important;outline:none!important;box-shadow:none!important;text-shadow:none!important;-webkit-text-stroke:0!important;";

  if (keys.length > 0) {
    const pattern = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const reg = new RegExp(`@(${pattern})\\b`, "gi");
    safe = safe.replace(reg, (match, p1) => {
      const display = targetMap.get(p1.toLowerCase()) || p1;
      return `<span class="mention-tag" style="${MENTION_STYLE}">@${esc(display)}</span>`;
    });
  } else {
    safe = safe.replace(/@([a-zA-Z0-9_.-]+)\b/g, (match, p1) => {
      return `<span class="mention-tag" style="${MENTION_STYLE}">@${esc(p1)}</span>`;
    });
  }
  return safe;
}

function setupMentionAutocomplete(inputEl) {
  if (!inputEl || inputEl._hasMentionAutocomplete) return;
  inputEl._hasMentionAutocomplete = true;

  let dropdown = null;
  let activeIndex = 0;
  let currentMatches = [];

  function closeDropdown() {
    if (dropdown) {
      dropdown.remove();
      dropdown = null;
    }
    activeIndex = 0;
    currentMatches = [];
  }

  function getQueryAtCursor() {
    const val = inputEl.value;
    const cursorPos = inputEl.selectionStart;
    if (cursorPos == null) return null;
    const textBefore = val.slice(0, cursorPos);
    const lastAt = textBefore.lastIndexOf("@");
    if (lastAt === -1) return null;
    if (lastAt > 0 && !/\s/.test(textBefore[lastAt - 1])) return null;
    const query = textBefore.slice(lastAt + 1);
    if (/\n/.test(query)) return null;
    return {
      query,
      atIndex: lastAt
    };
  }

  function renderDropdown(matches, atInfo) {
    if (!dropdown) {
      dropdown = document.createElement("div");
      dropdown.className = "mention-autocomplete-dropdown";
      const parent = inputEl.parentElement;
      if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }
      parent.appendChild(dropdown);
    }

    currentMatches = matches;
    if (!matches.length) {
      dropdown.innerHTML = `<div style="padding:8px 10px;font-size:11.5px;color:var(--text-muted);">No team members found</div>`;
      return;
    }

    if (activeIndex >= matches.length) activeIndex = 0;

    dropdown.innerHTML = matches.map((u, idx) => {
      const uName = u.name || u.email || "Member";
      const uRole = u.role || "member";
      return `
        <div class="mention-item ${idx === activeIndex ? "active" : ""}" data-idx="${idx}">
          <span class="mention-item-avatar">${esc(initials(uName))}</span>
          <div class="mention-item-info">
            <span class="mention-item-name">${esc(uName)}</span>
            ${u.email ? `<span class="mention-item-sub">${esc(u.email)}</span>` : ""}
          </div>
          <span class="mention-item-role">${esc(uRole)}</span>
        </div>`;
    }).join("");

    dropdown.querySelectorAll(".mention-item").forEach(item => {
      item.onmousedown = (e) => {
        e.preventDefault();
        const idx = Number(item.dataset.idx);
        selectUser(matches[idx], atInfo);
      };
      item.onmouseenter = () => {
        dropdown.querySelectorAll(".mention-item").forEach(el => el.classList.remove("active"));
        item.classList.add("active");
        activeIndex = Number(item.dataset.idx);
      };
    });
  }

  function selectUser(user, atInfo) {
    if (!user) return;
    const val = inputEl.value;
    const cursorPos = inputEl.selectionStart;
    const textBeforeAt = val.slice(0, atInfo.atIndex);
    const textAfterCursor = val.slice(cursorPos);
    const insertName = `@${user.name || user.email} `;
    inputEl.value = textBeforeAt + insertName + textAfterCursor;
    const newPos = atInfo.atIndex + insertName.length;
    inputEl.setSelectionRange(newPos, newPos);
    inputEl.focus();
    closeDropdown();
  }

  inputEl.addEventListener("focus", () => {
    if (!users || !users.length) {
      api("/users").then(u => { if (u) users = u; }).catch(() => { });
    }
  });

  inputEl.addEventListener("input", () => {
    const atInfo = getQueryAtCursor();
    if (atInfo === null) {
      closeDropdown();
      return;
    }
    const q = atInfo.query.toLowerCase().trim();
    const pool = users && users.length ? users : [];
    const matches = pool.filter(u => {
      const name = (u.name || "").toLowerCase();
      const email = (u.email || "").toLowerCase();
      return !q || name.includes(q) || email.includes(q);
    }).slice(0, 8);

    renderDropdown(matches, atInfo);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (!dropdown || !currentMatches.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % currentMatches.length;
      updateActiveItem();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + currentMatches.length) % currentMatches.length;
      updateActiveItem();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (currentMatches[activeIndex]) {
        e.preventDefault();
        const atInfo = getQueryAtCursor();
        if (atInfo) selectUser(currentMatches[activeIndex], atInfo);
      }
    } else if (e.key === "Escape") {
      closeDropdown();
    }
  });

  function updateActiveItem() {
    if (!dropdown) return;
    const items = dropdown.querySelectorAll(".mention-item");
    items.forEach((item, idx) => {
      if (idx === activeIndex) {
        item.classList.add("active");
        item.scrollIntoView({ block: "nearest" });
      } else {
        item.classList.remove("active");
      }
    });
  }

  inputEl.addEventListener("blur", () => {
    setTimeout(closeDropdown, 200);
  });
}

async function loadComments(issueId, isSilent = false) {
  const box = byId("commentList");
  if (!box) return;
  if (!isSilent && !box.children.length) {
    box.innerHTML = `<div class="muted">Loading…</div>`;
  }
  try {
    const comments = await api(`/comments/${issueId}`);
    if (!comments || !comments.length) {
      box.innerHTML = `<div class="muted">No comments yet.</div>`;
      return;
    }
    // Always sort descending: latest comment first
    comments.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
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
          <div class="c-meta"><span>${esc(userLabel(c.user_id))}</span><span>${timeAgo(c.created_at)}</span></div>
          ${c.body ? `<div class="c-body">${formatCommentBody(c.body)}</div>` : ""}
          ${attachmentHtml}
        </div>`;
    }).join("");

    box.innerHTML = html;
    box.scrollTop = 0;
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
