import { supabase } from "./supabaseClient.js";

export async function renderAdminPanel(root, session) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", session.user.id)
    .single();

  if (profile?.role !== "super_admin") {
    root.innerHTML = `
      <div class="auth-screen"><div class="auth-card">
        <h1>Not authorized</h1>
        <p class="sub">This page is only available to super admins.</p>
        <button id="back" class="primary">Back to dashboard</button>
      </div></div>`;
    root.querySelector("#back").addEventListener("click", () => {
      window.location.href = "/";
    });
    return;
  }

  const { data: warehouses } = await supabase.from("warehouses").select("id, name").order("name");
  await paint(root, session, warehouses || []);
}

async function paint(root, session, warehouses) {
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, full_name, role, warehouse_id")
    .order("role", { ascending: false });

  root.innerHTML = `
    <div class="app-shell">
      <div class="topbar">
        <div class="brand">Dispatch<span class="tag">EZ</span></div>
        <div class="who">
          <span class="badge-admin">Admin panel</span>
          <button class="ghost" id="back-to-dashboard">Back to dashboard</button>
          <button class="ghost" id="signout">Sign out</button>
        </div>
      </div>
      <main class="container">
        <div class="date-group">
          <div class="date-group-head"><div class="title"><h3>Add a user</h3></div></div>
          <form id="create-user-form" style="display:flex;flex-direction:column;gap:10px;max-width:420px">
            <input type="text" id="new-name" placeholder="Full name" />
            <input type="text" id="new-email" placeholder="Email" required />
            <div style="display:flex;gap:8px">
              <input type="text" id="new-password" placeholder="Temporary password" value="${generatePassword()}" required style="flex:1" />
              <button type="button" class="ghost" id="regen-password" title="Generate a new password">↻</button>
            </div>
            <select id="new-role">
              <option value="staff">Staff</option>
              <option value="super_admin">Super admin</option>
            </select>
            <select id="new-warehouse">
              ${warehouses.map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("")}
            </select>
            <button type="submit" class="primary">Create user</button>
            <p id="create-status" style="font-size:13px"></p>
          </form>
        </div>

        <div class="date-group">
          <div class="date-group-head"><div class="title"><h3>Existing users</h3></div></div>
          <div class="order-list" id="user-list">
            ${profiles
              .map(
                (p) => `
              <div class="order-row" data-user-id="${p.id}" style="flex-wrap:wrap">
                <span class="order-id" style="font-family:var(--font-body);min-width:140px">${escapeHtml(p.full_name || "(no name)")}</span>
                <select class="edit-role" data-id="${p.id}">
                  <option value="staff" ${p.role === "staff" ? "selected" : ""}>Staff</option>
                  <option value="super_admin" ${p.role === "super_admin" ? "selected" : ""}>Super admin</option>
                </select>
                <select class="edit-warehouse" data-id="${p.id}" ${p.role === "super_admin" ? "disabled" : ""}>
                  ${warehouses
                    .map((w) => `<option value="${w.id}" ${p.warehouse_id === w.id ? "selected" : ""}>${escapeHtml(w.name)}</option>`)
                    .join("")}
                </select>
                <button class="save-user" data-id="${p.id}">Save</button>
                <span class="time save-status" data-id="${p.id}"></span>
              </div>`
              )
              .join("")}
          </div>
        </div>
      </main>
    </div>
  `;

  root.querySelector("#back-to-dashboard").addEventListener("click", () => {
    window.location.href = "/";
  });
  root.querySelector("#signout").addEventListener("click", () => supabase.auth.signOut());

  root.querySelector("#regen-password").addEventListener("click", () => {
    root.querySelector("#new-password").value = generatePassword();
  });

  root.querySelector("#new-role").addEventListener("change", (e) => {
    root.querySelector("#new-warehouse").disabled = e.target.value === "super_admin";
  });

  root.querySelector("#create-user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = root.querySelector("#create-status");
    status.textContent = "Creating…";
    status.style.color = "var(--ink-muted)";

    const payload = {
      full_name: root.querySelector("#new-name").value.trim(),
      email: root.querySelector("#new-email").value.trim(),
      password: root.querySelector("#new-password").value,
      role: root.querySelector("#new-role").value,
      warehouse_id: root.querySelector("#new-warehouse").value,
    };

    try {
      const res = await fetch("/api/admin-create-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Something went wrong");

      status.textContent = `Created ${result.email}. Share this password with them: ${payload.password}`;
      status.style.color = "var(--success)";
      await paint(root, session, warehouses);
    } catch (err) {
      status.textContent = err.message;
      status.style.color = "var(--danger)";
    }
  });

  root.querySelectorAll(".save-user").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const role = root.querySelector(`.edit-role[data-id="${id}"]`).value;
      const warehouseId = root.querySelector(`.edit-warehouse[data-id="${id}"]`).value;
      const statusEl = root.querySelector(`.save-status[data-id="${id}"]`);

      const { error } = await supabase
        .from("profiles")
        .update({ role, warehouse_id: role === "super_admin" ? null : warehouseId })
        .eq("id", id);

      statusEl.textContent = error ? `Failed: ${error.message}` : "Saved";
      statusEl.style.color = error ? "var(--danger)" : "var(--success)";
    });
  });

  root.querySelectorAll(".edit-role").forEach((select) => {
    select.addEventListener("change", () => {
      const warehouseSelect = root.querySelector(`.edit-warehouse[data-id="${select.dataset.id}"]`);
      warehouseSelect.disabled = select.value === "super_admin";
    });
  });
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
