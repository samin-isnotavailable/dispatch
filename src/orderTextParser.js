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

// Text read from a screenshot (ocr.js) differs from copied text: ৳ comes out
// as "»", "v", "b" or nothing; "WOO" as "WO0"; labels and amounts share a
// line ("Delivery b130"); long names and addresses wrap onto two lines.
// This rewrites it into the copied-text shape parseOrderText expects.
const LABEL_MONEY_RE = new RegExp(
  `^(${SUMMARY_LABELS.join("|")})(?:\\s+(Paid|Unpaid|Partially paid|Partial|Refunded))?\\s+([−-])?\\s*[^\\s\\d]{0,2}\\s*([\\d,]+(?:\\.\\d+)?)$`,
  "i"
);
const OCR_QTY_RE = /^(\d+)\s*[x×]\s*[^\s\d]{0,2}\s*([\d,]+(?:\.\d+)?)(?:\s+[^\s\d]{0,2}\s*([\d,]+(?:\.\d+)?))?$/i;

// Desktop screenshots: Zagle shows the order as three columns side by side
// (customer | products | totals), and plain OCR text reads straight across
// them. This uses each word's position instead: the "1 item" heading marks
// where the products column starts, "Delivery" / "Due" where the totals
// start. Returns null for a one-column (phone) screenshot.
// `lines` are tesseract lines: { bbox, words: [{ text, bbox: { x0, x1 } }] }.
export function textFromOcrLayout(lines) {
  // Split each line into pieces wherever words are far apart (wider than the line is tall).
  const rows = lines.map((l) => {
    const gap = l.bbox.y1 - l.bbox.y0;
    const segs = [];
    let cur = null;
    for (const w of l.words) {
      const t = w.text.trim();
      if (!t) continue;
      if (cur && w.bbox.x0 - cur.x1 <= gap) {
        cur.text += ` ${t}`;
        cur.x1 = w.bbox.x1;
      } else segs.push((cur = { text: t, x0: w.bbox.x0, x1: w.bbox.x1 }));
    }
    return segs;
  });
  const all = rows.flat();
  const width = Math.max(1, ...all.map((s) => s.x1));
  const countSeg = all.find((s) => /^\d+\s*items?\b/i.test(s.text));
  const itemsLeft = countSeg?.x0 ?? 0;
  const summaryLeft = Math.min(...all.filter((s) => /^(Delivery|Due|Discount)\b/i.test(s.text) && s.x0 > itemsLeft).map((s) => s.x0));
  if (!countSeg || itemsLeft < width * 0.2 || !Number.isFinite(summaryLeft)) return null;

  const tol = 12;
  const head = [];
  const customer = [];
  const products = [];
  const totals = [];
  const isNumber = (t) => /^[^\s\d]?\s*[\d,.]+$/.test(t);
  const digits = (t) => t.replace(/[^\d,.]/g, "");
  let item = null;
  const headRow = rows.findIndex((r) => r.some((s) => /^(W[O0]{1,3}|[O0]R[D0])\s*[-–—]\s*\d/i.test(s.text)));
  rows.forEach((row, i) => {
    if (i === headRow) return head.push(...row.map((s) => s.text.replace(/\s+\S$/, ""))); // "Processing v" (the dropdown arrow)
    const mid = [];
    const right = [];
    for (const s of row) {
      if (s.x0 < itemsLeft - tol) customer.push(s.text);
      else if (s.x0 >= summaryLeft - tol) right.push(s.text);
      else mid.push(s);
    }
    if (right.length) totals.push(right.join(" ")); // "Delivery" … "৳65" sit far apart on one row
    if (!mid.length) return;
    if (mid.includes(countSeg)) return products.push(countSeg.text);
    const [name, ...nums] = mid;
    if (nums.length >= 2 && nums.every((n) => isNumber(n.text))) {
      // A product's first line has its qty, price and total beside the name.
      item = { name: name.text, qty: digits(nums[0].text), price: digits(nums[1].text), total: nums[2] ? digits(nums[2].text) : null };
      products.push(item);
    } else if (item) item.name += ` ${mid.map((s) => s.text).join(" ")}`; // the name wrapped onto another line
  });
  const productLines = products.flatMap((p) => (typeof p === "string" ? [p] : [p.name, `${p.qty} × ৳${p.price}`, ...(p.total ? [`৳${p.total}`] : [])]));
  return [...head, ...customer, ...productLines, ...totals].join("\n");
}

export function cleanOcrText(raw) {
  const out = [];
  let inItems = false;
  let joinNext = false; // previous line ended with "," (a wrapped address)
  const lines = String(raw || "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (let line of lines) {
    // "WO00-42738" / "0RD-…" → "WOO-42738" / "ORD-…", and split off a status after it.
    line = line.replace(/^W[O0]{1,3}\s*[-–—]\s*(?=\d)/i, "WOO-").replace(/^[O0]R[D0]\s*[-–—]\s*(?=\d)/i, "ORD-");
    const idRest = line.match(/^((?:WOO|ORD)-[\d-]+)\s+(.+)$/);
    if (idRest) {
      out.push(idRest[1], idRest[2]);
      continue;
    }
    line = line.replace(/^(\d+)\s*(items?)\b.*$/i, "$1 $2"); // "1 item Qty Price Total" → "1 item"
    line = line.replace(/^[Il1|]?tems(?=\s)/, "Items"); // "tems ৳5,699": the I is often lost
    const phoneRest = line.match(/^((?:\+?88)?01\d{9})\s+\d+%\s*reliable$/i);
    if (phoneRest) line = phoneRest[1];
    if (joinNext) {
      out[out.length - 1] += ` ${line}`;
      joinNext = /,$/.test(line);
      continue;
    }
    joinNext = /,$/.test(line) && !inItems;

    const lm = line.match(LABEL_MONEY_RE);
    if (lm) {
      inItems = false;
      const label = SUMMARY_LABELS.find((s) => s.toLowerCase() === lm[1].toLowerCase());
      out.push(label);
      if (lm[2]) out.push(lm[2]);
      out.push(`${lm[3] ? "−" : ""}৳${lm[4]}`);
      continue;
    }
    const q = line.match(OCR_QTY_RE);
    if (q) {
      out.push(`${q[1]} × ৳${q[2]}`);
      if (q[3]) out.push(`৳${q[3]}`);
      continue;
    }
    if (ITEMS_RE.test(line)) {
      inItems = true;
      out.push(line);
      continue;
    }
    // A product name wrapped onto a second line: join it back.
    const prev = out[out.length - 1];
    const isText = (l) => l && !/^\d/.test(l) && !ITEMS_RE.test(l) && !/৳/.test(l) && /\s/.test(l);
    if (inItems) line = line.replace(/(\d) ?[x×] ?(\d)/g, "$1 × $2"); // "700 x 300 mm" as Zagle writes it
    if (inItems && isText(line) && isText(prev) && !ITEMS_RE.test(prev)) {
      out[out.length - 1] = `${prev} ${line}`;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Product names from a screenshot can lose a space or swap look-alike
// characters ("X1V2" for "X1 V2", "0" for "O"). productKey drops exactly
// those differences, so a read name can be matched to a name already sold.
// Only an exact key match counts: one real character apart ("X1" / "X2")
// is a different product.
export const productKey = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]/g, "").replace(/0/g, "o").replace(/[1i]/g, "l");

// { name, known } — the sold name when there's a match, else the read name.
export function matchKnownProduct(name, keyToName) {
  const known = keyToName.get(productKey(name));
  return known ? { name: known, known: true } : { name, known: false };
}
