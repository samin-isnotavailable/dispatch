import { supabase } from "./supabaseClient.js";

export function renderAuthScreen(root) {
  root.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1>Dispatch tracker</h1>
        <p class="sub">Sign in with the account your admin set up for you.</p>
        <form id="login-form">
          <input type="text" id="email" placeholder="name@company.com" autocomplete="username" required />
          <input type="password" id="password" placeholder="Password" autocomplete="current-password" required />
          <button type="submit" class="primary">Sign in</button>
          <p class="error" id="login-error" style="display:none"></p>
        </form>
      </div>
    </div>
  `;

  const form = root.querySelector("#login-form");
  const errorEl = root.querySelector("#login-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.style.display = "none";
    const email = root.querySelector("#email").value.trim();
    const password = root.querySelector("#password").value;

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      errorEl.textContent = error.message;
      errorEl.style.display = "block";
    }
    // On success, the onAuthStateChange listener in main.js re-renders.
  });
}
