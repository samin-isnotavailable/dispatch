// Reads an order from text copied off a Zagle order card (select the
// card, copy, paste) and returns the same `details` shape the extension
// saves (copy-extension/orderCardReader.js), so pasted orders count in
// the Products view and Statistics exactly like right-clicked ones.
//
// Plain text has no labels to anchor on, so this works line by line from
// things that are stable in both the desktop and phone layouts: the order
// ID first, the "Nov 6, 2026, 1:14 AM" date, "Website" / "Sold by …",
// the phone number, the "BD-xx" district code, the "N items" line, and
// the Items / Discount / Delivery / Total / Paid / Due summary at the end.
// Anything it can't read goes into `warnings`, which the preview shows.

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const DATE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)$/;
const ORDER_ID_RE = /^[A-Z]{2,6}-\d[\w-]*$/;
const MONEY_RE = /^[−-]?\s*৳\s*[\d,]+(?:\.\d+)?$/;
const QTY_PRICE_RE = /^([\d,]+)\s*[×x]\s*(৳\s*[\d,]+(?:\.\d+)?)$/;
const ITEMS_RE = /^(\d+) items?$/i;
const STATUSES = ["Pending", "Processing", "On hold", "Confirmed", "Shipped", "Delivered", "Cancelled", "Returned", "Completed", "Refunded", "Failed", "Draft"];
const SUMMARY_LABELS = ["Items", "Discount", "Delivery", "Total", "Paid", "Due"];
const PAYMENT_WORDS = /^(Paid|Unpaid|Partially paid|Partial|Refunded)$/i;
const SKIP_LINES = /^(View details|Qty|Price|Total|Add note|Add internal note|Internal notes|Customer note|Needs units)$/i;

const money = (s) => {
  const n = parseFloat(String(s).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const normPhone = (s) => {
  const digits = String(s).replace(/\D/g, "");
  if (/^(?:88)?01\d{9}$/.test(digits)) return digits.slice(-11);
  return null;
};

// Same rules as normalize_order_id in 0008_fill_missing_details.sql, so the
// dashboard compares IDs the way the database stores them:
// "42420" → "WOO-42420", "261106-0098" → "ORD-261106-0098",
// "woo 42420" → "WOO-42420". Anything else comes back trimmed, as typed.
export function normalizeOrderId(raw) {
  const t = String(raw ?? "").trim();
  const pre = t.match(/^(woo|ord)[\s-]*([0-9][0-9-]*)$/i);
  if (pre) return `${pre[1].toUpperCase()}-${pre[2]}`;
  if (/^[0-9]{3,7}$/.test(t)) return `WOO-${t}`;
  if (/^[0-9]{6}-[0-9]{3,5}$/.test(t)) return `ORD-${t}`;
  return t;
}

export function parseOrderText(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const warnings = [];
  const result = { orderId: null, details: null, warnings };
  if (!lines.length) return result;

  // --- Order ID: the first line that looks like one --------------------
  const idIdx = lines.findIndex((l) => ORDER_ID_RE.test(l));
  if (idIdx < 0) {
    warnings.push("No order ID found. The first line should be the order ID, e.g. WOO-42630.");
    return result;
  }
  result.orderId = lines[idIdx];

  // --- Header: date, source / salesperson, status ----------------------
  let placedAt = null;
  let source = null;
  let soldBy = null;
  let status = null;
  const phoneIdx = lines.findIndex((l, i) => i > idIdx && normPhone(l));
  const headerEnd = phoneIdx >= 0 ? phoneIdx : lines.length;
  for (let i = idIdx + 1; i < headerEnd; i++) {
    const l = lines[i];
    const m = l.match(DATE_RE);
    if (m && !placedAt) {
      const [, mon, day, year, hh, mm, ampm] = m;
      let hour = parseInt(hh, 10) % 12;
      if (ampm === "PM") hour += 12;
      placedAt = new Date(+year, MONTHS[mon], +day, hour, +mm).toISOString();
    } else if (/^Sold by /i.test(l)) {
      source = "manual";
      soldBy = l.replace(/^Sold by /i, "").trim() || null;
    } else if (/^Website$/i.test(l)) {
      source = "website";
    } else if (!status && STATUSES.some((s) => s.toLowerCase() === l.toLowerCase())) {
      status = STATUSES.find((s) => s.toLowerCase() === l.toLowerCase());
    }
  }
  if (!placedAt) warnings.push("No order date found.");
  if (!source) warnings.push("Couldn't tell if this is a website or manual order.");

  // --- Customer: name above the phone, address below it ----------------
  let customerName = null;
  let phone = null;
  let address = null;
  let districtCode = null;
  let area = null;
  if (phoneIdx >= 0) {
    phone = normPhone(lines[phoneIdx]);
    for (let i = phoneIdx - 1; i > idIdx; i--) {
      const l = lines[i];
      if (DATE_RE.test(l) || /^Sold by /i.test(l) || /^Website$/i.test(l) || SKIP_LINES.test(l) || STATUSES.some((s) => s.toLowerCase() === l.toLowerCase())) continue;
      customerName = l;
      break;
    }
    for (let i = phoneIdx + 1; i < Math.min(lines.length, phoneIdx + 4); i++) {
      const l = lines[i];
      if (/^\d+% reliable$/i.test(l)) continue;
      if (/^No address$/i.test(l)) break;
      if (ITEMS_RE.test(l) || SKIP_LINES.test(l)) break;
      address = l;
      break;
    }
    if (address) {
      const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
      const k = parts.findIndex((p) => /^BD-\d{2}$/i.test(p));
      if (k >= 0) {
        districtCode = parts[k].toUpperCase();
        area = k > 0 ? parts[k - 1] : null;
      }
    }
  } else {
    warnings.push("No customer phone number found.");
  }

  // --- Items: between "N items" and the "Items" summary line -----------
  const countIdx = lines.findIndex((l) => ITEMS_RE.test(l));
  const summaryIdx = lines.findIndex((l, i) => i > countIdx && countIdx >= 0 && l === "Items");
  const items = [];
  if (countIdx < 0) {
    warnings.push('No item list found (the "1 item" line is missing).');
  } else {
    let cur = null;
    const finish = () => {
      if (!cur) return;
      if (cur.qty == null) {
        cur.qty = 1;
        warnings.push(`No quantity for "${cur.name}", assumed 1.`);
      }
      if (cur.unit_price == null && cur.line_total != null) cur.unit_price = cur.line_total / cur.qty;
      if (cur.line_total == null && cur.unit_price != null) cur.line_total = cur.unit_price * cur.qty;
      items.push(cur);
      cur = null;
    };
    const end = summaryIdx > countIdx ? summaryIdx : lines.length;
    for (let i = countIdx + 1; i < end; i++) {
      const l = lines[i];
      if (SKIP_LINES.test(l)) continue;
      const qp = l.match(QTY_PRICE_RE);
      if (qp && cur) {
        cur.qty = parseInt(qp[1].replace(/,/g, ""), 10);
        cur.unit_price = money(qp[2]);
      } else if (/^\d+$/.test(l) && cur) {
        if (cur.qty == null) cur.qty = parseInt(l, 10);
      } else if (MONEY_RE.test(l) && cur) {
        // First amount is the unit price unless we already have it; any
        // later amount is the line total (the last one wins).
        if (cur.unit_price == null) cur.unit_price = money(l);
        else cur.line_total = money(l);
      } else if (!/\s/.test(l) && /^[A-Z0-9-]{6,}$/i.test(l) && /\d/.test(l)) {
        // A serial number under the product name: not part of the name.
      } else {
        finish();
        cur = { name: l, qty: null, unit_price: null, line_total: null };
      }
    }
    finish();
    const expected = parseInt(lines[countIdx], 10);
    if (expected !== items.length) warnings.push(`The order says ${expected} item${expected === 1 ? "" : "s"}, but ${items.length} were read.`);
  }

  // --- Summary: Items, Discount, Delivery, Total, Paid, Due ------------
  const amounts = {};
  let paymentStatus = null;
  if (summaryIdx >= 0) {
    // Lines already used as a value or as Due's status ("Due / Paid / ৳0"),
    // so that "Paid" there isn't mistaken for the "Paid" amount row.
    const used = new Set();
    for (let i = summaryIdx; i < lines.length; i++) {
      if (used.has(i)) continue;
      const label = SUMMARY_LABELS.find((s) => s === lines[i]);
      if (!label) continue;
      for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
        if (label === "Due" && PAYMENT_WORDS.test(lines[j])) {
          paymentStatus = lines[j];
          used.add(j);
          continue;
        }
        if (MONEY_RE.test(lines[j])) {
          amounts[label.toLowerCase()] = money(lines[j]);
          used.add(j);
          break;
        }
      }
    }
  } else {
    warnings.push("No Items / Total summary found at the end.");
  }

  const coupons = [...new Set([...String(raw).matchAll(/coupon\s+([A-Za-z0-9_-]+)\s*:/gi)].map((m) => m[1].toLowerCase()))];

  result.details = {
    v: 1,
    captured_from: "paste",
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
    courier: null,
    warnings,
  };
  return result;
}
