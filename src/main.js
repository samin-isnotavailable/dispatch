import "./style.css";
import { supabase } from "./supabaseClient.js";
import { renderAuthScreen } from "./auth.js";
import { renderDashboard } from "./dashboard.js";

const root = document.getElementById("app");

async function boot() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session) {
    renderDashboard(root, session);
  } else {
    renderAuthScreen(root);
  }
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) {
    renderDashboard(root, session);
  } else {
    renderAuthScreen(root);
  }
});

boot();
