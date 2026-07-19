import { authedFetch, getSession } from "./authClient.js";

const PARENT_ID = "dispatch-capture-parent";
const REFRESH_ALARM = "refresh-warehouse-menu";

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

  let warehouses = [];
  try {
    const res = await authedFetch("/rest/v1/warehouses?select=id,name&order=name.asc");
    if (res.ok) warehouses = await res.json();
  } catch (e) {
    console.error("DispatchEZ Capture: couldn't load warehouses", e);
    return;
  }
  if (!warehouses.length) return;

  chrome.contextMenus.create({
    id: PARENT_ID,
    title: "Send to warehouse",
    contexts: ["selection"],
  });

  for (const w of warehouses) {
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

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!info.menuItemId.startsWith("wh-")) return;
  const warehouseId = info.menuItemId.slice(3);
  const orderId = (info.selectionText || "").trim();
  if (!orderId) return;

  const session = await getSession();
  if (!session) return;

  try {
    const res = await authedFetch("/rest/v1/orders", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        order_id: orderId,
        warehouse_id: warehouseId,
        dispatch_date: todayDateKey(),
        created_by: session.user_id,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body);
    }
    chrome.action.setBadgeText({ text: "✓" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
  } catch (e) {
    console.error("DispatchEZ Capture: failed to save order", e);
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#b8342a" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
  }
});
