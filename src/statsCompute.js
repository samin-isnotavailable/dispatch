// Pure calculations for the Statistics tab: dataset in, numbers out. No
// DOM and no network, so it can be tested on its own. The dataset comes
// from the stats_dataset RPC (supabase/migrations/0006_statistics.sql),
// which has already dropped cancelled / moved / duplicate orders.

export const DISTRICTS = {
  "BD-01": "Bandarban", "BD-02": "Barguna", "BD-03": "Bogura", "BD-04": "Brahmanbaria",
  "BD-05": "Bagerhat", "BD-06": "Barishal", "BD-07": "Bhola", "BD-08": "Cumilla",
  "BD-09": "Chandpur", "BD-10": "Chattogram", "BD-11": "Cox's Bazar", "BD-12": "Chuadanga",
  "BD-13": "Dhaka", "BD-14": "Dinajpur", "BD-15": "Faridpur", "BD-16": "Feni",
  "BD-17": "Gopalganj", "BD-18": "Gazipur", "BD-19": "Gaibandha", "BD-20": "Habiganj",
  "BD-21": "Jamalpur", "BD-22": "Jashore", "BD-23": "Jhenaidah", "BD-24": "Joypurhat",
  "BD-25": "Jhalakathi", "BD-26": "Kishoreganj", "BD-27": "Khulna", "BD-28": "Kurigram",
  "BD-29": "Khagrachhari", "BD-30": "Kushtia", "BD-31": "Lakshmipur", "BD-32": "Lalmonirhat",
  "BD-33": "Manikganj", "BD-34": "Mymensingh", "BD-35": "Munshiganj", "BD-36": "Madaripur",
  "BD-37": "Magura", "BD-38": "Moulvibazar", "BD-39": "Meherpur", "BD-40": "Narayanganj",
  "BD-41": "Netrakona", "BD-42": "Narsingdi", "BD-43": "Narail", "BD-44": "Natore",
  "BD-45": "Chapai Nawabganj", "BD-46": "Nilphamari", "BD-47": "Noakhali", "BD-48": "Naogaon",
  "BD-49": "Pabna", "BD-50": "Pirojpur", "BD-51": "Patuakhali", "BD-52": "Panchagarh",
  "BD-53": "Rajbari", "BD-54": "Rajshahi", "BD-55": "Rangpur", "BD-56": "Rangamati",
  "BD-57": "Sherpur", "BD-58": "Satkhira", "BD-59": "Sirajganj", "BD-60": "Sylhet",
  "BD-61": "Sunamganj", "BD-62": "Shariatpur", "BD-63": "Tangail", "BD-64": "Thakurgaon",
};

export const WEEKDAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];

// ---------------------------------------------------------------------
// Dates. Date keys are "YYYY-MM-DD" strings, handled as calendar days
// (no time zone involved). Weeks start on Saturday.
// ---------------------------------------------------------------------

const MS_DAY = 86400000;
const toUtc = (key) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

export function addDaysKey(key, n) {
  return fromUtc(toUtc(key) + n * MS_DAY);
}

export function daysBetween(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / MS_DAY);
}

export function bucketOf(key, granularity) {
  if (granularity === "month") return `${key.slice(0, 7)}-01`;
  if (granularity === "week") {
    const dow = new Date(toUtc(key)).getUTCDay(); // 0 = Sunday … 6 = Saturday
    return addDaysKey(key, -((dow + 1) % 7));
  }
  return key;
}

export function bucketKeys(from, to, granularity) {
  const keys = [];
  let k = bucketOf(from, granularity);
  while (k <= to) {
    keys.push(k);
    if (granularity === "month") {
      const y = +k.slice(0, 4);
      const m = +k.slice(5, 7);
      k = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    } else {
      k = addDaysKey(k, granularity === "week" ? 7 : 1);
    }
  }
  return keys;
}

// Weekday (Saturday-first index) and hour an order was placed, in
// Bangladesh time regardless of the viewer's own clock.
const dhakaParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dhaka",
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});
function placedSlot(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(dhakaParts.formatToParts(d).map((p) => [p.type, p.value]));
  const day = WEEKDAYS.indexOf(parts.weekday);
  const hour = parseInt(parts.hour, 10) % 24;
  return day < 0 ? null : { day, hour };
}

// ---------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------

// "VXE R1 Tri-Mode Gaming Mouse - Black" → base "VXE R1 Tri-Mode Gaming Mouse", variant "Black".
export function splitVariant(name) {
  const parts = String(name).split(" - ").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return { base: String(name).trim(), variant: null };
  return { base: parts[0], variant: parts.slice(1).join(" - ") };
}

export function brandOf(name) {
  return String(name).trim().split(/\s+/)[0] || "Other";
}

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

function itemFigures(it) {
  const qty = num(it.qty) ?? 1;
  const price = num(it.price);
  const total = num(it.total) ?? (price != null ? price * qty : 0);
  return { name: String(it.name), qty, price, total };
}

// ---------------------------------------------------------------------
// The whole computation
// ---------------------------------------------------------------------

export function computeStats(dataset, { from, to, granularity, warehouses }) {
  const orders = dataset?.orders || [];
  const buckets = bucketKeys(from, to, granularity);
  const bucketIndex = new Map(buckets.map((k, i) => [k, i]));
  const zeros = () => buckets.map(() => 0);

  const kpi = { orders: 0, units: 0, gross: 0, discount: 0, net: 0, delivery: 0 };
  const revenue = buckets.map((key) => ({ key, gross: 0, discount: 0, net: 0, delivery: 0, orders: 0, units: 0 }));
  const whIds = (warehouses || []).map((w) => w.id);
  const whUnits = new Map(whIds.map((id) => [id, zeros()]));
  const whOrders = new Map(whIds.map((id) => [id, 0]));
  const products = new Map();
  const brands = new Map();
  const sources = new Map();
  const sellers = new Map();
  const coupons = new Map();
  const districts = new Map();
  const heat = WEEKDAYS.map(() => Array(24).fill(0));
  let placedCount = 0;
  const pairs = new Map();

  for (const o of orders) {
    const bi = bucketIndex.get(bucketOf(o.date, granularity));
    if (bi == null) continue;
    const items = (o.items || []).map(itemFigures);
    const a = o.amounts || {};
    const gross = num(a.items) ?? items.reduce((s, it) => s + it.total, 0);
    const discount = Math.abs(num(a.discount) ?? 0);
    const delivery = num(a.delivery) ?? 0;
    const net = gross - discount;
    const units = items.reduce((s, it) => s + it.qty, 0);

    kpi.orders += 1;
    kpi.units += units;
    kpi.gross += gross;
    kpi.discount += discount;
    kpi.net += net;
    kpi.delivery += delivery;

    const r = revenue[bi];
    r.gross += gross;
    r.discount += discount;
    r.net += net;
    r.delivery += delivery;
    r.orders += 1;
    r.units += units;

    if (!whUnits.has(o.wh)) {
      whUnits.set(o.wh, zeros());
      whOrders.set(o.wh, 0);
    }
    whUnits.get(o.wh)[bi] += units;
    whOrders.set(o.wh, whOrders.get(o.wh) + 1);

    for (const it of items) {
      if (!products.has(it.name)) {
        products.set(it.name, { name: it.name, units: 0, revenue: 0, orders: 0, minPrice: null, maxPrice: null, unitsByBucket: zeros(), revenueByBucket: zeros(), unitsWithPriceByBucket: zeros() });
      }
      const p = products.get(it.name);
      p.units += it.qty;
      p.revenue += it.total;
      p.orders += 1;
      p.unitsByBucket[bi] += it.qty;
      if (it.price != null) {
        p.minPrice = p.minPrice == null ? it.price : Math.min(p.minPrice, it.price);
        p.maxPrice = p.maxPrice == null ? it.price : Math.max(p.maxPrice, it.price);
        p.revenueByBucket[bi] += it.price * it.qty;
        p.unitsWithPriceByBucket[bi] += it.qty;
      }

      const brandName = brandOf(it.name);
      const bk = brandName.toLowerCase();
      if (!brands.has(bk)) brands.set(bk, { name: brandName, units: 0, revenue: 0 });
      const b = brands.get(bk);
      b.units += it.qty;
      b.revenue += it.total;
    }

    const src = o.source === "website" ? "website" : o.source === "manual" ? "manual" : "other";
    if (!sources.has(src)) sources.set(src, { key: src, orders: 0, units: 0, net: 0 });
    const s = sources.get(src);
    s.orders += 1;
    s.units += units;
    s.net += net;
    if (src === "manual") {
      const who = (o.sold_by || "Unknown").trim() || "Unknown";
      if (!sellers.has(who)) sellers.set(who, { name: who, orders: 0, units: 0, net: 0 });
      const sl = sellers.get(who);
      sl.orders += 1;
      sl.units += units;
      sl.net += net;
    }

    const codes = [...new Set((o.coupons || []).map((c) => String(c).toLowerCase()))];
    for (const code of codes) {
      if (!coupons.has(code)) coupons.set(code, { code, orders: 0, discount: 0, net: 0 });
      const c = coupons.get(code);
      c.orders += 1;
      c.discount += discount / codes.length;
      c.net += net / codes.length;
    }

    const dcode = o.district && DISTRICTS[o.district] ? o.district : "unknown";
    if (!districts.has(dcode)) districts.set(dcode, { code: dcode, name: DISTRICTS[dcode] || "Unknown", orders: 0, units: 0, net: 0 });
    const d = districts.get(dcode);
    d.orders += 1;
    d.units += units;
    d.net += net;

    const slot = placedSlot(o.placed);
    if (slot) {
      heat[slot.day][slot.hour] += 1;
      placedCount += 1;
    }

    const bases = [...new Set(items.map((it) => splitVariant(it.name).base))].sort((x, y) => x.localeCompare(y));
    for (let i = 0; i < bases.length; i++) {
      for (let j = i + 1; j < bases.length; j++) {
        const key = `${bases[i]}\u0000${bases[j]}`;
        if (!pairs.has(key)) pairs.set(key, { a: bases[i], b: bases[j], orders: 0 });
        pairs.get(key).orders += 1;
      }
    }
  }

  // --- Products: average selling price, ranking -----------------------
  const productList = [...products.values()].map((p) => ({
    ...p,
    avgPrice: p.units ? p.revenue / p.units : null,
    priceByBucket: p.revenueByBucket.map((rev, i) => (p.unitsWithPriceByBucket[i] ? rev / p.unitsWithPriceByBucket[i] : null)),
    share: kpi.units ? p.units / kpi.units : 0,
  }));
  productList.sort((x, y) => y.units - x.units || y.revenue - x.revenue || x.name.localeCompare(y.name));

  // --- Slow movers: sold in the 90 days before, selling at half that
  // daily rate or less now. Rates per day, because the two windows are
  // different lengths (e.g. 30 days now vs the 90 days before).
  const rangeDays = daysBetween(from, to) + 1;
  const nowUnits = new Map(productList.map((p) => [p.name, p.units]));
  const slowMovers = (dataset?.recent_products || [])
    .map((r) => {
      const before = num(r.units) || 0;
      const now = nowUnits.get(r.name) || 0;
      const perDayBefore = before / 90;
      const perDayNow = now / rangeDays;
      return { name: r.name, before, now, lastBefore: r.last, perDayBefore, perDayNow, change: perDayBefore ? perDayNow / perDayBefore - 1 : 0 };
    })
    .filter((x) => x.perDayBefore > 0 && x.perDayNow <= x.perDayBefore / 2)
    .sort((x, y) => x.change - y.change || y.before - x.before || x.name.localeCompare(y.name))
    .slice(0, 10);

  // --- Variant split: products sold in 2+ variants --------------------
  const variantGroups = new Map();
  for (const p of productList) {
    const { base, variant } = splitVariant(p.name);
    if (!variantGroups.has(base)) variantGroups.set(base, { base, units: 0, variants: [] });
    const g = variantGroups.get(base);
    g.units += p.units;
    g.variants.push({ name: variant || "Standard", units: p.units });
  }
  const variants = [...variantGroups.values()]
    .filter((g) => g.variants.length >= 2 && g.units > 0)
    .map((g) => ({ ...g, variants: g.variants.sort((x, y) => y.units - x.units).map((v) => ({ ...v, share: v.units / g.units })) }))
    .sort((x, y) => y.units - x.units);

  // --- Brands, sources, coupons, districts ----------------------------
  const brandList = [...brands.values()]
    .map((b) => ({ ...b, unitShare: kpi.units ? b.units / kpi.units : 0, revenueShare: kpi.gross ? b.revenue / kpi.gross : 0 }))
    .sort((x, y) => y.units - x.units || y.revenue - x.revenue);
  const sourceOrder = ["website", "manual", "other"];
  const sourceList = sourceOrder.filter((k) => sources.has(k)).map((k) => ({ ...sources.get(k), share: kpi.orders ? sources.get(k).orders / kpi.orders : 0 }));
  const sellerList = [...sellers.values()].sort((x, y) => y.net - x.net || y.orders - x.orders);
  const couponList = [...coupons.values()].sort((x, y) => y.orders - x.orders || y.discount - x.discount);
  const districtList = [...districts.values()].sort(
    (x, y) => (x.code === "unknown") - (y.code === "unknown") || y.orders - x.orders || y.net - x.net
  );
  const pairList = [...pairs.values()].sort((x, y) => y.orders - x.orders || x.a.localeCompare(y.a)).slice(0, 10);

  // --- Warehouses: colours follow the warehouse, not its rank ---------
  const whName = new Map((warehouses || []).map((w) => [w.id, w.name]));
  const warehouseSeries = [...whUnits.entries()]
    .map(([id, values]) => ({ id, name: whName.get(id) || "Other", values, total: values.reduce((s, v) => s + v, 0), orders: whOrders.get(id) || 0 }))
    .filter((s) => s.total > 0 || s.orders > 0);

  // --- Customers -------------------------------------------------------
  const customers = (dataset?.customers || []).map((c) => {
    const n = num(c.orders) || 0;
    const span = c.first && c.last ? daysBetween(c.first, c.last) : 0;
    return { ...c, orders: n, orders_in_range: num(c.orders_in_range) || 0, spent: num(c.spent) || 0, avgGapDays: n > 1 ? span / (n - 1) : null };
  });
  const repeaters = customers.filter((c) => c.orders > 1);
  const gaps = repeaters.map((c) => c.avgGapDays).filter((g) => g != null);
  const customerStats = {
    unique: customers.length,
    repeat: repeaters.length,
    repeatRate: customers.length ? repeaters.length / customers.length : 0,
    avgGapDays: gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : null,
    top: repeaters.sort((x, y) => y.orders - x.orders || y.spent - x.spent).slice(0, 20),
  };

  return {
    buckets,
    kpi: {
      ...kpi,
      aov: kpi.orders ? kpi.net / kpi.orders : 0,
      unitsPerOrder: kpi.orders ? kpi.units / kpi.orders : 0,
    },
    revenue,
    unitsByBucket: revenue.map((r) => r.units),
    warehouseSeries,
    products: productList,
    slowMovers,
    variants,
    brands: brandList,
    sources: sourceList,
    sellers: sellerList,
    coupons: couponList,
    districts: districtList,
    heat,
    placedCount,
    pairs: pairList,
    customers: customerStats,
  };
}
