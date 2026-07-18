import { supabase } from "./supabaseClient.js";

let profile = null;
let warehouses = [];
let orders = [];
let activeWarehouseId = null;
let activeView = "warehouse"; // "warehouse" | "notes"
let realtimeChannel = null;
let notesSaveTimer = null;

export async function renderDashboard(root, session) {
  const { data: profileRow, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, role, warehouse_id")
    .eq("id", session.user.id)
    .single();

  if (profileError || !profileRow) {
    root.innerHTML = `<div class="auth-screen"><div class="auth-card">
      <h1>No profile yet</h1>
      <p class="sub">Your account exists but hasn't been assigned a role. Ask your admin to set your role and warehouse in Supabase, then reload.</p>
      <button id="signout">Sign out</button>
    </div></div>`;
    root.querySelector("#signout").addEventListener("click", () => supabase.auth.signOut());
    return;
  }

  profile = profileRow;

  const { data: warehouseRows } = await supabase
    .from("warehouses")
    .select("id, name")
    .order("name", { ascending: true });
  warehouses = warehouseRows || [];

  if (!warehouses.length) {
    root.innerHTML = `<div class="auth-screen"><div class="auth-card">
      <h1>No warehouses yet</h1>
      <p class="sub">${profile.role === "super_admin" ? "Add your first warehouse to get started." : "Ask your admin to set up a warehouse."}</p>
      ${profile.role === "super_admin" ? `<button id="add-first-wh" class="primary">Add warehouse</button>` : ""}
      <button id="signout">Sign out</button>
    </div></div>`;
    root.querySelector("#signout").addEventListener("click", () => supabase.auth.signOut());
    const addBtn = root.querySelector("#add-first-wh");
    if (addBtn) addBtn.addEventListener("click", () => addWarehouse(root, session));
    return;
  }

  // Staff land on their assigned warehouse; admins (or staff with no
  // assignment yet) land on the first warehouse alphabetically.
  activeWarehouseId =
    (profile.role === "staff" && profile.warehouse_id) || warehouses[0].id;

  await paint(root, session);
  subscribeRealtime(root, session);
}

async function paint(root, session) {
  root.innerHTML = `
    <div class="app-shell">
      <div class="topbar">
        <div class="brand">Dispatch<span class="tag">EZ</span></div>
        <div class="who">
          ${profile.role === "super_admin" ? `<span class="badge-admin">Super admin</span>` : ""}
          <span>${profile.full_name || session.user.email}</span>
          <button class="ghost" id="signout">Sign out</button>
        </div>
      </div>
      <main class="container">
        <div class="tabs" id="tabs"></div>
        <div id="view-body"></div>
      </main>
    </div>
  `;

  root.querySelector("#signout").addEventListener("click", () => supabase.auth.signOut());
  renderTabs(root, session);

  if (activeView === "notes") {
    await paintNotesView(root, session);
  } else {
    await paintWarehouseView(root, session);
  }
}

async function paintWarehouseView(root, session) {
  const body = root.querySelector("#view-body");
  body.innerHTML = `
    <div class="manual-add">
      <input type="text" id="manual-order-id" placeholder="Paste order ID, e.g. WOO-3423" />
      <select id="manual-warehouse"></select>
      <button class="primary" id="manual-add-btn">Add order</button>
    </div>
    <div id="date-groups"></div>
  `;
  renderManualAdd(root, session);
  await loadOrdersForActiveWarehouse(root, session);
}

async function paintNotesView(root, session) {
  const body = root.querySelector("#view-body");
  body.innerHTML = `
    <div class="date-group">
      <div class="date-group-head">
        <div class="title"><h3>Notes</h3></div>
        <span class="count" id="notes-status">Loading…</span>
      </div>
      <textarea id="notes-textarea" placeholder="Random notes and stuff…"
        style="width:100%;min-height:360px;border:1px solid var(--border-strong);
        border-radius:var(--radius);padding:12px;font-family:var(--font-body);
        font-size:14px;line-height:1.5;resize:vertical;background:var(--surface-sunken);color:var(--ink)"></textarea>
    </div>
  `;

  const textarea = body.querySelector("#notes-textarea");
  const status = body.querySelector("#notes-status");

  const { data, error } = await supabase
    .from("notes")
    .select("content")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error) {
    status.textContent = "Couldn't load notes";
  } else {
    textarea.value = data?.content || "";
    status.textContent = "Saved";
  }

  textarea.addEventListener("input", () => {
    status.textContent = "Saving…";
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(async () => {
      const { error: saveError } = await supabase
        .from("notes")
        .upsert({ user_id: session.user.id, content: textarea.value, updated_at: new Date().toISOString() });
      status.textContent = saveError ? "Couldn't save" : "Saved";
    }, 600);
  });
}

function renderTabs(root, session) {
  const tabsEl = root.querySelector("#tabs");
  tabsEl.innerHTML = warehouses
    .map(
      (w) =>
        `<div class="tab ${activeView === "warehouse" && w.id === activeWarehouseId ? "active" : ""}" data-id="${w.id}">${escapeHtml(w.name)}</div>`
    )
    .join("");

  tabsEl.innerHTML += `<div class="tab ${activeView === "notes" ? "active" : ""}" id="notes-tab">Notes</div>`;

  if (profile.role === "super_admin") {
    tabsEl.innerHTML += `<div class="tab add-warehouse" id="add-warehouse-tab"><i>+</i> Add warehouse</div>`;
  }

  tabsEl.querySelectorAll(".tab[data-id]").forEach((el) => {
    el.addEventListener("click", async () => {
      activeView = "warehouse";
      activeWarehouseId = el.dataset.id;
      await paint(root, session);
    });
  });

  tabsEl.querySelector("#notes-tab").addEventListener("click", async () => {
    activeView = "notes";
    await paint(root, session);
  });

  const addTab = tabsEl.querySelector("#add-warehouse-tab");
  if (addTab) addTab.addEventListener("click", () => addWarehouse(root, session));
}

function renderManualAdd(root, session) {
  const select = root.querySelector("#manual-warehouse");
  // Staff can only manually add into their own warehouse; admin can pick any.
  const options =
    profile.role === "super_admin"
      ? warehouses
      : warehouses.filter((w) => w.id === profile.warehouse_id);
  select.innerHTML = options.map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("");
  select.value = options.some((w) => w.id === activeWarehouseId) ? activeWarehouseId : options[0]?.id || "";

  const input = root.querySelector("#manual-order-id");

  const submitOrder = async () => {
    const orderId = input.value.trim();
    const warehouseId = select.value;
    if (!orderId || !warehouseId) return;

    const { error } = await supabase.from("orders").insert({
      order_id: orderId,
      warehouse_id: warehouseId,
      created_by: session.user.id,
    });
    if (error) {
      alert(`Couldn't add order: ${error.message}`);
      return;
    }
    input.value = "";
    input.focus();
    if (warehouseId === activeWarehouseId) await loadOrdersForActiveWarehouse(root, session);
  };

  root.querySelector("#manual-add-btn").addEventListener("click", submitOrder);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitOrder();
    }
  });
}

async function loadOrdersForActiveWarehouse(root, session) {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_id, done, created_at, created_by")
    .eq("warehouse_id", activeWarehouseId)
    .order("created_at", { ascending: false });

  if (error) {
    root.querySelector("#date-groups").innerHTML = `<p class="empty-note">Couldn't load orders: ${error.message}</p>`;
    return;
  }
  orders = data || [];
  renderDateGroups(root, session);
}

function renderDateGroups(root, session) {
  const container = root.querySelector("#date-groups");
  if (!orders.length) {
    container.innerHTML = `<p class="empty-note">No orders yet for this warehouse.</p>`;
    return;
  }

  const groups = new Map();
  for (const o of orders) {
    const dateKey = new Date(o.created_at).toDateString();
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(o);
  }

  const todayKey = new Date().toDateString();
  const canEdit = profile.role === "super_admin" || activeWarehouseId === profile.warehouse_id;

  container.innerHTML = [...groups.entries()]
    .map(([dateKey, rows]) => {
      const doneCount = rows.filter((r) => r.done).length;
      return `
        <div class="date-group ${dateKey === todayKey ? "today" : ""}" data-date="${dateKey}">
          <div class="date-group-head">
            <div class="title">
              <h3>${formatDateLabel(dateKey)}</h3>
              <span class="count">${rows.length} order${rows.length === 1 ? "" : "s"} · ${doneCount} done</span>
            </div>
            <div class="actions">
              ${canEdit ? `<button class="mark-all" data-date="${dateKey}">Mark all complete</button>` : ""}
              <button class="export" data-date="${dateKey}">Export</button>
            </div>
          </div>
          <div class="order-list">
            ${rows
              .map(
                (o) => `
              <div class="order-row ${o.done ? "done" : ""}">
                <input type="checkbox" data-id="${o.id}" ${o.done ? "checked" : ""} ${canEdit ? "" : "disabled"} />
                <span class="order-id">${escapeHtml(o.order_id)}</span>
                <span class="time">${formatTime(o.created_at)}</span>
                ${profile.role === "super_admin" ? `<button class="ghost delete-order" data-id="${o.id}" title="Delete order">✕</button>` : ""}
              </div>`
              )
              .join("")}
          </div>
        </div>`;
    })
    .join("");
  container.querySelectorAll(".delete-order").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this order? This can't be undone.")) return;
      const { error } = await supabase.from("orders").delete().eq("id", btn.dataset.id);
      if (error) {
        alert(`Couldn't delete order: ${error.message}`);
        return;
      }
      await loadOrdersForActiveWarehouse(root, session);
    });
  });
  container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", async () => {
      const { error } = await supabase
        .from("orders")
        .update({ done: cb.checked })
        .eq("id", cb.dataset.id);
      if (error) {
        alert(`Couldn't update order: ${error.message}`);
        cb.checked = !cb.checked;
        return;
      }
      await loadOrdersForActiveWarehouse(root, session);
    });
  });

  container.querySelectorAll(".mark-all").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const dateKey = btn.dataset.date;
      const ids = groups.get(dateKey).map((o) => o.id);
      const { error } = await supabase.from("orders").update({ done: true }).in("id", ids);
      if (error) {
        alert(`Couldn't mark all complete: ${error.message}`);
        return;
      }
      await loadOrdersForActiveWarehouse(root, session);
    });
  });

  container.querySelectorAll(".export").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dateKey = btn.dataset.date;
      const rows = groups.get(dateKey);
      exportOrderIds(rows, dateKey);
    });
  });
}

function exportOrderIds(rows, dateKey) {
  const text = rows.map((r) => r.order_id).join("\n");
  const warehouseName = warehouses.find((w) => w.id === activeWarehouseId)?.name || "warehouse";
  const filename = `${warehouseName}_${dateKey.replace(/\s+/g, "-")}.txt`;

  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

async function addWarehouse(root, session) {
  const name = prompt("New warehouse name:");
  if (!name || !name.trim()) return;
  const { error } = await supabase.from("warehouses").insert({ name: name.trim() });
  if (error) {
    alert(`Couldn't add warehouse: ${error.message}`);
    return;
  }
  const { data: warehouseRows } = await supabase
    .from("warehouses")
    .select("id, name")
    .order("name", { ascending: true });
  warehouses = warehouseRows || [];
  await paint(root, session);
}

function subscribeRealtime(root, session) {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase
    .channel("orders-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => {
      if (activeView === "warehouse") loadOrdersForActiveWarehouse(root, session);
    })
    .subscribe();
}

function formatDateLabel(dateKey) {
  const d = new Date(dateKey);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
