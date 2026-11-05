import { authedFetch, getSession } from "./authClient.js";

const PARENT_ID = "dispatch-capture-parent";
const REFRESH_ALARM = "refresh-warehouse-menu";
const PENDING_CAPTURE_KEY = "pendingCapture";

let warehousesCache = [];

function todayDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function rebuildMenu() {
  await chrome.contextMenus.removeAll();

  const session = await getSession();
  if (!session) return; // not signed in — popup will prompt

  try {
    const res = await authedFetch("/rest/v1/warehouses?select=id,name&order=name.asc");
    warehousesCache = res.ok ? await res.json() : [];
  } catch (e) {
    console.error("DispatchEZ Capture: couldn't load warehouses", e);
    return;
  }
  if (!warehousesCache.length) return;

  chrome.contextMenus.create({
    id: PARENT_ID,
    title: "Send to warehouse",
    contexts: ["selection"],
  });

  for (const w of warehousesCache) {
    chrome.contextMenus.create({
      id: `wh-${w.id}`,
      parentId: PARENT_ID,
      title: w.name,
      contexts: ["selection"],
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  rebuildMenu();
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 30 });
});
chrome.runtime.onStartup.addListener(rebuildMenu);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) rebuildMenu();
});

// Popup calls this after a successful sign-in so the menu appears
// immediately instead of waiting for the next alarm tick.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "refresh-menu") rebuildMenu();
});

function showBadge(text, color) {
  if (color) chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), text === "!" ? 2500 : 1500);
}

// Calls the capture_order RPC (see supabase/migrations/0004_order_capture_dedupe.sql).
// With force=false it only inserts when no order with this order_id exists
// yet; otherwise it returns the existing matches without writing anything,
// so the duplicate check always runs against the live table, not a local
// cache the extension might be out of sync with.
async function captureOrder({ orderId, warehouseId, dispatchDate, force }) {
  const res = await authedFetch("/rest/v1/rpc/capture_order", {
    method: "POST",
    body: JSON.stringify({
      p_order_id: orderId,
      p_warehouse_id: warehouseId,
      p_dispatch_date: dispatchDate,
      p_force: force,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const [result] = await res.json();
  return result;
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!info.menuItemId.startsWith("wh-")) return;
  const warehouseId = info.menuItemId.slice(3);
  const orderId = (info.selectionText || "").trim();
  if (!orderId) return;

  const session = await getSession();
  if (!session) return;

  try {
    const result = await captureOrder({ orderId, warehouseId, dispatchDate: todayDateKey(), force: false });
    if (result.inserted) {
      showBadge("✓", "#2e7d5b");
      return;
    }

    // Duplicate found — hand off to a confirmation window instead of
    // silently recording or silently dropping it.
    const warehouseName = warehousesCache.find((w) => w.id === warehouseId)?.name || "this warehouse";
    await chrome.storage.local.set({
      [PENDING_CAPTURE_KEY]: {
        orderId,
        warehouseId,
        warehouseName,
        dispatchDate: todayDateKey(),
        matches: result.existing_matches || [],
      },
    });
    await chrome.windows.create({
      url: chrome.runtime.getURL("confirm.html"),
      type: "popup",
      width: 380,
      height: 460,
    });
  } catch (e) {
    console.error("DispatchEZ Capture: failed to save order", e);
    showBadge("!", "#b8342a");
  }
});
