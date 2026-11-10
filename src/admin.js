import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./escape.js";
import { iconX, iconRotate } from "./icons.js";
import { topbarHtml, wireTopbar } from "./topbar.js";
import { showConfirm } from "./dialogs.js";

export async function renderAdminPanel(root, session) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("*") // "*" so this still loads before 0011 adds is_owner
    .eq("id", session.user.id)
    .single();

  if (profile?.is_owner !== true) {
    root.innerHTML = `
      <div class="auth-screen"><div class="auth-card">
        <h1>Not authorized</h1>
        <p class="sub">Only the owner can manage people and warehouses.</p>
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
    .select("id, full_name, role, warehouse_id, is_owner")
    .order("role", { ascending: false });

  root.innerHTML = `
    <div class="app-shell">
      ${topbarHtml(`<button class="ghost" id="back-to-dashboard">Dashboard</button>`)}
      <main class="container admin-page">
        <div class="date-group">
          <div class="date-group-head"><div class="title"><h3>Add a user</h3></div></div>
          <form id="create-user-form" class="admin-form">
            <input type="text" id="new-name" placeholder="Full name" />
            <input type="text" id="new-email" placeholder="Email" required />
            <div class="password-field span-2">
              <input type="text" id="new-password" placeholder="Temporary password" value="${generatePassword()}" required />
              <button type="button" class="ghost icon-btn" id="regen-password" title="Generate a new password" aria-label="Generate a new password">${iconRotate}</button>
            </div>
            <select id="new-role">
              <option value="staff">Staff</option>
              <option value="super_admin">Super admin</option>
            </select>
            <select id="new-warehouse">
              ${warehouses.map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("")}
            </select>
            <button type="submit" class="primary span-2">Create user</button>
            <p id="create-status" class="span-2" aria-live="polite"></p>
          </form>
        </div>

        <div class="date-group">
          <div class="date-group-head"><div class="title"><h3>Existing users</h3></div></div>
          <div class="order-list" id="user-list">
            ${profiles
              .map(
                (p) => `
              <div class="user-row" data-user-id="${p.id}">
                <span class="user-name">${escapeHtml(p.full_name || "(no name)")}</span>
                ${p.is_owner ? `<span class="badge-admin">Owner</span>` : `<select class="edit-role" data-id="${p.id}">
                  <option value="staff" ${p.role === "staff" ? "selected" : ""}>Staff</option>
                  <option value="super_admin" ${p.role === "super_admin" ? "selected" : ""}>Super admin</option>
                </select>
                <select class="edit-warehouse" data-id="${p.id}" ${p.role === "super_admin" ? "disabled" : ""}>
                  ${warehouses
                    .map((w) => `<option value="${w.id}" ${p.warehouse_id === w.id ? "selected" : ""}>${escapeHtml(w.name)}</option>`)
                    .join("")}
                </select>
                <button class="save-user" data-id="${p.id}">Save</button>
                ${p.id !== session.user.id ? `<button class="ghost icon-btn delete-user" data-id="${p.id}" title="Delete user" aria-label="Delete user ${escapeHtml(p.full_name || "this user")}">${iconX}</button>` : ""}
                <span class="save-status" data-id="${p.id}" aria-live="polite"></span>`}
              </div>`
              )
              .join("")}
          </div>
        </div>

        <div class="date-group">
          <div class="date-group-head"><div class="title"><h3>Warehouses</h3></div></div>
          <div class="order-list" id="warehouse-list" style="margin-bottom:14px">
            ${warehouses
              .map(
                (w) => `
              <div class="user-row">
                <span class="user-name">${escapeHtml(w.name)}</span>
                <button class="ghost icon-btn delete-warehouse" data-id="${w.id}" title="Remove warehouse" aria-label="Remove warehouse ${escapeHtml(w.name)}">${iconX}</button>
              </div>`
              )
              .join("")}
          </div>
          <form id="add-warehouse-form" style="display:flex;gap:8px;max-width:420px">
            <input type="text" id="new-warehouse-name" placeholder="New warehouse name" required style="flex:1" />
            <button type="submit" class="primary">Add</button>
          </form>
          <p id="warehouse-status" style="font-size:13px;margin-top:8px" aria-live="polite"></p>
        </div>
      </main>
    </div>
  `;

  root.querySelector("#back-to-dashboard").addEventListener("click", () => {
    window.location.href = "/";
  });
  wireTopbar(root);

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
      const { data: refreshedWarehouses } = await supabase.from("warehouses").select("id, name").order("name");
      await paint(root, session, refreshedWarehouses || warehouses);
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

  root.querySelectorAll(".delete-user").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const row = root.querySelector(`.user-row[data-user-id="${id}"]`);
      const name = row?.querySelector(".user-name")?.textContent || "this user";
      if (!(await showConfirm(`Delete ${name}? This permanently removes their login and can't be undone.`, { confirmLabel: "Delete", danger: true }))) return;

      const statusEl = root.querySelector(`.save-status[data-id="${id}"]`);
      statusEl.textContent = "Deleting…";
      statusEl.style.color = "var(--ink-muted)";

      try {
        const res = await fetch("/api/admin-delete-user", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ id }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "Something went wrong");
        await paint(root, session, warehouses);
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
        statusEl.style.color = "var(--danger)";
      }
    });
  });

  root.querySelectorAll(".delete-warehouse").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const w = warehouses.find((x) => x.id === btn.dataset.id);
      const staff = profiles.filter((p) => p.warehouse_id === w.id).length;
      const msg = `Remove ${w.name}?${staff ? ` ${staff} staff assigned to it will have no warehouse until you pick a new one.` : ""} This can't be undone.`;
      if (!(await showConfirm(msg, { confirmLabel: "Remove", danger: true }))) return;
      const status = root.querySelector("#warehouse-status");
      const { error } = await supabase.from("warehouses").delete().eq("id", w.id);
      if (error) {
        // orders.warehouse_id is ON DELETE RESTRICT: past orders keep it alive.
        status.textContent =
          error.code === "23503"
            ? `${w.name} still has orders on file, so it can't be removed. Its order history would be lost.`
            : `Couldn't remove ${w.name}: ${error.message}`;
        status.style.color = "var(--danger)";
        return;
      }
      const { data: refreshedWarehouses } = await supabase.from("warehouses").select("id, name").order("name");
      await paint(root, session, refreshedWarehouses || []);
    });
  });

  root.querySelector("#add-warehouse-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = root.querySelector("#new-warehouse-name");
    const status = root.querySelector("#warehouse-status");
    const name = input.value.trim();
    if (!name) return;

    const { error } = await supabase.from("warehouses").insert({ name });
    if (error) {
      status.textContent = `Couldn't add warehouse: ${error.message}`;
      status.style.color = "var(--danger)";
      return;
    }
    input.value = "";
    const { data: refreshedWarehouses } = await supabase.from("warehouses").select("id, name").order("name");
    await paint(root, session, refreshedWarehouses || warehouses);
  });
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
