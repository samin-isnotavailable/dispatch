// Reads the Zagle order card that contains the current selection.
//
// This function is injected into the Zagle tab with
// chrome.scripting.executeScript, which sends only its source text — so it
// must stay self-contained: no imports, and no references to anything
// outside its own body.
//
// Zagle's CSS class names are generated utility classes that can change
// on any update, so fields are located by labels and attributes wherever
// possible (aria-label, data-slot, data-label), falling back to page
// structure only for the item rows and the order date.
//
// Returns one of:
//   { kind: "order", orderId, details }  — selection is inside an order card
//   { kind: "product-name" }            — selection is only a product name
//                                         (the old "send to Note" habit)
//   null                                — not a Zagle order card
export function readOrderCard() {
  if (location.hostname !== "app.zagle.ai") return null;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const toEl = (n) => (n ? (n.nodeType === 1 ? n : n.parentElement) : null);
  const cardOf = (n) => toEl(n)?.closest('[data-slot="card-content"]') || null;

  const card = cardOf(sel.anchorNode);
  if (!card || cardOf(sel.focusNode) !== card) return null;

  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const num = (s) => {
    const n = parseFloat(String(s || "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const common = toEl(sel.getRangeAt(0).commonAncestorContainer);
  const itemName = common?.closest("li > div > p:first-child");
  if (itemName && card.contains(itemName)) return { kind: "product-name" };

  const warnings = [];

  // --- Order ID ---------------------------------------------------------
  const viewBtn = card.querySelector('[aria-label^="View order "]');
  const orderId = viewBtn ? viewBtn.getAttribute("aria-label").slice("View order ".length).trim() : text(viewBtn);
  if (!orderId) return null;

  // --- Placed date, source / salesperson --------------------------------
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const dateRe = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)$/;
  let placedAt = null;
  let source = null;
  let soldBy = null;
  const dateSpan = [...card.querySelectorAll("span")].find((s) => dateRe.test(text(s)));
  if (dateSpan) {
    const [, mon, day, year, hh, mm, ampm] = text(dateSpan).match(dateRe);
    let hour = parseInt(hh, 10) % 12;
    if (ampm === "PM") hour += 12;
    placedAt = new Date(+year, months[mon], +day, hour, +mm).toISOString();

    for (const sib of dateSpan.parentElement.children) {
      if (sib === dateSpan) continue;
      const t = text(sib);
      if (/^Sold by /i.test(t)) {
        source = "manual";
        soldBy = t.replace(/^Sold by /i, "").trim();
      } else if (/^website$/i.test(t)) {
        source = "website";
      } else if (t && !source) {
        source = t.toLowerCase();
      }
    }
  } else {
    warnings.push("no order date");
  }

  // --- Status -----------------------------------------------------------
  const status = text(card.querySelector('[aria-label^="Status of order"] [data-slot="select-value"]')) || null;

  // --- Customer: name, phone, address, district -----------------------
  // The phone link is the anchor: the name is the line above its row, the
  // address the line below it.
  const tel = card.querySelector('a[href^="tel:"]');
  const phone = tel ? tel.getAttribute("href").slice(4).trim() : null;
  const customerName = text(tel?.parentElement?.previousElementSibling) || null;
  const addressEl = tel?.parentElement?.nextElementSibling;
  const address = text(addressEl) || null;
  let districtCode = null;
  let area = null;
  if (address) {
    const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
    const idx = parts.findIndex((p) => /^BD-\d{2}$/i.test(p));
    if (idx >= 0) {
      districtCode = parts[idx].toUpperCase();
      area = idx > 0 ? parts[idx - 1] : null;
    }
  }

  // --- Items ------------------------------------------------------------
  const countSpan = [...card.querySelectorAll("span")].find((s) => /^\d+ items?$/.test(text(s)));
  const itemScope = countSpan?.parentElement?.parentElement || card;
  const items = [];
  for (const li of itemScope.querySelectorAll("ul > li")) {
    const name = text(li.querySelector(":scope > div > p:first-child"));
    if (!name) continue;
    const cells = li.querySelectorAll(":scope > span");
    let qty = null;
    let unitPrice = null;
    const compact = text(cells[0]).match(/^([\d,]+)\s*×\s*(.+)$/);
    if (compact) {
      qty = parseInt(compact[1].replace(/,/g, ""), 10);
      unitPrice = num(compact[2]);
    }
    if (cells.length >= 4) {
      if (qty == null) qty = parseInt(text(cells[1]).replace(/,/g, ""), 10) || null;
      if (unitPrice == null) unitPrice = num(text(cells[2]));
    }
    const lineTotal = cells.length ? num(text(cells[cells.length - 1])) : null;
    if (qty == null) {
      qty = 1;
      warnings.push(`no quantity for "${name}", assumed 1`);
    }
    items.push({ name, qty, unit_price: unitPrice, line_total: lineTotal });
  }
  if (countSpan) {
    const expected = parseInt(text(countSpan), 10);
    if (expected !== items.length) warnings.push(`card says ${expected} items, read ${items.length}`);
  } else {
    warnings.push("no item list found");
  }

  // --- Amounts (Items, Discount, Delivery, Total, Paid, Due, …) ---------
  const amounts = {};
  let paymentStatus = null;
  for (const row of card.querySelectorAll('[data-slot="summary-row"]')) {
    const label = (row.getAttribute("data-label") || "").trim().toLowerCase();
    if (!label) continue;
    amounts[label] = num(text(row.lastElementChild));
    if (label === "due") paymentStatus = text(row.querySelector('[data-slot="badge"]')) || null;
  }

  // --- Coupon codes (Zagle writes them into the internal notes) --------
  const coupons = [...new Set([...text(card).matchAll(/coupon\s+([A-Za-z0-9_-]+)\s*:/gi)].map((m) => m[1].toLowerCase()))];

  // --- Courier ----------------------------------------------------------
  let courier = null;
  const courierLabel = [...card.querySelectorAll("span")].find((s) => text(s) === "Courier");
  const courierBox = courierLabel?.parentElement;
  if (courierBox && !/Not sent/i.test(text(courierBox))) {
    const consignBtn = card.querySelector('[aria-label^="Copy consignment "]');
    courier = {
      provider: text(courierBox.querySelector(":scope > div span.text-foreground")) || null,
      status: text(courierBox.querySelector('[data-slot="badge"]')) || null,
      consignment: consignBtn ? consignBtn.getAttribute("aria-label").slice("Copy consignment ".length).trim() : null,
    };
  }

  return {
    kind: "order",
    orderId,
    details: {
      v: 1,
      captured_from: "zagle",
      placed_at: placedAt,
      source,
      sold_by: soldBy,
      status,
      customer_name: customerName,
      phone,
      address,
      district_code: districtCode,
      area,
      items,
      amounts,
      payment_status: paymentStatus,
      coupons,
      courier,
      warnings,
    },
  };
}
