import { signIn, signOut, getSession } from "./authClient.js";

const app = document.getElementById("app");

async function render() {
  const session = await getSession();
  if (session) {
    app.innerHTML = `
      <div class="signed-in">
        <h1>Dispatch<span class="tag">EZ</span> Capture</h1>
        <p>Signed in as <strong>${session.user_email}</strong></p>
        <button id="signout">Sign out</button>
        <p class="hint">Select an order ID on any page, right-click, and choose "Send to warehouse".</p>
      </div>
    `;
    document.getElementById("signout").addEventListener("click", async () => {
      await signOut();
      chrome.runtime.sendMessage({ type: "refresh-menu" });
      render();
    });
  } else {
    app.innerHTML = `
      <h1>Sign in</h1>
      <input type="text" id="email" placeholder="name@company.com" />
      <input type="password" id="password" placeholder="Password" />
      <button id="signin">Sign in</button>
      <p class="error" id="error" style="display:none"></p>
      <p class="hint">Use the same account your admin set up for the dashboard.</p>
    `;
    document.getElementById("signin").addEventListener("click", async () => {
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;
      const errorEl = document.getElementById("error");
      try {
        await signIn(email, password);
        chrome.runtime.sendMessage({ type: "refresh-menu" });
        render();
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    });
  }
}

render();
