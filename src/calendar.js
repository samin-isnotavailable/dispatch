// Calendar picker in the app's own style (the browser's date box looks
// different on every phone). One month at a time, Sunday first.
//
//   pickDate({ value, min, max, title })        → "YYYY-MM-DD" or null
//   pickRange({ from, to, min, max, title })    → { from, to } or null
//
// Dates are "YYYY-MM-DD" strings, worked out in UTC so the device's time
// zone can never shift a day.

import { buildDialog, closeOnEscapeOrBackdrop } from "./dialogs.js";
import { iconChevronLeft, iconChevronRight } from "./icons.js";

const DAY = 86400000;
const toMs = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const toKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const monthTitle = (y, m) => new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
// Today on this device's calendar (not UTC, which is 6 hours behind Dhaka).
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const formatKey = (k) => new Date(toMs(k)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export const pickDate = (opts = {}) => open({ ...opts, range: false });
export const pickRange = (opts = {}) => open({ ...opts, range: true });

function open({ range, value = null, from = null, to = null, min = null, max = null, title = "" }) {
  return new Promise((resolve) => {
    let start = range ? from : value;
    let end = range ? to : value;
    let picking = false; // range: first tap made, waiting for the second
    const first = start || max || todayKey();
    let y = +first.slice(0, 4);
    let m = +first.slice(5, 7) - 1;

    const overlay = buildDialog(`
      <h3 class="cal-title"></h3>
      <div class="cal-head">
        <button type="button" class="ghost icon-btn" data-nav="-1" aria-label="Previous month">${iconChevronLeft}</button>
        <strong class="cal-month" aria-live="polite"></strong>
        <button type="button" class="ghost icon-btn" data-nav="1" aria-label="Next month">${iconChevronRight}</button>
      </div>
      <div class="cal-grid" role="grid"></div>
      <p class="cal-summary"></p>
      <div class="exception-actions">
        ${range ? `<button type="button" class="ghost" id="cal-cancel">Cancel</button><button type="button" class="primary" id="cal-done">Done</button>` : `<button type="button" class="ghost" id="cal-cancel">Cancel</button>`}
      </div>`);
    overlay.querySelector(".exception-dialog").classList.add("cal-dialog");
    const titleEl = overlay.querySelector(".cal-title");
    if (title) titleEl.textContent = title;
    else titleEl.remove();
    const grid = overlay.querySelector(".cal-grid");
    const summary = overlay.querySelector(".cal-summary");
    const doneBtn = overlay.querySelector("#cal-done");

    const draw = () => {
      overlay.querySelector(".cal-month").textContent = monthTitle(y, m);
      const firstMs = Date.UTC(y, m, 1);
      const lead = new Date(firstMs).getUTCDay();
      const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const weeks = Math.ceil((lead + days) / 7);
      let html = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => `<span class="cal-dow">${d}</span>`).join("");
      for (let i = 0; i < weeks * 7; i++) {
        const k = toKey(firstMs + (i - lead) * DAY);
        const outside = i < lead || i >= lead + days;
        const off = (min && k < min) || (max && k > max);
        const cls = ["cal-day"];
        if (outside) cls.push("outside");
        if (start && end && k >= start && k <= end) cls.push("in-range");
        if (k === start) cls.push("edge", "edge-start");
        if (k === end) cls.push("edge", "edge-end");
        if (k === todayKey()) cls.push("today");
        html += `<button type="button" class="${cls.join(" ")}" data-key="${k}" ${off ? "disabled" : ""} aria-pressed="${k === start || k === end}">${+k.slice(8)}</button>`;
      }
      grid.innerHTML = html;
      summary.textContent = !start ? (range ? "Tap the first day, then the last day." : "") : range && picking ? `${formatKey(start)} – tap the last day` : start === end ? formatKey(start) : `${formatKey(start)} – ${formatKey(end)}`;
      if (doneBtn) doneBtn.disabled = !start;
    };

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.addEventListener("click", (e) => {
      const nav = e.target.closest("[data-nav]");
      if (nav) {
        m += Number(nav.dataset.nav);
        if (m < 0) (m = 11), y--;
        if (m > 11) (m = 0), y++;
        draw();
        return;
      }
      const day = e.target.closest(".cal-day");
      if (!day || day.disabled) return;
      const k = day.dataset.key;
      if (!range) return finish(k);
      if (!picking) {
        start = end = k;
        picking = true;
      } else {
        [start, end] = k < start ? [k, start] : [start, k];
        picking = false;
      }
      draw();
    });
    overlay.querySelector("#cal-cancel").addEventListener("click", () => finish(null));
    doneBtn?.addEventListener("click", () => start && finish({ from: start, to: end }));
    closeOnEscapeOrBackdrop(overlay, () => finish(null));
    draw();
    overlay.querySelector(".cal-day:not([disabled])")?.focus();
  });
}
