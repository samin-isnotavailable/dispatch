import { supabase } from "./supabaseClient.js";
import { iconX, iconFlag, iconRotate } from "./icons.js";
import { showAlert, showConfirm, showDuplicateWarning } from "./dialogs.js";

let profile = null;
let warehouses = [];
let orders = [];
let activeWarehouseId = null;
let activeView = "warehouse"; // "warehouse" | "notes"
let realtimeChannel = null;
let notesSaveTimer = null;

// Orders / Products toggle above the date cards. Remembered per browser.
const LIST_MODE_KEY = "dispatchez.listMode";
let listMode = readListMode(); // "orders" | "products"
// "Collected" ticks for the Products view, keyed by pickKey(date, name),
// value = how many units were needed when it was ticked.
let pickMarks = new Map();
// Products currently on screen, so checkboxes can refer to them by index
// instead of putting product names (which may contain quotes) in HTML
// attributes.
let renderedProducts = [];

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
      <p class="sub">${profile.role === "super_admin" ? "Add your first warehouse from the admin panel." : "Ask your admin to set up a warehouse."}</p>
      ${profile.role === "super_admin" ? `<button id="go-admin" class="primary">Go to admin panel</button>` : ""}
      <button id="signout">Sign out</button>
    </div></div>`;
    root.querySelector("#signout").addEventListener("click", () => supabase.auth.signOut());
    const goAdminBtn = root.querySelector("#go-admin");
    if (goAdminBtn) goAdminBtn.addEventListener("click", () => (window.location.href = "/admin"));
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
          ${profile.role === "super_admin" ? `<span class="badge-admin">Super admin</span><a href="/admin" style="color:var(--ink-secondary);font-size:13px;text-decoration:none">Admin panel</a>` : ""}
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
  } else if (activeView === "prebook") {
    const { renderPrebook } = await import("./prebook.js");
    await renderPrebook(root.querySelector("#view-body"), session, profile);
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
    <div class="view-toggle" role="group" aria-label="Show orders or products">
      <button type="button" data-mode="orders">Orders</button>
      <button type="button" data-mode="products">Products</button>
    </div>
    <div id="date-groups"></div>
  `;
  const toggleButtons = body.querySelectorAll(".view-toggle button");
  const syncToggle = () =>
    toggleButtons.forEach((b) => {
      const on = b.dataset.mode === listMode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  syncToggle();
  toggleButtons.forEach((b) =>
    b.addEventListener("click", () => {
      if (listMode === b.dataset.mode) return;
      listMode = b.dataset.mode;
      saveListMode(listMode);
      syncToggle();
      renderDateGroups(root, session);
    })
  );
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
        font-size:14px;line-height:1.5;resize:vertical;background:var(--surface-2);color:var(--ink)"></textarea>
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
  tabsEl.setAttribute("role", "tablist");
  tabsEl.innerHTML = warehouses
    .map((w) => {
      const active = activeView === "warehouse" && w.id === activeWarehouseId;
      return `<div class="tab ${active ? "active" : ""}" data-id="${w.id}" role="tab" tabindex="0" aria-selected="${active}">${escapeHtml(w.name)}</div>`;
    })
    .join("");

  tabsEl.innerHTML += `<div class="tab ${activeView === "notes" ? "active" : ""}" id="notes-tab" role="tab" tabindex="0" aria-selected="${activeView === "notes"}">Notes</div>`;
  tabsEl.innerHTML += `<div class="tab ${activeView === "prebook" ? "active" : ""}" id="prebook-tab" role="tab" tabindex="0" aria-selected="${activeView === "prebook"}">Prebook</div>`;

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

  tabsEl.querySelector("#prebook-tab").addEventListener("click", async () => {
    activeView = "prebook";
    await paint(root, session);
  });

  // Tabs are divs (not native buttons) so they need explicit keyboard
  // activation to be operable without a mouse.
  tabsEl.querySelectorAll(".tab").forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        el.click();
      }
    });
  });
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

    let { data, error } = await supabase.rpc("capture_order", {
      p_order_id: orderId,
      p_warehouse_id: warehouseId,
      p_dispatch_date: todayDateKey(),
    });
    if (error) {
      await showAlert(`Couldn't add order: ${error.message}`);
      return;
    }

    let result = data?.[0];
    if (result && !result.inserted) {
      const proceed = await showDuplicateWarning({ orderId, matches: result.existing_matches || [] });
      if (!proceed) return;
      ({ data, error } = await supabase.rpc("capture_order", {
        p_order_id: orderId,
        p_warehouse_id: warehouseId,
        p_dispatch_date: todayDateKey(),
        p_force: true,
      }));
      if (error) {
        await showAlert(`Couldn't add order: ${error.message}`);
        return;
      }
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
  const warehouseId = activeWarehouseId;
  const [ordersRes, picksRes] = await Promise.all([
    supabase
      .from("orders")
      .select("id, order_id, warehouse_id, done, created_at, created_by, dispatch_date, exception_type, exception_note, rescheduled_to_id, details")
      .eq("warehouse_id", warehouseId)
      .order("created_at", { ascending: false }),
    supabase.from("pick_marks").select("dispatch_date, product_name, picked_qty").eq("warehouse_id", warehouseId),
  ]);

  // The user may have switched warehouse while this was loading.
  if (warehouseId !== activeWarehouseId || !root.querySelector("#date-groups")) return;

  if (ordersRes.error) {
    root.querySelector("#date-groups").innerHTML = `<p class="empty-note">Couldn't load orders: ${escapeHtml(ordersRes.error.message)}</p>`;
    return;
  }
  orders = ordersRes.data || [];
  pickMarks = new Map((picksRes.data || []).map((p) => [pickKey(p.dispatch_date, p.product_name), p.picked_qty]));
  renderDateGroups(root, session);
}

function renderDateGroups(root, session) {
  const container = root.querySelector("#date-groups");
  if (!container) return;
  if (!orders.length) {
    container.innerHTML = `<p class="empty-note">No orders yet for this warehouse.</p>`;
    return;
  }

  const groups = new Map();
  for (const o of orders) {
    const dateKey = o.dispatch_date;
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(o);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const todayKey = todayDateKey();
  const canEdit = profile.role === "super_admin" || activeWarehouseId === profile.warehouse_id;
  renderedProducts = [];

  container.innerHTML = sortedKeys
    .map((dateKey) => {
      const rows = groups.get(dateKey);
      const body = listMode === "products" ? renderProductsBody(dateKey, rows, canEdit) : renderOrdersBody(rows, canEdit);
      return `
        <div class="date-group ${dateKey === todayKey ? "today" : ""}" data-date="${dateKey}">
          <div class="date-group-head">
            <div class="title">
              <h3>${formatDateLabel(dateKey)}</h3>
              <span class="count">${body.countLabel}</span>
            </div>
            <div class="actions">
              ${canEdit && listMode === "orders" ? `<button class="mark-all" data-date="${dateKey}">Mark all complete</button>` : ""}
              <button class="export" data-date="${dateKey}">Export</button>
            </div>
          </div>
          <div class="order-list">${body.html}</div>
        </div>`;
    })
    .join("");

  container.querySelectorAll(".order-done-check").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const { error } = await supabase
        .from("orders")
        .update({ done: cb.checked })
        .eq("id", cb.dataset.id);
      if (error) {
        await showAlert(`Couldn't update order: ${error.message}`);
        cb.checked = !cb.checked;
        return;
      }
      await loadOrdersForActiveWarehouse(root, session);
    });
  });

  container.querySelectorAll(".pick-check").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const p = renderedProducts[Number(cb.dataset.idx)];
      if (!p) return;
      const { error } = cb.checked
        ? await supabase.from("pick_marks").upsert(
            {
              warehouse_id: activeWarehouseId,
              dispatch_date: p.dateKey,
              product_name: p.name,
              picked_qty: p.qty,
              picked_by: session.user.id,
              picked_at: new Date().toISOString(),
            },
            { onConflict: "warehouse_id,dispatch_date,product_name" }
          )
        : await supabase
            .from("pick_marks")
            .delete()
            .eq("warehouse_id", activeWarehouseId)
            .eq("dispatch_date", p.dateKey)
            .eq("product_name", p.name);
      if (error) {
        await showAlert(`Couldn't update product: ${error.message}`);
        cb.checked = !cb.checked;
        return;
      }
      await loadOrdersForActiveWarehouse(root, session);
    });
  });

  container.querySelectorAll(".mark-all").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const dateKey = btn.dataset.date;
      const ids = groups.get(dateKey).filter((o) => !o.exception_type).map((o) => o.id);
      if (!ids.length) return;
      const { error } = await supabase.from("orders").update({ done: true }).in("id", ids);
      if (error) {
        await showAlert(`Couldn't mark all complete: ${error.message}`);
        return;
      }
      await loadOrdersForActiveWarehouse(root, session);
    });
  });

  container.querySelectorAll(".delete-order").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!(await showConfirm("Delete this order? This can't be undone.", { confirmLabel: "Delete", danger: true }))) return;
      const { error } = await supabase.from("orders").delete().eq("id", btn.dataset.id);
      if (error) {
        await showAlert(`Couldn't delete order: ${error.message}`);
        return;
      }
      await loadOrdersForActiveWarehouse(root, session);
    });
  });

  container.querySelectorAll(".flag-incomplete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = orders.find((o) => o.id === btn.dataset.id);
      if (order) openExceptionDialog(order, root, session);
    });
  });

  container.querySelectorAll(".clear-exception").forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = orders.find((o) => o.id === btn.dataset.id);
      if (order) clearException(order, root, session);
    });
  });

  container.querySelectorAll(".export").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dateKey = btn.dataset.date;
      exportOrders(groups.get(dateKey), dateKey);
    });
  });
}

function renderOrdersBody(rows, canEdit) {
  const doneCount = rows.filter((r) => r.done).length;
  const flaggedCount = rows.filter((r) => r.exception_type).length;
  const html = rows
    .map((o) => {
      const flagLabel = getExceptionLabel(o);
      const movedFromLabel = getMovedFromLabel(o);
      const items = itemsSummary(o);
      return `
    <div class="order-row ${o.done ? "done" : ""} ${o.exception_type ? "exception" : ""}">
      <label class="order-check" aria-label="Mark order ${escapeHtml(o.order_id)} as ${o.done ? "not done" : "done"}">
        <input type="checkbox" class="order-done-check" data-id="${o.id}" ${o.done ? "checked" : ""} ${canEdit && !o.exception_type ? "" : "disabled"} />
      </label>
      <span class="order-id">${escapeHtml(o.order_id)}</span>
      ${items ? `<span class="order-items" title="${escapeAttr(items)}">${escapeHtml(items)}</span>` : ""}
      ${flagLabel ? `<span class="exception-badge">${escapeHtml(flagLabel)}</span>` : ""}
      ${movedFromLabel ? `<span class="moved-from">${escapeHtml(movedFromLabel)}</span>` : ""}
      <span class="time">${formatTime(o.created_at)}</span>
      ${canEdit && !o.exception_type ? `<button class="ghost icon-btn flag-incomplete" data-id="${o.id}" title="Mark incomplete" aria-label="Mark order ${escapeHtml(o.order_id)} as incomplete">${iconFlag}</button>` : ""}
      ${canEdit && o.exception_type ? `<button class="ghost icon-btn clear-exception" data-id="${o.id}" title="Clear flag" aria-label="Clear exception flag for order ${escapeHtml(o.order_id)}">${iconRotate}</button>` : ""}
      ${profile.role === "super_admin" ? `<button class="ghost icon-btn delete-order" data-id="${o.id}" title="Delete order" aria-label="Delete order ${escapeHtml(o.order_id)}">${iconX}</button>` : ""}
    </div>`;
    })
    .join("");
  const countLabel = `${plural(rows.length, "order")} · ${doneCount} done${flaggedCount ? ` · ${flaggedCount} flagged` : ""}`;
  return { html, countLabel };
}

// Pick list for one date card: every product across that day's orders,
// with total quantity. Cancelled / moved orders are left out, since their
// units aren't going out from this card.
function renderProductsBody(dateKey, rows, canEdit) {
  const { products, missing } = aggregateProducts(rows);
  let units = 0;
  let collected = 0;

  const html = products
    .map((p) => {
      const idx = renderedProducts.push({ dateKey, name: p.name, qty: p.qty }) - 1;
      const picked = pickMarks.get(pickKey(dateKey, p.name)) || 0;
      const done = picked >= p.qty;
      units += p.qty;
      if (done) collected += 1;
      const orderList = p.orders.map((o) => (o.qty > 1 ? `${o.orderId} ×${o.qty}` : o.orderId)).join(", ");
      return `
    <div class="order-row product-row ${done ? "done" : ""}">
      <label class="order-check" aria-label="Mark ${escapeAttr(p.name)} as ${done ? "not collected" : "collected"}">
        <input type="checkbox" class="pick-check" data-idx="${idx}" ${done ? "checked" : ""} ${canEdit ? "" : "disabled"} />
      </label>
      <div class="product-main">
        <span class="order-id">${escapeHtml(p.name)}</span>
        <span class="product-meta">
          ${picked > 0 && !done ? `<span class="pick-partial">${picked} of ${p.qty} collected</span>` : ""}
          <span class="product-orders">${escapeHtml(orderList)}</span>
        </span>
      </div>
      <span class="product-qty">× ${p.qty}</span>
    </div>`;
    })
    .join("");

  const missingNote = missing.length
    ? `<p class="pick-missing">No product details for ${escapeHtml(missing.join(", "))} (typed in manually, or captured before this update).</p>`
    : "";
  const emptyNote = !products.length && !missing.length ? `<p class="pick-missing">No orders to pick for this day.</p>` : "";
  const countLabel = `${plural(products.length, "product")} · ${plural(units, "unit")} · ${collected} collected`;
  return { html: html + missingNote + emptyNote, countLabel };
}

function aggregateProducts(rows) {
  const byName = new Map();
  const missing = [];
  for (const o of rows) {
    if (o.exception_type) continue;
    const items = o.details?.items;
    if (!items?.length) {
      missing.push(o.order_id);
      continue;
    }
    for (const it of items) {
      const qty = Number(it.qty) || 1;
      if (!byName.has(it.name)) byName.set(it.name, { name: it.name, qty: 0, orders: [] });
      const p = byName.get(it.name);
      p.qty += qty;
      const existing = p.orders.find((x) => x.orderId === o.order_id);
      if (existing) existing.qty += qty;
      else p.orders.push({ orderId: o.order_id, qty });
    }
  }
  const products = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { products, missing };
}

function itemsSummary(o) {
  const items = o.details?.items;
  if (!items?.length) return "";
  return items.map((it) => `${it.name} ×${Number(it.qty) || 1}`).join(", ");
}

function pickKey(dateKey, name) {
  return `${dateKey}|${name}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function getExceptionLabel(o) {
  if (o.exception_type === "rescheduled") {
    const target = orders.find((x) => x.id === o.rescheduled_to_id);
    return target ? `Moved to ${formatDateLabel(target.dispatch_date)}` : "Rescheduled";
  }
  if (o.exception_type === "cancelled") return "Cancelled";
  if (o.exception_type === "other") return o.exception_note || "Other";
  return null;
}

function getMovedFromLabel(o) {
  const source = orders.find((x) => x.rescheduled_to_id === o.id);
  return source ? `moved from ${formatDateLabel(source.dispatch_date)}` : null;
}

function openExceptionDialog(order, root, session) {
  const overlay = document.createElement("div");
  overlay.className = "exception-overlay";
  overlay.innerHTML = `
    <div class="exception-dialog">
      <h3>Mark ${escapeHtml(order.order_id)} as incomplete</h3>
      <label class="exception-option">
        <input type="radio" name="exception-reason" value="rescheduled" checked />
        Missed — dispatch next day
      </label>
      <label class="exception-option">
        <input type="radio" name="exception-reason" value="another-day" />
        Dispatch on another day
      </label>
      <input type="date" id="exception-date" style="display:none" />
      <label class="exception-option">
        <input type="radio" name="exception-reason" value="cancelled" />
        Cancelled
      </label>
      <label class="exception-option">
        <input type="radio" name="exception-reason" value="other" />
        Other
      </label>
      <textarea id="exception-note" placeholder="What happened?" style="display:none"></textarea>
      <div class="exception-actions">
        <button class="ghost" id="exception-cancel">Cancel</button>
        <button class="primary" id="exception-confirm">Confirm</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const noteBox = overlay.querySelector("#exception-note");
  const dateBox = overlay.querySelector("#exception-date");
  dateBox.min = todayDateKey();
  overlay.querySelectorAll('input[name="exception-reason"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const selected = overlay.querySelector('input[name="exception-reason"]:checked').value;
      noteBox.style.display = selected === "other" ? "block" : "none";
      dateBox.style.display = selected === "another-day" ? "block" : "none";
      if (selected === "another-day") dateBox.focus();
    });
  });

  overlay.querySelector("#exception-cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector("#exception-confirm").addEventListener("click", async () => {
    const selected = overlay.querySelector('input[name="exception-reason"]:checked').value;
    const note = noteBox.value.trim();
    if (selected === "other" && !note) {
      await showAlert('Add a quick note for "Other".');
      return;
    }
    if (selected === "another-day") {
      const target = dateBox.value;
      if (!target) {
        await showAlert("Pick the day it should be dispatched.");
        return;
      }
      if (target === order.dispatch_date) {
        await showAlert("That's the day it's already on. Pick a different day.");
        return;
      }
      overlay.remove();
      await applyException(order, "rescheduled", "", root, session, target);
      return;
    }
    overlay.remove();
    await applyException(order, selected, note, root, session);
  });
}

async function applyException(order, type, note, root, session, targetDate = null) {
  if (type === "rescheduled") {
    const nextDate = targetDate || addDays(order.dispatch_date, 1);
    const { data: newOrder, error: insertError } = await supabase
      .from("orders")
      .insert({
        order_id: order.order_id,
        warehouse_id: order.warehouse_id,
        dispatch_date: nextDate,
        created_by: session.user.id,
        details: order.details ?? null,
      })
      .select()
      .single();
    if (insertError) {
      await showAlert(`Couldn't reschedule: ${insertError.message}`);
      return;
    }
    const { error: updateError } = await supabase
      .from("orders")
      .update({ exception_type: "rescheduled", rescheduled_to_id: newOrder.id })
      .eq("id", order.id);
    if (updateError) {
      await showAlert(`Couldn't flag original order: ${updateError.message}`);
      return;
    }
  } else {
    const { error } = await supabase
      .from("orders")
      .update({ exception_type: type, exception_note: type === "other" ? note : null })
      .eq("id", order.id);
    if (error) {
      await showAlert(`Couldn't update order: ${error.message}`);
      return;
    }
  }
  await loadOrdersForActiveWarehouse(root, session);
}

async function clearException(order, root, session) {
  if (!(await showConfirm("Clear this flag and restore the order to normal?", { confirmLabel: "Clear" }))) return;
  const { error } = await supabase
    .from("orders")
    .update({ exception_type: null, exception_note: null, rescheduled_to_id: null })
    .eq("id", order.id);
  if (error) {
    await showAlert(`Couldn't clear flag: ${error.message}`);
    return;
  }
  await loadOrdersForActiveWarehouse(root, session);
}

function exportOrders(rows, dateKey) {
  const text = rows.map(exportLine).join("\n");
  const warehouseName = warehouses.find((w) => w.id === activeWarehouseId)?.name || "warehouse";
  const filename = `${warehouseName}_${dateKey}.txt`;

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

// "WOO-42632 - VXE R1S Tri-Mode Gaming Mouse - White x 1, FANTECH MP256 Gaming Mousepad x 2".
// Orders without product details export as just the ID.
function exportLine(o) {
  const items = o.details?.items;
  if (!items?.length) return o.order_id;
  return `${o.order_id} - ${items.map((it) => `${it.name} x ${Number(it.qty) || 1}`).join(", ")}`;
}

function subscribeRealtime(root, session) {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase
    .channel("orders-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => {
      if (activeView === "warehouse") loadOrdersForActiveWarehouse(root, session);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "pick_marks" }, () => {
      if (activeView === "warehouse") loadOrdersForActiveWarehouse(root, session);
    })
    .subscribe();
}

function todayDateKey() {
  return dateKeyFromDate(new Date());
}

function addDays(dateKey, days) {
  const d = new Date(dateKey + "T00:00:00");
  d.setDate(d.getDate() + days);
  return dateKeyFromDate(d);
}

function dateKeyFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateLabel(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function readListMode() {
  try {
    return localStorage.getItem(LIST_MODE_KEY) === "products" ? "products" : "orders";
  } catch {
    return "orders";
  }
}

function saveListMode(mode) {
  try {
    localStorage.setItem(LIST_MODE_KEY, mode);
  } catch {
    // Private window or blocked storage: the toggle still works, it just isn't remembered.
  }
}

// escapeHtml leaves quotes alone, which is fine for text but not inside
// an attribute value.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
