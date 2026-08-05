import Papa from "papaparse";
import { supabase } from "./supabaseClient.js";
import { iconX, iconChevronDown, iconPencil, iconDownload } from "./icons.js";
import { showAlert, showConfirm, showEditBatch } from "./dialogs.js";

let products = [];
let batches = [];
let orders = [];
let statusFilter = "active";
let searchQuery = "";
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
      .select("id, name, sku, brand")
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
        <input type="text" id="new-product-brand" placeholder="Brand (optional)" />
        <input type="text" id="new-product-sku" placeholder="SKU (optional)" />
        <button class="primary" id="add-product-btn">Add product</button>
      </div>
      <p id="product-status" style="font-size:13px;margin:8px 0 0" aria-live="polite"></p>
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
        <p id="create-batch-status" style="font-size:13px" aria-live="polite"></p>
      </div>
    </div>

    <div class="tabs" id="status-tabs" role="tablist">
      <div class="tab ${statusFilter === "active" ? "active" : ""}" data-status="active" role="tab" tabindex="0" aria-selected="${statusFilter === "active"}">Active</div>
      <div class="tab ${statusFilter === "arrived" ? "active" : ""}" data-status="arrived" role="tab" tabindex="0" aria-selected="${statusFilter === "arrived"}">Arrived</div>
      <div class="tab ${statusFilter === "closed" ? "active" : ""}" data-status="closed" role="tab" tabindex="0" aria-selected="${statusFilter === "closed"}">Closed</div>
    </div>

    <div class="prebook-search">
      <input type="text" id="prebook-search" placeholder="Search by product, brand, or SKU…" autocomplete="off" value="${escapeHtml(searchQuery)}" />
    </div>

    <div id="batch-list">${renderBatchListHtml(profile)}</div>
  `;

  wireEvents(body, session, profile);
}

// Product lookups keyed once per render pass instead of re-scanning the
// products array for every batch — matters once the catalog is thousands
// of rows deep (see fetchAllProducts' pagination comment).
function productFor(batch) {
  return products.find((p) => p.id === batch.product_id);
}

// Product names follow a "Base Name - Variant - Variant" convention
// (color, switch type, etc.) — everything after the first " - " is a
// variation attribute, so each dash-separated chunk gets its own badge
// instead of running on as part of the plain title.
function formatProductName(name) {
  const parts = name.split(" - ").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return escapeHtml(name);
  const [base, ...variants] = parts;
  const tags = variants.map((v) => `<span class="variant-tag">${escapeHtml(v)}</span>`).join(" ");
  return `${escapeHtml(base)} ${tags}`;
}

function getBrand(product) {
  const brand = (product?.brand || "").trim();
  if (brand) return brand;
  const name = (product?.name || "").trim();
  return name ? name.split(/\s+/)[0] : "Other";
}

function getVisibleBatches() {
  const q = searchQuery.trim().toLowerCase();
  return batches.filter((b) => {
    if (b.status !== statusFilter) return false;
    if (!q) return true;
    const product = productFor(b);
    const name = (product?.name || "").toLowerCase();
    const sku = (product?.sku || "").toLowerCase();
    const brand = getBrand(product).toLowerCase();
    return name.includes(q) || sku.includes(q) || brand.includes(q);
  });
}

// Same-brand pre-books tend to ship and land the same day, so grouping by
// brand does most of the work a date view would — sorted alphabetically,
// with each group's batches ordered by expected date (undated last).
function groupBatchesByBrand(visibleBatches) {
  const groups = new Map();
  for (const b of visibleBatches) {
    const brand = getBrand(productFor(b));
    const key = brand.toLowerCase();
    if (!groups.has(key)) groups.set(key, { label: brand, items: [] });
    groups.get(key).items.push(b);
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => {
      if (a.expected_date !== b.expected_date) {
        if (!a.expected_date) return 1;
        if (!b.expected_date) return -1;
        return a.expected_date < b.expected_date ? -1 : 1;
      }
      return (productFor(a)?.name || "").localeCompare(productFor(b)?.name || "");
    });
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function renderBatchListHtml(profile) {
  const visibleBatches = getVisibleBatches();
  if (!visibleBatches.length) {
    const message = searchQuery.trim()
      ? `No ${statusFilter} pre-books match "${escapeHtml(searchQuery.trim())}".`
      : `No ${statusFilter} pre-books.`;
    return `<p class="empty-note">${message}</p>`;
  }

  return groupBatchesByBrand(visibleBatches)
    .map(
      (group) => `
    <div class="date-group brand-group">
      <div class="date-group-head">
        <div class="title">
          <h3>${escapeHtml(group.label)}</h3>
          <span class="count">${group.items.length} pre-book${group.items.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div class="order-list">
        ${group.items.map((b) => renderBatchRow(b, profile)).join("")}
      </div>
    </div>`
    )
    .join("");
}

// Re-renders just the batch list (not the whole page) so the search input
// above it never loses focus mid-keystroke.
function refreshBatchList(body, session, profile) {
  body.querySelector("#batch-list").innerHTML = renderBatchListHtml(profile);
  wireBatchListEvents(body, session, profile);
}

// One compact row per pre-book (mirrors the dispatch view's order rows),
// grouped under its brand's date-group card instead of each batch getting
// its own boxed card — that per-card chrome repeated for every product was
// the "eye sore" being fixed here. Expanding claimed orders renders a panel
// as a sibling block right after the row, still inside the brand card.
function renderBatchRow(b, profile) {
  const product = productFor(b);
  const batchOrders = orders.filter((o) => o.batch_id === b.id);
  const claimed = batchOrders.length;
  const available = b.stock_quantity - claimed;
  const expanded = expandedBatchId === b.id;
  const canDelete = profile.role === "super_admin";
  const productName = escapeHtml(product?.name || "(deleted product)");

  const row = `
    <div class="order-row batch-row" data-batch-id="${b.id}">
      <span class="order-id">${formatProductName(product?.name || "(deleted product)")}</span>
      ${product?.sku ? `<span class="moved-from">${escapeHtml(product.sku)}</span>` : ""}
      <span class="expected">${b.expected_date ? formatDateLabel(b.expected_date) : "No date set"}</span>
      <span class="stock-summary">Stock ${b.stock_quantity} · Claimed ${claimed} · Available ${available}</span>
      <select class="batch-status" data-id="${b.id}">
        <option value="active" ${b.status === "active" ? "selected" : ""}>Active</option>
        <option value="arrived" ${b.status === "arrived" ? "selected" : ""}>Arrived</option>
        <option value="closed" ${b.status === "closed" ? "selected" : ""}>Closed</option>
      </select>
      <button class="ghost icon-btn toggle-expand ${expanded ? "expanded" : ""}" data-id="${b.id}" title="${expanded ? "Hide" : "Show"} claimed orders" aria-label="${expanded ? "Hide" : "Show"} claimed orders for ${productName} (${claimed})">${iconChevronDown}</button>
      <button class="ghost icon-btn edit-batch" data-id="${b.id}" title="Edit stock & date" aria-label="Edit stock and expected date for ${productName}">${iconPencil}</button>
      <button class="ghost icon-btn export-batch" data-id="${b.id}" title="Export claimed orders" aria-label="Export claimed orders for ${productName}">${iconDownload}</button>
      ${canDelete ? `<button class="ghost icon-btn delete-batch" data-id="${b.id}" title="Delete pre-book" aria-label="Delete pre-book for ${productName}">${iconX}</button>` : ""}
    </div>`;

  if (!expanded) return row;

  const expandPanel = `
    <div class="batch-expand" data-batch-id="${b.id}">
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
            <span class="time">${formatDateTime(o.created_at)}</span>
            <button class="ghost icon-btn remove-claim" data-id="${o.id}" title="Remove claim" aria-label="Remove claim for order ${escapeHtml(o.order_id)}">${iconX}</button>
          </div>`
                )
                .join("")
            : `<p class="empty-note">No orders claimed yet.</p>`
        }
      </div>
    </div>`;

  return row + expandPanel;
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
    const brand = body.querySelector("#new-product-brand").value.trim();
    const sku = body.querySelector("#new-product-sku").value.trim();
    const status = body.querySelector("#product-status");
    if (!name) return;

    const { error } = await supabase.from("products").insert({ name, brand: brand || null, sku: sku || null });
    if (error) {
      status.textContent = error.message.includes("duplicate") ? "That product already exists." : error.message;
      status.style.color = "var(--danger)";
      return;
    }
    status.textContent = `Added "${name}".`;
    status.style.color = "var(--success)";
    body.querySelector("#new-product-name").value = "";
    body.querySelector("#new-product-brand").value = "";
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
      .map((p) => `<div class="product-suggestion" data-id="${p.id}">${formatProductName(p.name)}${p.sku ? ` <span class="moved-from">${escapeHtml(p.sku)}</span>` : ""}</div>`)
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
    tab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        tab.click();
      }
    });
  });

  // --- Live product/brand/SKU search ---
  // Only refreshes #batch-list (not a full render) so this input never
  // loses focus mid-keystroke.
  body.querySelector("#prebook-search").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    refreshBatchList(body, session, profile);
  });

  wireBatchListEvents(body, session, profile);
}

function wireBatchListEvents(body, session, profile) {
  body.querySelectorAll(".batch-status").forEach((select) => {
    select.addEventListener("change", async () => {
      const { error } = await supabase.from("prebook_batches").update({ status: select.value }).eq("id", select.dataset.id);
      if (error) {
        await showAlert(`Couldn't update status: ${error.message}`);
        return;
      }
      await loadData();
      refreshBatchList(body, session, profile);
    });
  });

  body.querySelectorAll(".edit-batch").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = batches.find((x) => x.id === btn.dataset.id);
      const result = await showEditBatch({ stock: b?.stock_quantity ?? 0, date: b?.expected_date || "" });
      if (!result) return;
      const qty = parseInt(result.stock, 10);
      if (isNaN(qty) || qty < 0) {
        await showAlert("Enter a valid stock quantity.");
        return;
      }
      const { error } = await supabase
        .from("prebook_batches")
        .update({ stock_quantity: qty, expected_date: result.date || null })
        .eq("id", btn.dataset.id);
      if (error) {
        await showAlert(`Couldn't update pre-book: ${error.message}`);
        return;
      }
      await loadData();
      refreshBatchList(body, session, profile);
    });
  });

  body.querySelectorAll(".export-batch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const b = batches.find((x) => x.id === btn.dataset.id);
      const product = productFor(b);
      const batchOrders = orders.filter((o) => o.batch_id === b.id);
      exportBatchOrders(product?.name || "product", batchOrders);
    });
  });

  body.querySelectorAll(".delete-batch").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!(await showConfirm("Delete this pre-book and all its order claims? This can't be undone.", { confirmLabel: "Delete", danger: true }))) return;
      const { error } = await supabase.from("prebook_batches").delete().eq("id", btn.dataset.id);
      if (error) {
        await showAlert(`Couldn't delete: ${error.message}`);
        return;
      }
      await loadData();
      refreshBatchList(body, session, profile);
    });
  });

  body.querySelectorAll(".toggle-expand").forEach((btn) => {
    btn.addEventListener("click", () => {
      expandedBatchId = expandedBatchId === btn.dataset.id ? null : btn.dataset.id;
      refreshBatchList(body, session, profile);
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
        if (!(await showConfirm(`This pre-book is already fully claimed (${claimed}/${b.stock_quantity}). Add anyway?`, { confirmLabel: "Add anyway" }))) return;
      }

      const { error } = await supabase.from("prebook_orders").insert({
        batch_id: batchId,
        order_id: orderId,
        created_by: session.user.id,
      });
      if (error) {
        await showAlert(`Couldn't add order: ${error.message}`);
        return;
      }
      await loadData();
      refreshBatchList(body, session, profile);
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
      if (!(await showConfirm("Remove this order claim?", { confirmLabel: "Remove", danger: true }))) return;
      const { error } = await supabase.from("prebook_orders").delete().eq("id", btn.dataset.id);
      if (error) {
        await showAlert(`Couldn't remove: ${error.message}`);
        return;
      }
      await loadData();
      refreshBatchList(body, session, profile);
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
        <select id="map-brand-col">
          <option value="">(no brand column — parsed from name)</option>
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
    const brandCol = mapping.querySelector("#map-brand-col").value;
    const skuCol = mapping.querySelector("#map-sku-col").value;
    const status = body.querySelector("#product-status");

    const rows = csvParsedRows
      .map((r) => {
        const row = { name: (r[nameCol] || "").trim(), sku: skuCol ? (r[skuCol] || "").trim() || null : null };
        // Only include `brand` when a column is actually mapped — upsert sets
        // whatever keys are present, so omitting it (vs. sending null) avoids
        // wiping out brand on existing rows during a re-import that doesn't
        // map a brand column.
        if (brandCol) row.brand = (r[brandCol] || "").trim() || null;
        return row;
      })
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

// Claimed orders aren't grouped by date (batches are grouped by brand
// instead), so unlike the dispatch view's order rows, each claim needs its
// own date alongside the time — otherwise every claim on a batch looks
// like it landed the same day it was viewed.
function formatDateTime(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
