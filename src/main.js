import "./style.css";
import { supabase } from "./supabaseClient.js";
import { renderAuthScreen } from "./auth.js";
import { renderDashboard } from "./dashboard.js";
import { renderAdminPanel } from "./admin.js";

const root = document.getElementById("app");
let booted = false;

function renderCurrentRoute(session) {
  if (window.location.pathname.startsWith("/admin")) {
    renderAdminPanel(root, session);
  } else {
    renderDashboard(root, session);
  }
}

async function boot() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session) {
    booted = true;
    renderCurrentRoute(session);
  } else {
    renderAuthScreen(root);
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  if (!session) {
    booted = false;
    renderAuthScreen(root);
    return;
  }

  // Supabase silently refreshes the token in the background (including
  // when a tab regains focus). That's routine, not a new sign-in —
  // re-rendering on it would reset whichever warehouse tab you were
  // viewing back to the default. Only initialize on an actual sign-in.
  if (event === "SIGNED_IN" && !booted) {
    booted = true;
    renderCurrentRoute(session);
  }
});

boot();
