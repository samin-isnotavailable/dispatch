// Statistics tab (super_admin only). Fetches one dataset for the chosen
// range from stats_dataset (supabase/migrations/0006_statistics.sql),
// runs it through computeStats, and draws plain HTML charts — no chart
// library. Every chart has a table view, and every value shown on hover
// is also in that table.

import { supabase } from "./supabaseClient.js";
import { computeStats, filterOptions, WEEKDAYS, addDaysKey, daysBetween, DISTRICTS } from "./statsCompute.js";

const STATE_KEY = "dispatchez.statsFilters";
const MAX_RANGE_DAYS = 366;
const PRESETS = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "month", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "90d", label: "Last 90 days" },
  { id: "custom", label: "Custom range" },
];

// Categorical slots, validated against the card surface (#152238) for
// colour-blind separation and contrast. Warehouses take them in a fixed
// order so a warehouse keeps its colour whatever the filter.
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const OTHER_COLOR = "#5b6b85";
// Sequential blue for the heatmap: more orders = brighter on the dark surface.
const HEAT = ["#1c2e4a", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"];

let state = loadState();
let warehouses = [];
let tips = [];
let requestSeq = 0;
let lastDataset = null;
let lastStats = null;
// CSV exports for the cards currently on screen, by index.
let exportsReg = [];
let scrollBound = false;

export async function renderStats(body, { warehouses: whs }) {
  warehouses = whs || [];
  body.innerHTML = `
    <div class="stats-filters" role="group" aria-label="Statistics filters">
      <label class="stats-field">
        <span>Period</span>
        <select id="stats-preset">${PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("")}</select>
      </label>
      <label class="stats-field stats-custom">
        <span>From</span>
        <input type="date" id="stats-from" />
      </label>
      <label class="stats-field stats-custom">
        <span>To</span>
        <input type="date" id="stats-to" />
      </label>
      <label class="stats-field">
        <span>Warehouse</span>
        <select id="stats-warehouse">
          <option value="">All warehouses</option>
          ${warehouses.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join("")}
        </select>
      </label>
      <label class="stats-field stats-product">
        <span>Product</span>
        <input type="text" id="stats-product" list="stats-product-list" placeholder="Any product, or part of a name" autocomplete="off" />
        <datalist id="stats-product-list"></datalist>
      </label>
      <label class="stats-field">
        <span>Sold by</span>
        <select id="stats-soldby"></select>
      </label>
      <label class="stats-field">
        <span>District</span>
        <select id="stats-district"></select>
      </label>
      <div class="stats-field">
        <span>Group by</span>
        <div class="view-toggle stats-gran" role="group" aria-label="Group charts by">
          <button type="button" data-gran="day">Day</button>
          <button type="button" data-gran="week">Week</button>
          <button type="button" data-gran="month">Month</button>
        </div>
      </div>
      <div class="stats-actions">
        <button type="button" class="ghost" id="stats-clear" style="display:none">Clear filters</button>
        <button type="button" id="stats-export-orders">Export orders</button>
      </div>
    </div>
    <p class="stats-range-label" id="stats-range-label"></p>
    <div id="stats-content"><p class="empty-note">Loading statistics…</p></div>
  `;

  const presetEl = body.querySelector("#stats-preset");
  const fromEl = body.querySelector("#stats-from");
  const toEl = body.querySelector("#stats-to");
  const whEl = body.querySelector("#stats-warehouse");
  const content = body.querySelector("#stats-content");

  presetEl.value = state.preset;
  whEl.value = warehouses.some((w) => w.id === state.warehouse) ? state.warehouse : "";
  if (state.preset === "custom") {
    fromEl.value = state.from;
    toEl.value = state.to;
  }

  const sync = () => {
    body.querySelectorAll(".stats-custom").forEach((el) => (el.style.display = state.preset === "custom" ? "" : "none"));
    body.querySelectorAll(".stats-gran button").forEach((b) => {
      const on = b.dataset.gran === state.granularity;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  };
  sync();

  presetEl.addEventListener("change", () => {
    state.preset = presetEl.value;
    if (state.preset === "custom") {
      const r = rangeFor(state);
      fromEl.value = fromEl.value || r.from;
      toEl.value = toEl.value || r.to;
      state.from = fromEl.value;
      state.to = toEl.value;
    }
    state.granularity = defaultGranularity(rangeFor(state));
    sync();
    saveState();
    load(body);
  });
  const onCustom = () => {
    if (!fromEl.value || !toEl.value) return;
    state.from = fromEl.value <= toEl.value ? fromEl.value : toEl.value;
    state.to = fromEl.value <= toEl.value ? toEl.value : fromEl.value;
    saveState();
    load(body);
  };
  fromEl.addEventListener("change", onCustom);
  toEl.addEventListener("change", onCustom);
  whEl.addEventListener("change", () => {
    state.warehouse = whEl.value;
    saveState();
    load(body);
  });
  body.querySelectorAll(".stats-gran button").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.granularity === b.dataset.gran) return;
      state.granularity = b.dataset.gran;
      sync();
      saveState();
      load(body);
    })
  );

  // Product / sold by / district filter the already-fetched range, so
  // they redraw instantly without asking the database again.
  const productEl = body.querySelector("#stats-product");
  productEl.value = state.product;
  let productTimer = null;
  productEl.addEventListener("input", () => {
    clearTimeout(productTimer);
    productTimer = setTimeout(() => {
      state.product = productEl.value.trim();
      saveState();
      redraw(body);
    }, 250);
  });
  body.querySelector("#stats-soldby").addEventListener("change", (e) => {
    state.soldBy = e.target.value;
    saveState();
    redraw(body);
  });
  body.querySelector("#stats-district").addEventListener("change", (e) => {
    state.district = e.target.value;
    saveState();
    redraw(body);
  });
  body.querySelector("#stats-clear").addEventListener("click", () => {
    state.product = "";
    state.soldBy = "";
    state.district = "";
    productEl.value = "";
    saveState();
    redraw(body);
  });
  body.querySelector("#stats-export-orders").addEventListener("click", () => {
    if (lastStats) exportOrders(lastStats);
  });

  // One delegated handler for every card's Chart / Table switch.
  content.addEventListener("click", (e) => {
    const csvBtn = e.target.closest("[data-csv]");
    if (csvBtn) {
      const x = exportsReg[Number(csvBtn.dataset.csv)];
      if (x) downloadCsv(x.name, x.headers, x.rows);
      return;
    }
    const btn = e.target.closest("[data-view-toggle]");
    if (!btn) return;
    const card = btn.closest(".stats-card");
    const showTable = !card.classList.contains("show-table");
    card.classList.toggle("show-table", showTable);
    btn.textContent = showTable ? "Chart" : "Table";
    btn.setAttribute("aria-pressed", String(showTable));
  });
  bindTooltip(content);

  await load(body);
}

async function load(body) {
  const content = body.querySelector("#stats-content");
  const label = body.querySelector("#stats-range-label");
  const { from, to } = rangeFor(state);
  const seq = ++requestSeq;

  label.textContent = `${formatDay(from, true)} – ${formatDay(to, true)} · by dispatch date`;
  // Keep the previous charts on screen, dimmed, while the new range loads.
  content.classList.add("is-loading");

  const { data, error } = await supabase.rpc("stats_dataset", {
    p_from: from,
    p_to: to,
    p_warehouse: state.warehouse || null,
  });
  if (seq !== requestSeq) return; // a newer filter change won
  content.classList.remove("is-loading");

  if (error) {
    content.innerHTML = `<p class="empty-note">Couldn't load statistics: ${esc(error.message)}</p>`;
    return;
  }

  lastDataset = data;
  redraw(body);
}

function redraw(body) {
  if (!lastDataset) return;
  const content = body.querySelector("#stats-content");
  const { from, to } = rangeFor(state);
  fillFilterOptions(body, filterOptions(lastDataset));
  const filters = { product: state.product, soldBy: state.soldBy, district: state.district };
  const stats = computeStats(lastDataset, { from, to, granularity: state.granularity, warehouses, filters });
  lastStats = stats;
  tips = [];
  exportsReg = [];

  const active = activeFilterLabels();
  body.querySelector("#stats-clear").style.display = active.length ? "" : "none";
  body.querySelector("#stats-range-label").textContent =
    `${formatDay(from, true)} – ${formatDay(to, true)} · by dispatch date` + (active.length ? ` · ${active.join(" · ")}` : "");
  content.innerHTML = stats.kpi.orders ? renderAll(stats) : renderEmpty(active.length > 0);
}

// Rebuild the Sold by / District / product choices from the fetched range,
// keeping the current choice even if it has no orders in this range.
function fillFilterOptions(body, opts) {
  const soldEl = body.querySelector("#stats-soldby");
  const sellers = new Set(opts.sellers);
  const currentSeller = state.soldBy.startsWith("seller:") ? state.soldBy.slice(7) : null;
  if (currentSeller) sellers.add(currentSeller);
  soldEl.innerHTML =
    `<option value="">Everyone</option><option value="website">Website orders</option><option value="manual">All manual orders</option>` +
    [...sellers].sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${escAttr(`seller:${n}`)}">${esc(n)}</option>`).join("");
  soldEl.value = state.soldBy;

  const distEl = body.querySelector("#stats-district");
  const districts = [...opts.districts];
  if (state.district && !districts.some((d) => d.code === state.district)) districts.push({ code: state.district, name: DISTRICTS[state.district] || "Unknown" });
  distEl.innerHTML = `<option value="">All districts</option>` + districts.map((d) => `<option value="${escAttr(d.code)}">${esc(d.name)}</option>`).join("");
  distEl.value = state.district;

  body.querySelector("#stats-product-list").innerHTML = opts.products.map((n) => `<option value="${escAttr(n)}"></option>`).join("");
}

function activeFilterLabels() {
  const out = [];
  if (state.product) out.push(`product contains "${state.product}"`);
  if (state.soldBy === "website") out.push("website orders");
  else if (state.soldBy === "manual") out.push("manual orders");
  else if (state.soldBy.startsWith("seller:")) out.push(`sold by ${state.soldBy.slice(7)}`);
  if (state.district) out.push(DISTRICTS[state.district] || "unknown district");
  return out;
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

function renderEmpty(filtered = false) {
  if (filtered) {
    return `
    <div class="stats-card">
      <h3>No orders match these filters</h3>
      <p class="stats-note">Try a longer period, or clear the product, sold by or district filter.</p>
    </div>`;
  }
  return `
    <div class="stats-card">
      <h3>No orders in this period</h3>
      <p class="stats-note">Statistics only count orders sent from Zagle with the updated extension (version 0.2.0 or later), since they carry products and amounts. Orders typed in by hand, or captured before the update, aren't included.</p>
    </div>`;
}

function renderAll(s) {
  const k = s.kpi;
  const c = s.customers;
  const labels = s.buckets.map((b) => bucketLabel(b));
  const longLabels = s.buckets.map((b) => bucketLabel(b, true));

  const productNote = state.product
    ? `<p class="stats-note stats-filter-note">Product filter on: units and revenue count only products whose name contains "${esc(state.product)}". Each order's discount is shared out by line value, and delivery isn't included.</p>`
    : "";
  const G = capitalize(state.granularity);
  const kpis = `
    ${productNote}
    <div class="stats-kpis">
      ${tile("Net revenue", money(k.net), "item value minus discounts")}
      ${tile("Orders", int(k.orders))}
      ${tile("Units", int(k.units))}
      ${tile("Average order", money(k.aov), "net revenue per order")}
      ${tile("Items per order", k.unitsPerOrder.toFixed(1))}
      ${tile("Discounts given", money(k.discount))}
      ${tile("Delivery charged", money(k.delivery))}
      ${tile("Repeat customers", pct(c.repeatRate), `${int(c.repeat)} of ${int(c.unique)} customers`)}
    </div>`;

  // --- Sales -----------------------------------------------------------
  const revenueCard = card({
    title: "Revenue",
    subtitle: `Net revenue per ${state.granularity}`,
    wide: true,
    chart: columnChart({
      values: s.revenue.map((r) => r.net),
      labels,
      format: money,
      tipFor: (i) => ({
        title: longLabels[i],
        rows: [
          { label: "Net revenue", value: money(s.revenue[i].net), strong: true },
          { label: "Item value", value: money(s.revenue[i].gross) },
          { label: "Discounts", value: money(s.revenue[i].discount) },
          { label: "Delivery charged", value: money(s.revenue[i].delivery) },
          { label: "Orders", value: int(s.revenue[i].orders) },
        ],
      }),
    }),
    table: table(
      [capitalize(state.granularity), "Orders", "Item value", "Discounts", "Net revenue", "Delivery"],
      s.revenue.map((r, i) => [longLabels[i], int(r.orders), money(r.gross), money(r.discount), money(r.net), money(r.delivery)]),
      [false, true, true, true, true, true]
    ),
    csv: { name: "revenue", headers: [G, "Orders", "Units", "Item value", "Discounts", "Net revenue", "Delivery charged"], rows: s.revenue.map((r, i) => [longLabels[i], r.orders, r.units, r.gross, r.discount, r.net, r.delivery]) },
  });

  const sourceColors = { website: SERIES[0], manual: SERIES[1], other: OTHER_COLOR };
  const sourceNames = { website: "Website", manual: "Manual", other: "Other" };
  const channelCard = card({
    title: "Website vs manual",
    subtitle: "Share of orders",
    chart: `
      ${tallSegmentedBar(s.sources.map((x) => ({ label: sourceNames[x.key], value: x.orders, share: x.share, color: sourceColors[x.key], tip: { title: sourceNames[x.key], rows: [{ label: "Orders", value: `${int(x.orders)} (${pct(x.share)})`, strong: true }, { label: "Net revenue", value: money(x.net) }, { label: "Units", value: int(x.units) }] } })))}
      ${
        s.sellers.length
          ? `<h4 class="stats-subhead">Manual sales by salesperson</h4>${table(["Salesperson", "Orders", "Units", "Net revenue"], s.sellers.map((x) => [x.name, int(x.orders), int(x.units), money(x.net)]), [false, true, true, true])}`
          : `<p class="stats-note">No manual orders in this period.</p>`
      }`,
    table: table(["Source", "Orders", "Share", "Units", "Net revenue"], s.sources.map((x) => [sourceNames[x.key], int(x.orders), pct(x.share), int(x.units), money(x.net)]), [false, true, true, true, true]),
    csv: {
      name: "sales-by-source",
      headers: ["Source", "Salesperson", "Orders", "Units", "Net revenue"],
      rows: [
        ...s.sources.filter((x) => x.key !== "manual").map((x) => [sourceNames[x.key], "", x.orders, x.units, x.net]),
        ...s.sellers.map((x) => ["Manual", x.name, x.orders, x.units, x.net]),
      ],
    },
  });

  const couponCard = card({
    title: "Coupons",
    subtitle: "Codes used, read from Zagle's order notes",
    noToggle: true,
    chart: s.coupons.length
      ? table(["Code", "Orders", "Discount given", "Net revenue"], s.coupons.map((x) => [x.code, int(x.orders), money(x.discount), money(x.net)]), [false, true, true, true])
      : `<p class="stats-note">No coupons used in this period.</p>`,
    csv: s.coupons.length ? { name: "coupons", headers: ["Code", "Orders", "Discount given", "Net revenue"], rows: s.coupons.map((x) => [x.code, x.orders, x.discount, x.net]) } : null,
  });

  const heatCard = card({
    title: "When customers order",
    subtitle: `Orders by weekday and hour placed, Bangladesh time (${int(s.placedCount)} orders with a placed time)`,
    wide: true,
    chart: heatmap(s.heat),
    table: table(
      ["Day", "Orders", "Busiest hour"],
      s.heat.map((row, d) => {
        const total = row.reduce((a, b) => a + b, 0);
        const peak = row.indexOf(Math.max(...row));
        return [WEEKDAYS[d], int(total), total ? `${hourLabel(peak)} (${int(row[peak])})` : "—"];
      }),
      [false, true, false]
    ),
    csv: { name: "orders-by-hour", headers: ["Day", ...Array.from({ length: 24 }, (_, h) => hourLabel(h)), "Total"], rows: s.heat.map((row, d) => [WEEKDAYS[d], ...row, row.reduce((a, b) => a + b, 0)]) },
  });

  // --- Products ----------------------------------------------------------
  const unitsCard = card({
    title: "Units dispatched",
    subtitle: `All products, per ${state.granularity}`,
    wide: true,
    chart: columnChart({
      values: s.unitsByBucket,
      labels,
      format: int,
      tipFor: (i) => ({ title: longLabels[i], rows: [{ label: "Units", value: int(s.unitsByBucket[i]), strong: true }, { label: "Orders", value: int(s.revenue[i].orders) }] }),
    }),
    table: table([capitalize(state.granularity), "Units", "Orders"], s.revenue.map((r, i) => [longLabels[i], int(r.units), int(r.orders)]), [false, true, true]),
    csv: { name: "units", headers: [G, "Units", "Orders"], rows: s.revenue.map((r, i) => [longLabels[i], r.units, r.orders]) },
  });

  const top = s.products.slice(0, 10);
  const topCard = card({
    title: "Top sellers",
    subtitle: "By units",
    chart: rankedBars(top.map((p) => ({ label: p.name, value: p.units, display: int(p.units), tip: { title: p.name, rows: [{ label: "Units", value: int(p.units), strong: true }, { label: "Revenue", value: money(p.revenue) }, { label: "Share of units", value: pct(p.share) }] } }))),
    table: table(["Product", "Units", "Revenue"], top.map((p) => [p.name, int(p.units), money(p.revenue)]), [false, true, true]),
  });

  const slowCard = card({
    title: "Slow movers",
    subtitle: "Selling at half their usual daily rate or less, compared with the 90 days before this period",
    noToggle: true,
    chart: s.slowMovers.length
      ? table(
          ["Product", "Per day now", "Per day before", "Change"],
          s.slowMovers.map((x) => [x.name, perDay(x.perDayNow), perDay(x.perDayBefore), x.now === 0 ? "None sold" : `−${Math.round(-x.change * 100)}%`]),
          [false, true, true, true]
        )
      : `<p class="stats-note">No product has slowed down by half or more compared with the 90 days before this period.</p>`,
    csv: s.slowMovers.length
      ? { name: "slow-movers", headers: ["Product", "Units now", "Per day now", "Units, 90 days before", "Per day before", "Change", "Last sold before"], rows: s.slowMovers.map((x) => [x.name, x.now, x.perDayNow, x.before, x.perDayBefore, x.change, x.lastBefore || ""]) }
      : null,
  });

  const productsCard = card({
    title: "All products",
    subtitle: "Average selling price is the price on the order line, before order-level discounts",
    wide: true,
    noToggle: true,
    chart: productTable(s.products),
    csv: {
      name: "products",
      headers: ["Product", "Brand", "Units", "Share of units", "Orders", "Revenue", "Avg price", "Lowest price", "Highest price", ...s.buckets.map((b, i) => `Units ${longLabels[i]}`)],
      rows: s.products.map((p) => [p.name, p.name.trim().split(/\s+/)[0], p.units, p.share, p.orders, p.revenue, p.avgPrice ?? "", p.minPrice ?? "", p.maxPrice ?? "", ...p.unitsByBucket]),
    },
  });

  const variantCard = card({
    title: "Variant split",
    subtitle: "Products sold in more than one variant, by units",
    noToggle: true,
    chart: s.variants.length ? variantList(s.variants) : `<p class="stats-note">No product sold in more than one variant in this period.</p>`,
    csv: s.variants.length ? { name: "variants", headers: ["Product", "Variant", "Units", "Share"], rows: s.variants.flatMap((g) => g.variants.map((v) => [g.base, v.name, v.units, v.share])) } : null,
  });

  const brandCard = card({
    title: "Brands",
    subtitle: "Share of units and of item revenue",
    chart: rankedBars(s.brands.map((b) => ({ label: b.name, value: b.units, display: `${int(b.units)} · ${pct(b.unitShare)}`, tip: { title: b.name, rows: [{ label: "Units", value: `${int(b.units)} (${pct(b.unitShare)})`, strong: true }, { label: "Revenue", value: `${money(b.revenue)} (${pct(b.revenueShare)})` }] } }))),
    table: table(["Brand", "Units", "Share of units", "Revenue", "Share of revenue"], s.brands.map((b) => [b.name, int(b.units), pct(b.unitShare), money(b.revenue), pct(b.revenueShare)]), [false, true, true, true, true]),
    csv: { name: "brands", headers: ["Brand", "Units", "Share of units", "Revenue", "Share of revenue"], rows: s.brands.map((b) => [b.name, b.units, b.unitShare, b.revenue, b.revenueShare]) },
  });

  const pairsCard = card({
    title: "Bought together",
    subtitle: "Products that appear in the same order (variants combined)",
    noToggle: true,
    chart: s.pairs.length
      ? table(["Products", "Orders"], s.pairs.map((p) => [`${p.a} + ${p.b}`, int(p.orders)]), [false, true])
      : `<p class="stats-note">No order in this period had two different products.</p>`,
    csv: s.pairs.length ? { name: "bought-together", headers: ["Product A", "Product B", "Orders"], rows: s.pairs.map((p) => [p.a, p.b, p.orders]) } : null,
  });

  // --- Warehouses & districts --------------------------------------------
  const whColor = new Map(warehouses.map((w, i) => [w.id, i < SERIES.length ? SERIES[i] : OTHER_COLOR]));
  const whSeries = s.warehouseSeries.map((w) => ({ ...w, color: whColor.get(w.id) || OTHER_COLOR }));
  const loadCard = card({
    title: "Warehouse load",
    subtitle: `Units dispatched per ${state.granularity}, by warehouse`,
    wide: true,
    chart: stackedColumnChart({
      series: whSeries,
      labels,
      tipFor: (i) => ({
        title: longLabels[i],
        rows: whSeries.map((w) => ({ label: w.name, value: int(w.values[i]), color: w.color })).concat([{ label: "Total", value: int(whSeries.reduce((t, w) => t + w.values[i], 0)), strong: true }]),
      }),
    }),
    table: table([capitalize(state.granularity), ...whSeries.map((w) => w.name), "Total"], s.buckets.map((b, i) => [longLabels[i], ...whSeries.map((w) => int(w.values[i])), int(whSeries.reduce((t, w) => t + w.values[i], 0))]), [false, ...whSeries.map(() => true), true]),
    csv: { name: "warehouse-load", headers: [G, ...whSeries.map((w) => `${w.name} units`), "Total units"], rows: s.buckets.map((b, i) => [longLabels[i], ...whSeries.map((w) => w.values[i]), whSeries.reduce((t, w) => t + w.values[i], 0)]) },
  });

  const topDistricts = s.districts.slice(0, 12);
  const districtCard = card({
    title: "Districts",
    subtitle: "Orders by delivery district",
    chart: rankedBars(topDistricts.map((d) => ({ label: d.name, value: d.orders, display: int(d.orders), tip: { title: d.name, rows: [{ label: "Orders", value: int(d.orders), strong: true }, { label: "Net revenue", value: money(d.net) }, { label: "Units", value: int(d.units) }] } }))),
    table: table(["District", "Orders", "Units", "Net revenue"], s.districts.map((d) => [d.name, int(d.orders), int(d.units), money(d.net)]), [false, true, true, true]),
    csv: { name: "districts", headers: ["District", "Code", "Orders", "Units", "Net revenue"], rows: s.districts.map((d) => [d.name, d.code === "unknown" ? "" : d.code, d.orders, d.units, d.net]) },
  });

  // --- Customers ---------------------------------------------------------
  const customerKpis = `
    <div class="stats-kpis">
      ${tile("Customers", int(c.unique), "ordered in this period")}
      ${tile("Repeat customers", int(c.repeat), "2 or more orders, ever")}
      ${tile("Repeat rate", pct(c.repeatRate))}
      ${tile("Days between orders", c.avgGapDays == null ? "—" : c.avgGapDays.toFixed(0), "average, for repeat customers")}
    </div>`;
  const shownCustomers = c.all.slice(0, 50);
  const customersCard = card({
    title: "Customers",
    subtitle: `Everyone who ordered in this period${activeFilterLabels().length ? ", with the filters above" : ""}, most orders first${c.all.length > 50 ? ` (showing 50 of ${int(c.all.length)}; Export CSV has all of them)` : ""}`,
    wide: true,
    noToggle: true,
    chart: c.all.length
      ? table(
          ["Customer", "Phone", "District", "Orders here", "Orders ever", "Last order", "Days between orders", "Total spent ever"],
          shownCustomers.map((x) => [x.name || "—", x.phone || "—", DISTRICTS[x.district] || "—", int(x.ordersHere), int(x.orders), x.last ? formatDay(x.last, true) : "—", x.avgGapDays == null ? "—" : x.avgGapDays.toFixed(0), money(x.spent)]),
          [false, false, false, true, true, false, true, true]
        )
      : `<p class="stats-note">No customers with a phone number in this period.</p>`,
    csv: c.all.length
      ? {
          name: "customers",
          headers: ["Customer", "Phone", "District", "Area", "Orders in period", "Net revenue in period", "Orders ever", "First order", "Last order", "Avg days between orders", "Total spent ever"],
          rows: c.all.map((x) => [x.name || "", x.phone || "", DISTRICTS[x.district] || "", x.area || "", x.ordersHere, x.netHere, x.orders, x.first || "", x.last || "", x.avgGapDays ?? "", x.spent]),
        }
      : null,
  });

  return `
    ${kpis}
    <h2 class="stats-section">Sales</h2>
    <div class="stats-grid">${revenueCard}${channelCard}${couponCard}${heatCard}</div>
    <h2 class="stats-section">Products</h2>
    <div class="stats-grid">${unitsCard}${topCard}${slowCard}${productsCard}${variantCard}${brandCard}${pairsCard}</div>
    <h2 class="stats-section">Warehouses and districts</h2>
    <div class="stats-grid">${loadCard}${districtCard}</div>
    <h2 class="stats-section">Customers</h2>
    ${customerKpis}
    <div class="stats-grid">${customersCard}</div>
    <p class="stats-note stats-footnote">Counts orders sent from Zagle with product details, by dispatch date. Cancelled orders and the original row of a moved order are left out; an order ID recorded twice counts once.</p>
  `;
}

// ---------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------

function tile(label, value, note = "") {
  return `<div class="stats-tile"><div class="stats-tile-label">${esc(label)}</div><div class="stats-tile-value">${esc(value)}</div>${note ? `<div class="stats-tile-note">${esc(note)}</div>` : ""}</div>`;
}

function card({ title, subtitle, chart, table: tableHtml, wide = false, noToggle = false, csv = null }) {
  const csvIdx = csv ? exportsReg.push({ ...csv, name: csvName(csv.name) }) - 1 : -1;
  return `
    <section class="stats-card ${wide ? "wide" : ""}">
      <div class="stats-card-head">
        <div>
          <h3>${esc(title)}</h3>
          ${subtitle ? `<p class="stats-card-sub">${esc(subtitle)}</p>` : ""}
        </div>
        <div class="stats-card-actions">
          ${!noToggle && tableHtml ? `<button type="button" class="ghost stats-view-btn" data-view-toggle aria-pressed="false">Table</button>` : ""}
          ${csv ? `<button type="button" class="ghost stats-view-btn" data-csv="${csvIdx}" title="Download as CSV (opens in Excel / Google Sheets)">Export CSV</button>` : ""}
        </div>
      </div>
      <div class="stats-chart">${chart}</div>
      ${!noToggle && tableHtml ? `<div class="stats-table-view">${tableHtml}</div>` : ""}
    </section>`;
}

function table(headers, rows, numeric = []) {
  return `
    <div class="stats-table-wrap">
      <table class="stats-table">
        <thead><tr>${headers.map((h, i) => `<th class="${numeric[i] ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((cell, i) => `<td class="${numeric[i] ? "num" : ""}">${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

function tipAttr(tip) {
  return tip ? `data-tip="${tips.push(tip) - 1}" tabindex="0"` : "";
}

function niceMax(max) {
  if (max <= 0) return { top: 1, step: 1 };
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough);
  return { top: Math.ceil(max / step) * step, step };
}

function axis(top, step, format) {
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return ticks
    .map((v) => `<div class="cc-tick" style="bottom:${(v / top) * 100}%"><span>${esc(format(v, true))}</span></div>`)
    .join("");
}

// Thin out x labels so they never collide: at most ~12 shown.
function xLabels(labels) {
  const every = Math.max(1, Math.ceil(labels.length / 12));
  return labels.map((l, i) => `<span class="cc-x">${i % every === 0 ? esc(l) : ""}</span>`).join("");
}

function columnChart({ values, labels, format, tipFor }) {
  const { top, step } = niceMax(Math.max(0, ...values));
  const cols = values
    .map((v, i) => `<div class="cc-col" ${tipAttr(tipFor(i))} aria-label="${escAttr(labels[i])}: ${escAttr(format(v))}"><div class="cc-bar" style="height:${top ? (v / top) * 100 : 0}%"></div></div>`)
    .join("");
  return `
    <div class="cc">
      <div class="cc-plot">
        <div class="cc-axis">${axis(top, step, (v) => compact(v))}</div>
        <div class="cc-cols">${cols}</div>
      </div>
      <div class="cc-xrow">${xLabels(labels)}</div>
    </div>`;
}

function stackedColumnChart({ series, labels, tipFor }) {
  const totals = labels.map((_, i) => series.reduce((t, s) => t + s.values[i], 0));
  const { top, step } = niceMax(Math.max(0, ...totals));
  const cols = labels
    .map((l, i) => {
      const segs = series
        .filter((s) => s.values[i] > 0)
        .map((s) => `<div class="cc-seg" style="height:${(s.values[i] / top) * 100}%;background:${s.color}"></div>`)
        .join("");
      return `<div class="cc-col" ${tipAttr(tipFor(i))} aria-label="${escAttr(l)}: ${escAttr(int(totals[i]))} units"><div class="cc-stack">${segs}</div></div>`;
    })
    .join("");
  const legend = series.length > 1 ? `<div class="stats-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  return `
    ${legend}
    <div class="cc">
      <div class="cc-plot">
        <div class="cc-axis">${axis(top, step, (v) => compact(v))}</div>
        <div class="cc-cols">${cols}</div>
      </div>
      <div class="cc-xrow">${xLabels(labels)}</div>
    </div>`;
}

function rankedBars(rows) {
  if (!rows.length) return `<p class="stats-note">Nothing to show for this period.</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="rb">${rows
    .map(
      (r) => `
      <div class="rb-row" ${tipAttr(r.tip)}>
        <span class="rb-label" title="${escAttr(r.label)}">${esc(r.label)}</span>
        <span class="rb-track"><span class="rb-bar" style="width:${(r.value / max) * 100}%"></span></span>
        <span class="rb-value">${esc(r.display)}</span>
      </div>`
    )
    .join("")}</div>`;
}

// One whole split into a few parts, share printed inside where it fits.
function tallSegmentedBar(parts) {
  const visible = parts.filter((p) => p.value > 0);
  if (!visible.length) return "";
  return `
    <div class="tsb" role="img" aria-label="${escAttr(visible.map((p) => `${p.label} ${pct(p.share)}`).join(", "))}">
      ${visible.map((p) => `<div class="tsb-part" style="flex-grow:${p.value};background:${p.color}" ${tipAttr(p.tip)}><span>${p.share >= 0.12 ? esc(pct(p.share)) : ""}</span></div>`).join("")}
    </div>
    <div class="stats-legend">${visible.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)}</span>`).join("")}</div>`;
}

function variantList(groups) {
  return `<div class="vs">${groups
    .slice(0, 12)
    .map((g) => {
      const shown = g.variants.slice(0, 4);
      const rest = g.variants.slice(4);
      const parts = shown.map((v, i) => ({ ...v, color: SERIES[i] }));
      if (rest.length) parts.push({ name: `Other (${rest.length})`, units: rest.reduce((t, v) => t + v.units, 0), share: rest.reduce((t, v) => t + v.share, 0), color: OTHER_COLOR });
      return `
        <div class="vs-row">
          <div class="vs-title"><span>${esc(g.base)}</span><span class="vs-units">${esc(int(g.units))} units</span></div>
          <div class="vs-bar">${parts.map((p) => `<span style="flex-grow:${p.units};background:${p.color}" ${tipAttr({ title: `${g.base} - ${p.name}`, rows: [{ label: "Units", value: `${int(p.units)} (${pct(p.share)})`, strong: true }] })}></span>`).join("")}</div>
          <div class="stats-legend">${parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.name)} ${esc(pct(p.share))}</span>`).join("")}</div>
        </div>`;
    })
    .join("")}</div>`;
}

function heatmap(grid) {
  const max = Math.max(1, ...grid.flat());
  const shade = (v) => (v === 0 ? HEAT[0] : HEAT[Math.min(HEAT.length - 1, 1 + Math.floor(((v - 1) / max) * (HEAT.length - 1)))]);
  const hours = Array.from({ length: 24 }, (_, h) => `<span class="hm-hour">${h % 3 === 0 ? esc(hourLabel(h, true)) : ""}</span>`).join("");
  const rows = grid
    .map(
      (row, d) => `
      <span class="hm-day">${WEEKDAYS[d]}</span>
      ${row.map((v, h) => `<span class="hm-cell" style="background:${shade(v)}" ${tipAttr({ title: `${WEEKDAYS[d]}, ${hourLabel(h)}–${hourLabel((h + 1) % 24)}`, rows: [{ label: "Orders", value: int(v), strong: true }] })}></span>`).join("")}`
    )
    .join("");
  return `
    <div class="hm-scroll">
      <div class="hm"><span></span>${hours}${rows}</div>
    </div>
    <div class="hm-scale"><span>Fewer</span>${HEAT.map((c) => `<i style="background:${c}"></i>`).join("")}<span>More</span></div>`;
}

function sparkline(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return `<span class="spark-empty">—</span>`;
  const w = 72;
  const h = 20;
  const min = Math.min(...pts.map(([, v]) => v));
  const max = Math.max(...pts.map(([, v]) => v));
  const span = max - min || 1;
  const n = Math.max(1, values.length - 1);
  const xy = pts.map(([i, v]) => [(i / n) * (w - 4) + 2, h - 2 - ((v - min) / span) * (h - 4)]);
  const [lx, ly] = xy[xy.length - 1];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${xy.map((p) => p.map((c) => c.toFixed(1)).join(",")).join(" ")}" /><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5" /></svg>`;
}

function productTable(products) {
  if (!products.length) return `<p class="stats-note">No products in this period.</p>`;
  return `
    <div class="stats-table-wrap">
      <table class="stats-table">
        <thead><tr>
          <th>Product</th><th class="num">Units</th><th class="num">Share</th><th class="num">Revenue</th>
          <th class="num">Avg price</th><th class="num">Price range</th><th>Units trend</th><th>Price trend</th>
        </tr></thead>
        <tbody>${products
          .map(
            (p) => `<tr>
            <td>${esc(p.name)}</td>
            <td class="num">${esc(int(p.units))}</td>
            <td class="num">${esc(pct(p.share))}</td>
            <td class="num">${esc(money(p.revenue))}</td>
            <td class="num">${esc(p.avgPrice == null ? "—" : money(p.avgPrice))}</td>
            <td class="num">${esc(p.minPrice == null ? "—" : p.minPrice === p.maxPrice ? money(p.minPrice) : `${money(p.minPrice)}–${money(p.maxPrice)}`)}</td>
            <td>${sparkline(p.unitsByBucket)}</td>
            <td>${sparkline(p.priceByBucket)}</td>
          </tr>`
          )
          .join("")}</tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------
// CSV export. Numbers stay plain (no ৳ or commas) so spreadsheets can
// add them up; a byte-order mark makes Excel read Bangla names correctly.
// ---------------------------------------------------------------------

function csvName(what) {
  const { from, to } = rangeFor(state);
  const bits = [what, from === to ? from : `${from}_to_${to}`];
  const wh = warehouses.find((w) => w.id === state.warehouse);
  if (wh) bits.push(wh.name);
  if (state.district) bits.push(DISTRICTS[state.district] || "unknown-district");
  if (state.soldBy.startsWith("seller:")) bits.push(state.soldBy.slice(7));
  else if (state.soldBy) bits.push(state.soldBy);
  if (state.product) bits.push(state.product);
  return `${bits.join("_").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-")}.csv`;
}

function csvCell(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "";
  const str = String(v);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadCsv(name, headers, rows) {
  const text = "\ufeff" + [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const dhakaDateTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Every order in the current filters, one row each.
function exportOrders(st) {
  const whName = new Map(warehouses.map((w) => [w.id, w.name]));
  const rows = st.orders
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))))
    .map((o) => [
      o.id,
      o.date,
      whName.get(o.wh) || "",
      o.placed ? dhakaDateTime.format(new Date(o.placed)) : "",
      o.source === "website" ? "Website" : o.source === "manual" ? "Manual" : o.source || "",
      o.source === "manual" ? o.sold_by || "" : "",
      o.status || "",
      o.name || "",
      o.phone || "",
      DISTRICTS[o.district] || "",
      o.area || "",
      o.address || "",
      o.items.map((it) => `${it.name} x ${it.qty}`).join("; "),
      o.units,
      o.gross,
      o.discount,
      o.delivery,
      o.net,
      (o.coupons || []).join("; "),
    ]);
  downloadCsv(csvName("orders"), ["Order ID", "Dispatch date", "Warehouse", "Placed (Bangladesh time)", "Source", "Sold by", "Status", "Customer", "Phone", "District", "Area", "Address", "Products", "Units", "Item value", "Discount", "Delivery", "Net revenue", "Coupons"], rows);
}

// ---------------------------------------------------------------------
// Tooltip: one floating element, filled with textContent only.
// ---------------------------------------------------------------------

function bindTooltip(root) {
  let tipEl = document.getElementById("stats-tip");
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.id = "stats-tip";
    tipEl.className = "stats-tip";
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  const show = (el, x, y) => {
    const tip = tips[Number(el.dataset.tip)];
    if (!tip) return;
    tipEl.replaceChildren();
    const title = document.createElement("div");
    title.className = "stats-tip-title";
    title.textContent = tip.title;
    tipEl.appendChild(title);
    for (const r of tip.rows) {
      const row = document.createElement("div");
      row.className = "stats-tip-row";
      const key = document.createElement("span");
      key.className = "stats-tip-key";
      if (r.color) {
        const swatch = document.createElement("i");
        swatch.style.background = r.color;
        key.appendChild(swatch);
      }
      key.appendChild(document.createTextNode(r.label));
      const val = document.createElement(r.strong ? "strong" : "span");
      val.textContent = r.value;
      row.append(val, key);
      tipEl.appendChild(row);
    }
    tipEl.style.display = "block";
    const pad = 12;
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    let left = x + pad;
    let topPos = y - h - pad;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    if (left < 8) left = 8;
    if (topPos < 8) topPos = y + pad;
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${topPos}px`;
  };
  const hide = () => (tipEl.style.display = "none");

  root.addEventListener("pointermove", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el) show(el, e.clientX, e.clientY);
    else hide();
  });
  root.addEventListener("pointerleave", hide);
  root.addEventListener("focusin", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top);
  });
  root.addEventListener("focusout", hide);
  if (!scrollBound) {
    scrollBound = true;
    window.addEventListener("scroll", () => (tipEl.style.display = "none"), { passive: true });
  }
}

// ---------------------------------------------------------------------
// Filters state
// ---------------------------------------------------------------------

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());
}

function rangeFor(st) {
  const today = todayKey();
  const monthStart = `${today.slice(0, 8)}01`;
  switch (st.preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDaysKey(today, -6), to: today };
    case "month":
      return { from: monthStart, to: today };
    case "lastmonth": {
      const lastEnd = addDaysKey(monthStart, -1);
      return { from: `${lastEnd.slice(0, 8)}01`, to: lastEnd };
    }
    case "90d":
      return { from: addDaysKey(today, -89), to: today };
    case "custom": {
      let from = st.from || addDaysKey(today, -29);
      let to = st.to || today;
      if (daysBetween(from, to) >= MAX_RANGE_DAYS) from = addDaysKey(to, -(MAX_RANGE_DAYS - 1));
      return { from, to };
    }
    default:
      return { from: addDaysKey(today, -29), to: today };
  }
}

function defaultGranularity({ from, to }) {
  const days = daysBetween(from, to) + 1;
  return days > 120 ? "month" : days > 45 ? "week" : "day";
}

function loadState() {
  const fallback = { preset: "30d", from: "", to: "", warehouse: "", granularity: "day", product: "", soldBy: "", district: "" };
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    if (!saved || !PRESETS.some((p) => p.id === saved.preset)) return fallback;
    return {
      ...fallback,
      ...saved,
      granularity: ["day", "week", "month"].includes(saved.granularity) ? saved.granularity : "day",
      product: typeof saved.product === "string" ? saved.product : "",
      soldBy: typeof saved.soldBy === "string" ? saved.soldBy : "",
      district: typeof saved.district === "string" ? saved.district : "",
    };
  } catch {
    return fallback;
  }
}

function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: filters still work, they just reset on reload.
  }
}

// ---------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------

function int(n) {
  return Math.round(Number(n) || 0).toLocaleString("en-IN");
}

function money(n) {
  return `৳${int(n)}`;
}

// Axis ticks: 950 · 12K · 1.5L · 2Cr (lakh / crore, as used in Bangladesh).
function compact(n) {
  const v = Math.abs(n);
  const fmt = (x) => (x < 10 ? x.toFixed(1).replace(/\.0$/, "") : Math.round(x).toString());
  if (v >= 1e7) return `${fmt(n / 1e7)}Cr`;
  if (v >= 1e5) return `${fmt(n / 1e5)}L`;
  if (v >= 1e3) return `${fmt(n / 1e3)}K`;
  return int(n);
}

function perDay(x) {
  return x >= 10 ? Math.round(x).toString() : x.toFixed(1);
}

function pct(x) {
  return `${Math.round((x || 0) * 100)}%`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDay(key, withYear = false) {
  const d = new Date(`${key}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

function bucketLabel(key, long = false) {
  if (state.granularity === "month") {
    return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: long ? "numeric" : "2-digit", timeZone: "UTC" });
  }
  if (state.granularity === "week") return long ? `Week of ${formatDay(key, true)}` : formatDay(key);
  return long ? formatDay(key, true) : formatDay(key);
}

function hourLabel(h, short = false) {
  const suffix = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return short ? `${hr}${suffix.toLowerCase()}` : `${hr} ${suffix}`;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(str) {
  return esc(str).replace(/"/g, "&quot;");
}
