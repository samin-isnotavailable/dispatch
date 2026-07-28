import Papa from "papaparse";
import { supabase } from "./supabaseClient.js";

let products = [];
let batches = [];
let orders = [];
let statusFilter = "active";
let expandedBatchId = null;
let selectedProductId = null;
let csvParsedRows = null;
let csvFields = [];

let outsideClickBound = false;

export async function renderPrebook(body, session, profile) {
  await loadData();
  render(body, session, profile);

  if (!outsideClickBound) {
    outsideClickBound = true;
    document.addEventListener("click", (e) => {
      const suggestionsEl = document.getElementById("product-suggestions");
      if (!suggestionsEl) return;
      if (!e.target.closest(".product-combobox")) {
        suggestionsEl.style.display = "none";
      }
    });
  }
}

async function loadData() {
  const [batchesRes, ordersRes] = await Promise.all([
    supabase.from("prebook_batches").select("id, product_id, expected_date, stock_quantity, status, created_at"),
    supabase.from("prebook_orders").select("id, batch_id, order_id, created_at"),
  ]);
  products = await fetchAllProducts();
  batches = batchesRes.data || [];
  orders = ordersRes.data || [];
}

// Supabase caps a single .select() at 1,000 rows by default. Order/batch
// volume here is tiny, but a real WooCommerce catalog can easily exceed
// that — so fetch products in pages until we've got everything, instead
// of silently truncating past the first 1,000.
async function fetchAllProducts() {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, sku")
      .order("name")
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("Couldn't load products:", error.message);
      break;
    }
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

function render(body, session, profile) {
  const visibleBatches = batches
    .filter((b) => b.status === statusFilter)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  body.innerHTML = `
    <div class="date-group">
      <div class="date-group-head">
        <div class="title"><h3>Products</h3></div>
        <div class="actions">
          <button id="import-csv-btn">Import CSV</button>
          <input type="file" id="csv-file-input" accept=".csv" style="display:none" />
        </div>
      </div>
      <div id="csv-mapping"></div>
      <div class="manual-add">
        <input type="text" id="new-product-name" placeholder="Product name" />
        <input type="text" id="new-product-sku" placeholder="SKU (optional)" />
        <button class="primary" id="add-product-btn">Add product</button>
      </div>
      <p id="product-status" style="font-size:13px;margin:8px 0 0"></p>
    </div>

    <div class="date-group">
      <div class="date-group-head"><div class="title"><h3>Start a pre-book</h3></div></div>
      <div class="prebook-create">
        <div class="product-combobox">
          <input type="text" id="product-search" placeholder="Search product…" autocomplete="off" />
          <div class="product-suggestions" id="product-suggestions"></div>
        </div>
        <input type="date" id="new-expected-date" />
        <input type="number" id="new-stock-qty" placeholder="Stock quantity" min="0" />
        <button class="primary" id="create-batch-btn">Create pre-book (Badda)</button>
        <p id="create-batch-status" style="font-size:13px"></p>
      </div>
    </div>

    <div class="tabs" id="status-tabs">
      <div class="tab ${statusFilter === "active" ? "active" : ""}" data-status="active">Active</div>
      <div class="tab ${statusFilter === "arrived" ? "active" : ""}" data-status="arrived">Arrived</div>
      <div class="tab ${statusFilter === "closed" ? "active" : ""}" data-status="closed">Closed</div>
    </div>

    <div id="batch-list">
      ${visibleBatches.length ? visibleBatches.map((b) => renderBatchCard(b, profile)).join("") : `<p class="empty-note">No ${statusFilter} pre-books.</p>`}
    </div>
  `;

  wireEvents(body, session, profile);
}

function renderBatchCard(b, profile) {
  const product = products.find((p) => p.id === b.product_id);
  const batchOrders = orders.filter((o) => o.batch_id === b.id);
  const claimed = batchOrders.length;
  const available = b.stock_quantity - claimed;
  const expanded = expandedBatchId === b.id;
  const canDelete = profile.role === "super_admin";

  return `
    <div class="date-group batch-card" data-batch-id="${b.id}">
      <div class="date-group-head">
        <div class="title">
          <h3>${escapeHtml(product?.name || "(deleted product)")}${product?.sku ? ` <span class="moved-from">${escapeHtml(product.sku)}</span>` : ""}</h3>
          <span class="count">${b.expected_date ? `Expected ${formatDateLabel(b.expected_date)} · ` : ""}Stock ${b.stock_quantity} · Claimed ${claimed} · Available ${available}</span>
        </div>
        <div class="actions">
          <select class="batch-status" data-id="${b.id}">
            <option value="active" ${b.status === "active" ? "selected" : ""}>Active</option>
            <option value="arrived" ${b.status === "arrived" ? "selected" : ""}>Arrived</option>
            <option value="closed" ${b.status === "closed" ? "selected" : ""}>Closed</option>
          </select>
          <button class="edit-stock" data-id="${b.id}">Edit stock</button>
          <button class="edit-date" data-id="${b.id}">Edit date</button>
          <button class="export-batch" data-id="${b.id}">Export</button>
          ${canDelete ? `<button class="ghost delete-batch" data-id="${b.id}" title="Delete pre-book">✕</button>` : ""}
        </div>
      </div>
      <button class="ghost toggle-expand" data-id="${b.id}" style="margin-bottom:10px">${expanded ? "Hide" : "Show"} orders (${claimed})</button>
      ${
        expanded
          ? `
      <div class="manual-add">
        <input type="text" class="new-order-id" data-batch="${b.id}" placeholder="Order ID, e.g. WOO-3423" />
        <button class="primary add-claim-btn" data-batch="${b.id}">Add order</button>
      </div>
      <div class="order-list">
        ${
          batchOrders.length
            ? batchOrders
                .map(
                  (o) => `
          <div class="order-row">
            <span class="order-id">${escapeHtml(o.order_id)}</span>
            <span class="time">${formatTime(o.created_at)}</span>
            <button class="ghost remove-claim" data-id="${o.id}" title="Remove claim">✕</button>
          </div>`
                )
                .join("")
            : `<p class="empty-note">No orders claimed yet.</p>`
        }
      </div>`
          : ""
      }
    </div>`;
}

function wireEvents(body, session, profile) {
  // --- Product import (CSV) ---
  const fileInput = body.querySelector("#csv-file-input");
  body.querySelector("#import-csv-btn").addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        csvParsedRows = results.data;
        csvFields = results.meta.fields || [];
        renderCsvMapping(body, session, profile);
      },
    });
  });

  // --- Manual add product ---
  body.querySelector("#add-product-btn").addEventListener("click", async () => {
    const name = body.querySelector("#new-product-name").value.trim();
    const sku = body.querySelector("#new-product-sku").value.trim();
    const status = body.querySelector("#product-status");
    if (!name) return;

    const { error } = await supabase.from("products").insert({ name, sku: sku || null });
    if (error) {
      status.textContent = error.message.includes("duplicate") ? "That product already exists." : error.message;
      status.style.color = "var(--danger)";
      return;
    }
    status.textContent = `Added "${name}".`;
    status.style.color = "var(--success)";
    body.querySelector("#new-product-name").value = "";
    body.querySelector("#new-product-sku").value = "";
    await loadData();
    render(body, session, profile);
  });

  // --- Product search combobox ---
  const searchInput = body.querySelector("#product-search");
  const suggestionsEl = body.querySelector("#product-suggestions");
  searchInput.addEventListener("input", () => {
    selectedProductId = null;
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      suggestionsEl.innerHTML = "";
      suggestionsEl.style.display = "none";
      return;
    }
    const matches = products.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
    suggestionsEl.innerHTML = matches
      .map((p) => `<div class="product-suggestion" data-id="${p.id}">${escapeHtml(p.name)}${p.sku ? ` <span class="moved-from">${escapeHtml(p.sku)}</span>` : ""}</div>`)
      .join("");
    suggestionsEl.style.display = matches.length ? "block" : "none";
    suggestionsEl.querySelectorAll(".product-suggestion").forEach((el) => {
      el.addEventListener("click", () => {
        selectedProductId = el.dataset.id;
        searchInput.value = products.find((p) => p.id === selectedProductId)?.name || "";
        suggestionsEl.innerHTML = "";
        suggestionsEl.style.display = "none";
      });
    });
  });

  // --- Create pre-book batch ---
  body.querySelector("#create-batch-btn").addEventListener("click", async () => {
    const status = body.querySelector("#create-batch-status");
    const expectedDate = body.querySelector("#new-expected-date").value || null;
    const stockQty = parseInt(body.querySelector("#new-stock-qty").value, 10);

    if (!selectedProductId) {
      status.textContent = "Pick a product from the search results first.";
      status.style.color = "var(--danger)";
      return;
    }
    if (isNaN(stockQty) || stockQty < 0) {
      status.textContent = "Enter a valid stock quantity.";
      status.style.color = "var(--danger)";
      return;
    }

    const { error } = await supabase.from("prebook_batches").insert({
      product_id: selectedProductId,
      expected_date: expectedDate,
      stock_quantity: stockQty,
      created_by: session.user.id,
    });
    if (error) {
      status.textContent = error.message;
      status.style.color = "var(--danger)";
      return;
    }

    selectedProductId = null;
    await loadData();
    render(body, session, profile);
  });

  // --- Status filter tabs ---
  body.querySelectorAll("#status-tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      statusFilter = tab.dataset.status;
      expandedBatchId = null;
      render(body, session, profile);
    });
  });

  // --- Batch card actions ---
  body.querySelectorAll(".batch-status").forEach((select) => {
    select.addEventListener("change", async () => {
      const { error } = await supabase.from("prebook_batches").update({ status: select.value }).eq("id", select.dataset.id);
      if (error) {
        alert(`Couldn't update status: ${error.message}`);
        return;
      }
      await loadData();
      render(body, session, profile);
    });
  });

  body.querySelectorAll(".edit-stock").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = batches.find((x) => x.id === btn.dataset.id);
      const next = prompt("New stock quantity:", b?.stock_quantity ?? 0);
      if (next === null) return;
      const qty = parseInt(next, 10);
      if (isNaN(qty) || qty < 0) return;
      const { error } = await supabase.from("prebook_batches").update({ stock_quantity: qty }).eq("id", btn.dataset.id);
      if (error) {
        alert(`Couldn't update stock: ${error.message}`);
        return;
      }
      await loadData();
      render(body, session, profile);
    });
  });

  body.querySelectorAll(".edit-date").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = batches.find((x) => x.id === btn.dataset.id);
      const next = prompt("New expected delivery date (YYYY-MM-DD):", b?.expected_date || "");
      if (next === null) return;
      const { error } = await supabase.from("prebook_batches").update({ expected_date: next || null }).eq("id", btn.dataset.id);
      if (error) {
        alert(`Couldn't update date: ${error.message}`);
        return;
      }
      await loadData();
      render(body, session, profile);
    });
  });

  body.querySelectorAll(".export-batch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const b = batches.find((x) => x.id === btn.dataset.id);
      const product = products.find((p) => p.id === b.product_id);
      const batchOrders = orders.filter((o) => o.batch_id === b.id);
      exportBatchOrders(product?.name || "product", batchOrders);
    });
  });

  body.querySelectorAll(".delete-batch").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this pre-book and all its order claims? This can't be undone.")) return;
      const { error } = await supabase.from("prebook_batches").delete().eq("id", btn.dataset.id);
      if (error) {
        alert(`Couldn't delete: ${error.message}`);
        return;
      }
      await loadData();
      render(body, session, profile);
    });
  });

  body.querySelectorAll(".toggle-expand").forEach((btn) => {
    btn.addEventListener("click", () => {
      expandedBatchId = expandedBatchId === btn.dataset.id ? null : btn.dataset.id;
      render(body, session, profile);
    });
  });

  body.querySelectorAll(".add-claim-btn").forEach((btn) => {
    const batchId = btn.dataset.batch;
    const input = body.querySelector(`.new-order-id[data-batch="${batchId}"]`);

    const submit = async () => {
      const orderId = input.value.trim();
      if (!orderId) return;

      const b = batches.find((x) => x.id === batchId);
      const claimed = orders.filter((o) => o.batch_id === batchId).length;
      if (claimed >= b.stock_quantity) {
        if (!confirm(`This pre-book is already fully claimed (${claimed}/${b.stock_quantity}). Add anyway?`)) return;
      }

      const { error } = await supabase.from("prebook_orders").insert({
        batch_id: batchId,
        order_id: orderId,
        created_by: session.user.id,
      });
      if (error) {
        alert(`Couldn't add order: ${error.message}`);
        return;
      }
      await loadData();
      render(body, session, profile);
    };

    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  });

  body.querySelectorAll(".remove-claim").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this order claim?")) return;
      const { error } = await supabase.from("prebook_orders").delete().eq("id", btn.dataset.id);
      if (error) {
        alert(`Couldn't remove: ${error.message}`);
        return;
      }
      await loadData();
      render(body, session, profile);
    });
  });
}

function renderCsvMapping(body, session, profile) {
  const mapping = body.querySelector("#csv-mapping");
  mapping.innerHTML = `
    <div class="csv-mapping-box">
      <p style="font-size:13px;margin:0 0 8px">Found ${csvParsedRows.length} rows. Which column is which?</p>
      <div class="manual-add">
        <select id="map-name-col">
          ${csvFields.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("")}
        </select>
        <select id="map-sku-col">
          <option value="">(no SKU column)</option>
          ${csvFields.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("")}
        </select>
        <button class="primary" id="confirm-import-btn">Import ${csvParsedRows.length} products</button>
      </div>
    </div>
  `;

  mapping.querySelector("#confirm-import-btn").addEventListener("click", async () => {
    const nameCol = mapping.querySelector("#map-name-col").value;
    const skuCol = mapping.querySelector("#map-sku-col").value;
    const status = body.querySelector("#product-status");

    const rows = csvParsedRows
      .map((r) => ({ name: (r[nameCol] || "").trim(), sku: skuCol ? (r[skuCol] || "").trim() || null : null }))
      .filter((r) => r.name);

    if (!rows.length) {
      status.textContent = "No valid rows found.";
      status.style.color = "var(--danger)";
      return;
    }

    status.textContent = `Importing ${rows.length} products…`;
    status.style.color = "var(--ink-muted)";

    const chunkSize = 500;
    let imported = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await supabase.from("products").upsert(chunk, { onConflict: "name" });
      if (error) {
        status.textContent = `Import failed partway (${imported} done): ${error.message}`;
        status.style.color = "var(--danger)";
        return;
      }
      imported += chunk.length;
    }

    status.textContent = `Imported ${imported} products.`;
    status.style.color = "var(--success)";
    csvParsedRows = null;
    csvFields = [];
    await loadData();
    render(body, session, profile);
  });
}

function exportBatchOrders(productName, batchOrders) {
  const text = batchOrders.map((o) => o.order_id).join("\n");
  const filename = `${productName.replace(/\s+/g, "-")}_prebook.txt`;
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

function formatDateLabel(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
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
