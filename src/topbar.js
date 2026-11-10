// The bar across the top of every signed-in page: brand, light/dark switch,
// sign out. The saved theme is applied before the page draws, by the small
// script in index.html, so there's no flash of the wrong colours.

import { supabase } from "./supabaseClient.js";
import { iconSun, iconMoon } from "./icons.js";

const THEME_KEY = "dispatchez.theme";

const currentTheme = () => document.documentElement.dataset.theme || "dark";

export function topbarHtml(extra = "") {
  return `
    <div class="topbar">
      <div class="brand">Dispatch<span class="tag">EZ</span></div>
      <div class="who">
        ${extra}
        <button class="ghost icon-btn" id="theme-toggle"></button>
        <button class="ghost" id="signout">Sign out</button>
      </div>
    </div>`;
}

export function wireTopbar(root) {
  const btn = root.querySelector("#theme-toggle");
  const sync = () => {
    const dark = currentTheme() === "dark";
    btn.innerHTML = dark ? iconSun : iconMoon;
    btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("aria-label", btn.title);
  };
  sync();
  btn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage blocked: the switch still works until reload.
    }
    sync();
  });
  root.querySelector("#signout").addEventListener("click", () => supabase.auth.signOut());
}
