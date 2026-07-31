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
