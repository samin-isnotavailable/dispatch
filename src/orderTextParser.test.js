// Run with: npm test
// Covers the rules that, if they break, quietly save wrong data: short order
// IDs (must match normalize_order_id in 0008_fill_missing_details.sql),
// reading a screenshot's text, and districts for manual orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrderId, parseOrderText, cleanOcrText, textFromOcrLayout, productKey, matchKnownProduct } from "./orderTextParser.js";
import { districtFromAddress } from "./statsCompute.js";

test("short order IDs are completed like the database does", () => {
  assert.equal(normalizeOrderId("42420"), "WOO-42420");
  assert.equal(normalizeOrderId(" woo 42420 "), "WOO-42420");
  assert.equal(normalizeOrderId("261106-0098"), "ORD-261106-0098");
  assert.equal(normalizeOrderId("ord261106-0098"), "ORD-261106-0098");
  assert.equal(normalizeOrderId("FANTECH MP256"), "FANTECH MP256"); // Note warehouse product names untouched
});

// Real text read from a phone screenshot of an order card.
const OCR = `WO00-42738 Shipped
Nov 8, 2026, 9:41 PM

Website

Hasibul Hasan Shanto

01763886638

Alhaz Chatrabas, Jamrultola, Motihar, Rajshahi Sadar,
Rajshahi Sadar, BD-54

1item

MechaGeek The Blade of Honor Speed Surface
Mouse Pad - 700 x 300 mm

1x »899 v899
Items »899
Discount -b100
Delivery b130
Total v929
Due Unpaid 929`;

test("a screenshot's text reads as a full order", () => {
  const r = parseOrderText(cleanOcrText(OCR));
  assert.equal(r.orderId, "WOO-42738");
  assert.deepEqual(r.warnings, []);
  const d = r.details;
  assert.equal(d.phone, "01763886638");
  assert.equal(d.district_code, "BD-54");
  assert.equal(d.status, "Shipped");
  assert.deepEqual(d.items, [{ name: "MechaGeek The Blade of Honor Speed Surface Mouse Pad - 700 × 300 mm", qty: 1, unit_price: 899, line_total: 899 }]);
  assert.deepEqual(d.amounts, { items: 899, discount: 100, delivery: 130, total: 929, due: 929 });
  assert.equal(d.payment_status, "Unpaid");
});

test("manual orders get their district from the address", () => {
  assert.equal(districtFromAddress("House 12, Mirpur 10"), "BD-13");
  assert.equal(districtFromAddress("Agrabad, Chittagong"), "BD-10");
  assert.equal(districtFromAddress("Narayangonj sadar"), "BD-40");
  assert.equal(districtFromAddress("Dhaka Road, Sylhet"), "BD-60"); // the last place named wins
  assert.equal(districtFromAddress("Some village"), null);
});

// Word positions as read from a desktop screenshot (three columns side by
// side). Customer details made up; positions and OCR mistakes are real.
const row = (y, ...words) => ({ bbox: { y0: y, y1: y + 38 }, words: words.map(([text, x0, x1]) => ({ text, bbox: { x0, x1 } })) });
const DESKTOP = [
  row(57, ["WO00-42927", 107, 309], ["Nov", 675, 724], ["11,", 736, 774], ["2026,", 787, 862], ["1:20", 875, 932], ["AM", 942, 984], ["Website", 1029, 1120], ["Processing", 1618, 1742], ["v", 1757, 1770], ["View", 1907, 1971], ["details", 1981, 2067]),
  row(143, ["Rafi", 51, 110], ["Hasan", 120, 200], ["1", 675, 686], ["item", 696, 741], ["Qty", 1175, 1213], ["Price", 1326, 1380], ["Total", 1495, 1548], ["tems", 1616, 1685], ["v5,699", 1995, 2090]),
  row(201, ["01700000000", 52, 248], ["100%", 286, 352], ["reliable", 362, 443], ["ATK", 673, 725], ["Blazing", 736, 829], ["Sky", 840, 887], ["X1V2", 897, 968], ["Ultra", 981, 1040], ["Max", 1052, 1105], ["1", 1198, 1211], ["©5699", 1284, 1379], ["v5699", 1452, 1548], ["Delivery", 1616, 1721], ["65", 2039, 2089]),
  row(251, ["12/B", 52, 129], ["Lake", 141, 226], ["Road,", 238, 312], ["2.0", 674, 713], ["Esports", 725, 821], ["Wireless", 831, 942], ["Mouse", 954, 1040], ["-", 1051, 1060], ["Total", 1615, 1677], ["5764", 2014, 2091]),
  row(282, ["Mirpur-1216,", 52, 220], ["Black", 675, 744], ["ota", 1631, 1670], ["vo", 1993, 2036]),
  row(331, ["Dhaka,", 53, 139], ["BD-13,", 152, 234], ["1216", 246, 300]),
  row(354, ["Due", 1616, 1666], ["Unpaid", 1703, 1781], ["v5,764", 1952, 2091]),
  row(438, ["Courier", 1615, 1697], ["Not", 1983, 2027], ["sent", 2037, 2091]),
];

test("a desktop screenshot's three columns are read apart", () => {
  const r = parseOrderText(cleanOcrText(textFromOcrLayout(DESKTOP)));
  assert.equal(r.orderId, "WOO-42927");
  assert.deepEqual(r.warnings, []);
  const d = r.details;
  assert.equal(d.customer_name, "Rafi Hasan");
  assert.equal(d.phone, "01700000000");
  assert.equal(d.address, "12/B Lake Road, Mirpur-1216, Dhaka, BD-13, 1216");
  assert.equal(d.status, "Processing");
  assert.deepEqual(d.items, [{ name: "ATK Blazing Sky X1V2 Ultra Max 2.0 Esports Wireless Mouse - Black", qty: 1, unit_price: 5699, line_total: 5699 }]);
  assert.deepEqual(d.amounts, { items: 5699, delivery: 65, total: 5764, due: 5764 });
});

test("a phone screenshot is left to the plain text path", () => {
  assert.equal(textFromOcrLayout([row(10, ["WOO-1", 10, 90]), row(60, ["1", 10, 20], ["item", 25, 60])]), null);
});

test("screenshot product names snap to the name already sold, only on an exact match", () => {
  const known = new Map(["ATK Blazing Sky X1 V2 Ultra Max 2.0 Esports Wireless Mouse - Black", "VXE R1 Pro - White", "VXE R2 Pro - White"].map((n) => [productKey(n), n]));
  assert.deepEqual(matchKnownProduct("ATK Blazing Sky X1V2 Ultra Max 2.0 Esports Wireless Mouse - Black", known), { name: "ATK Blazing Sky X1 V2 Ultra Max 2.0 Esports Wireless Mouse - Black", known: true });
  assert.equal(matchKnownProduct("VXE Rl Pro - White", known).name, "VXE R1 Pro - White"); // l read for 1
  assert.deepEqual(matchKnownProduct("VXE R3 Pro - White", known), { name: "VXE R3 Pro - White", known: false }); // a real difference stays
});
