// Themed replacements for window.alert/confirm/prompt. The browser-native
// versions render as unstyled OS dialogs that break out of the app's dark
// theme; these reuse the same overlay/card pattern as the exception dialog.
// Dynamic text is always set via textContent (never interpolated into the
// HTML string), so callers never need to escape user-provided strings.

function buildDialog(bodyHtml) {
  const overlay = document.createElement("div");
  overlay.className = "exception-overlay";
  overlay.innerHTML = `<div class="exception-dialog" role="alertdialog" aria-modal="true">${bodyHtml}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function closeOnEscapeOrBackdrop(overlay, onClose) {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) onClose();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") onClose();
  });
}

export function showAlert(message) {
  return new Promise((resolve) => {
    const overlay = buildDialog(`
      <p class="dialog-message"></p>
      <div class="exception-actions"><button class="primary" id="dialog-ok">OK</button></div>
    `);
    overlay.querySelector(".dialog-message").textContent = message;

    const close = () => {
      overlay.remove();
      resolve();
    };
    overlay.querySelector("#dialog-ok").addEventListener("click", close);
    closeOnEscapeOrBackdrop(overlay, close);
    overlay.querySelector("#dialog-ok").focus();
  });
}

export function showConfirm(message, { confirmLabel = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = buildDialog(`
      <p class="dialog-message"></p>
      <div class="exception-actions">
        <button class="ghost" id="dialog-cancel">Cancel</button>
        <button class="${danger ? "danger" : "primary"}" id="dialog-confirm"></button>
      </div>
    `);
    overlay.querySelector(".dialog-message").textContent = message;
    overlay.querySelector("#dialog-confirm").textContent = confirmLabel;

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector("#dialog-cancel").addEventListener("click", () => finish(false));
    overlay.querySelector("#dialog-confirm").addEventListener("click", () => finish(true));
    closeOnEscapeOrBackdrop(overlay, () => finish(false));
    overlay.querySelector("#dialog-cancel").focus();
  });
}

// Shown when capture_order's duplicate check finds the order_id already
// recorded. Lists where it was already captured and asks for explicit
// confirmation before recording it again — "Yes" calls capture_order a
// second time with p_force=true (see 0004_order_capture_dedupe.sql).
export function showDuplicateWarning({ orderId, matches }) {
  return new Promise((resolve) => {
    const overlay = buildDialog(`
      <h3>Possible duplicate</h3>
      <p class="dialog-message"></p>
      <div class="duplicate-matches"></div>
      <p class="dialog-message">Record it anyway?</p>
      <div class="exception-actions">
        <button class="ghost" id="dialog-cancel">No</button>
        <button class="primary" id="dialog-confirm">Yes</button>
      </div>
    `);
    overlay.querySelector(".dialog-message").textContent = `"${orderId}" is already on file:`;

    const list = overlay.querySelector(".duplicate-matches");
    for (const m of matches) {
      const row = document.createElement("div");
      row.className = "duplicate-match-row";
      const when = m.created_at ? new Date(m.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "unknown time";
      row.textContent = `${m.warehouse_name} · dispatch ${m.dispatch_date || "—"} · added ${when}${m.done ? " · done" : ""}`;
      list.appendChild(row);
    }

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector("#dialog-cancel").addEventListener("click", () => finish(false));
    overlay.querySelector("#dialog-confirm").addEventListener("click", () => finish(true));
    closeOnEscapeOrBackdrop(overlay, () => finish(false));
    overlay.querySelector("#dialog-cancel").focus();
  });
}

// Combined stock-quantity + expected-date editor for a pre-book batch —
// one dialog instead of two separate prompts, since the compact batch row
// only has room for a single "edit" icon button.
export function showEditBatch({ stock = 0, date = "" } = {}) {
  return new Promise((resolve) => {
    const overlay = buildDialog(`
      <h3>Edit pre-book</h3>
      <label class="field-label" for="dialog-stock">Stock quantity</label>
      <input id="dialog-stock" type="number" min="0" style="width:100%;margin-bottom:12px" />
      <label class="field-label" for="dialog-date">Expected date</label>
      <input id="dialog-date" type="date" style="width:100%" />
      <div class="exception-actions">
        <button class="ghost" id="dialog-cancel">Cancel</button>
        <button class="primary" id="dialog-confirm">Save</button>
      </div>
    `);
    const stockInput = overlay.querySelector("#dialog-stock");
    const dateInput = overlay.querySelector("#dialog-date");
    stockInput.value = stock;
    dateInput.value = date;

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector("#dialog-cancel").addEventListener("click", () => finish(null));
    overlay.querySelector("#dialog-confirm").addEventListener("click", () => finish({ stock: stockInput.value, date: dateInput.value }));
    closeOnEscapeOrBackdrop(overlay, () => finish(null));
    stockInput.focus();
    stockInput.select();
  });
}

// Paste an order copied from Zagle (select the order card → copy) and see
// what was read before saving it. `parse` is parseOrderText; `expectOrderId`
// (optional) is the order this paste must belong to, for "Add details".
// Resolves { orderId, details } on Save, or null on Cancel.
export function showOrderPaste({ parse, normalize, title = "Paste order from Zagle", initialText = "", expectOrderId = null, saveLabel = "Save" }) {
  return new Promise((resolve) => {
    const overlay = buildDialog(`
      <h3></h3>
      <p class="dialog-message paste-help">On Zagle, select the whole order card, copy it, and paste it here. Works with text copied on a computer or a phone.</p>
      <textarea id="paste-text" rows="7" placeholder="WOO-42630&#10;Nov 6, 2026, 1:14 AM&#10;Website&#10;…"></textarea>
      <div class="paste-preview" aria-live="polite"></div>
      <div class="exception-actions">
        <button class="ghost" id="dialog-cancel">Cancel</button>
        <button class="primary" id="dialog-confirm" disabled></button>
      </div>
    `);
    overlay.querySelector(".exception-dialog").classList.add("paste-dialog");
    overlay.querySelector("h3").textContent = title;
    overlay.querySelector("#dialog-confirm").textContent = saveLabel;
    const textEl = overlay.querySelector("#paste-text");
    const preview = overlay.querySelector(".paste-preview");
    const saveBtn = overlay.querySelector("#dialog-confirm");
    textEl.value = initialText;
    let current = null;

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const money = (v) => (v == null ? "—" : `৳${Math.round(v).toLocaleString("en-IN")}`);

    const update = () => {
      preview.replaceChildren();
      current = null;
      saveBtn.disabled = true;
      if (!textEl.value.trim()) return;
      const r = parse(textEl.value);
      const d = r.details;
      if (!r.orderId) {
        preview.appendChild(el("p", "paste-warn", r.warnings[0] || "This doesn't look like a Zagle order."));
        return;
      }
      if (expectOrderId && normalize(r.orderId) !== normalize(expectOrderId)) {
        preview.appendChild(el("p", "paste-warn", `This is order ${r.orderId}, not ${expectOrderId}. Copy the right order and paste again.`));
        return;
      }
      const head = el("div", "paste-head");
      head.appendChild(el("strong", null, r.orderId));
      const src = d.source === "manual" ? `Manual${d.sold_by ? ` · sold by ${d.sold_by}` : ""}` : d.source === "website" ? "Website" : "Source unknown";
      head.appendChild(el("span", "paste-muted", [src, d.status].filter(Boolean).join(" · ")));
      preview.appendChild(head);
      preview.appendChild(el("div", "paste-muted", [d.customer_name, d.phone, d.address || "No address"].filter(Boolean).join(" · ")));

      const list = el("div", "paste-items");
      for (const it of d.items) {
        const row = el("div", "paste-item");
        row.appendChild(el("span", null, it.name));
        row.appendChild(el("span", "paste-num", `${it.qty} × ${money(it.unit_price)}`));
        list.appendChild(row);
      }
      if (!d.items.length) list.appendChild(el("div", "paste-muted", "No products read."));
      preview.appendChild(list);

      const a = d.amounts;
      const sums = [["Items", a.items], ["Discount", a.discount], ["Delivery", a.delivery], ["Total", a.total]]
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k} ${k === "Discount" ? "−" : ""}${money(v)}`);
      preview.appendChild(el("div", "paste-muted", sums.join(" · ") || "No amounts read."));
      for (const w of r.warnings) preview.appendChild(el("p", "paste-warn", w));

      current = { orderId: r.orderId, details: d };
      saveBtn.disabled = !d.items.length;
    };

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };
    textEl.addEventListener("input", update);
    overlay.querySelector("#dialog-cancel").addEventListener("click", () => finish(null));
    saveBtn.addEventListener("click", () => current && finish(current));
    closeOnEscapeOrBackdrop(overlay, () => finish(null));
    update();
    textEl.focus();
  });
}
