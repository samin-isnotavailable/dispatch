import { authedFetch } from "./authClient.js";

const PENDING_CAPTURE_KEY = "pendingCapture";
const app = document.getElementById("app");

function formatWhen(iso) {
  if (!iso) return "unknown time";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function forceCapture(pending) {
  const res = await authedFetch("/rest/v1/rpc/capture_order", {
    method: "POST",
    body: JSON.stringify({
      p_order_id: pending.orderId,
      p_warehouse_id: pending.warehouseId,
      p_dispatch_date: pending.dispatchDate,
      p_force: true,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function render() {
  const { [PENDING_CAPTURE_KEY]: pending } = await chrome.storage.local.get([PENDING_CAPTURE_KEY]);
  if (!pending) {
    app.innerHTML = `<p>Nothing to confirm — this window can be closed.</p>`;
    return;
  }

  app.innerHTML = `
    <h1>Possible duplicate</h1>
    <p><span class="order-id"></span> is already on file. Sending to <strong></strong> anyway?</p>
    <div class="matches"></div>
    <div class="actions">
      <button id="no">No</button>
      <button id="yes">Yes, record it</button>
    </div>
    <p class="status" id="status" style="display:none"></p>
  `;
  app.querySelector(".order-id").textContent = pending.orderId;
  app.querySelector("p strong").textContent = pending.warehouseName;

  const matchesEl = app.querySelector(".matches");
  for (const m of pending.matches) {
    const row = document.createElement("div");
    row.className = "match-row";
    row.textContent = `${m.warehouse_name} · dispatch ${m.dispatch_date || "—"} · added ${formatWhen(m.created_at)}${m.done ? " · done" : ""}`;
    matchesEl.appendChild(row);
  }

  const statusEl = app.querySelector("#status");
  const noBtn = app.querySelector("#no");
  const yesBtn = app.querySelector("#yes");

  noBtn.addEventListener("click", async () => {
    await chrome.storage.local.remove(PENDING_CAPTURE_KEY);
    window.close();
  });

  yesBtn.addEventListener("click", async () => {
    noBtn.disabled = true;
    yesBtn.disabled = true;
    yesBtn.textContent = "Saving…";
    try {
      await forceCapture(pending);
      chrome.action.setBadgeBackgroundColor({ color: "#2e7d5b" });
      chrome.action.setBadgeText({ text: "✓" });
      setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
      statusEl.textContent = "Saved.";
      statusEl.className = "status success";
      statusEl.style.display = "block";
      await chrome.storage.local.remove(PENDING_CAPTURE_KEY);
      setTimeout(() => window.close(), 600);
    } catch (e) {
      statusEl.textContent = e.message || "Couldn't save — try again.";
      statusEl.className = "status error";
      statusEl.style.display = "block";
      noBtn.disabled = false;
      yesBtn.disabled = false;
      yesBtn.textContent = "Yes, record it";
    }
  });
}

render();
