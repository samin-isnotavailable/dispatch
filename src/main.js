import "./style.css";
import { supabase } from "./supabaseClient.js";
import { renderAuthScreen } from "./auth.js";
import { renderDashboard } from "./dashboard.js";

const root = document.getElementById("app");
let dashboardBooted = false;

async function boot() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session) {
    dashboardBooted = true;
    renderDashboard(root, session);
  } else {
    renderAuthScreen(root);
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  if (!session) {
    dashboardBooted = false;
    renderAuthScreen(root);
    return;
  }

  // Supabase silently refreshes the token in the background (including
  // when a tab regains focus). That's routine, not a new sign-in — 
  // re-running renderDashboard on it would reset whichever warehouse
  // tab you were viewing back to the default. Only initialize on an
  // actual sign-in.
  if (event === "SIGNED_IN" && !dashboardBooted) {
    dashboardBooted = true;
    renderDashboard(root, session);
  }
});

boot();