const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");
const message = document.getElementById("message");

function getRedirectTarget() {
  const params = new URLSearchParams(window.location.search);
  const redirect = params.get("redirect");
  if (redirect) return redirect;
  const pendingInvite = localStorage.getItem("clove_pending_invite");
  if (pendingInvite) return `invite.html?token=${encodeURIComponent(pendingInvite)}`;
  return "index.html";
}

if (loginForm) loginForm.addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const data = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("email").value,
        password: document.getElementById("password").value
      })
    });
    localStorage.setItem("clove_token", data.access_token);
    localStorage.setItem("clove_user", JSON.stringify(data.user));
    localStorage.removeItem("clove_project");
    localStorage.removeItem("clove_tab");
    localStorage.removeItem("clove_view");
    localStorage.removeItem("clove_open_project");
    localStorage.removeItem("clove_recent");
    location.href = getRedirectTarget();
  } catch(err) {
    message.textContent = `⚠️ ${err.message}`;
    message.style.color = "var(--status-error)";
  }
});

if (signupForm) signupForm.addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api("/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("name").value,
        email: document.getElementById("email").value,
        password: document.getElementById("password").value
      })
    });
    message.textContent = "✓ Account created. Redirecting to login...";
    message.style.color = "var(--status-success)";
    const redirect = getRedirectTarget();
    setTimeout(() => {
      location.href = redirect !== "index.html" ? `login.html?redirect=${encodeURIComponent(redirect)}` : "login.html";
    }, 800);
  } catch(err) {
    message.textContent = `⚠️ ${err.message}`;
    message.style.color = "var(--status-error)";
  }
});
