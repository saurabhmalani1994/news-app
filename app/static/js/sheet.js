// S24: the reusable bottom sheet, an NYT-style overflow/share sheet. Everything about
// being a sheet, the scrim, the drag handle, the focus trap, the back button and the
// swipe or scrim dismiss, `prefers-reduced-motion`, lives here once: this slice's own
// story-actions menu opens one, and S12's why-this sheet and S14's coverage view will
// each open their own content in it next.
//
// API (one call to open, one to close):
//   openSheet({ title, content, opener }) -> void
//     title: plain text label (sr and visual). content: a Node or array of Nodes to
//     show in the body; the caller builds it and owns its own click handling.
//     opener: the element to refocus on close (defaults to document.activeElement).
//   closeSheet() -> void, a no-op if nothing is open.
//   isSheetOpen() -> boolean
//
// Static chrome, app/build.py SHEET: #sheet-root (scrim + panel), always present,
// empty and hidden until opened. Closing always goes through history.back(): opening
// pushes one state, so the browser/hardware back button closes the sheet on its own,
// same as S25's reader does for its own layer.
const root = document.getElementById("sheet-root");
const scrim = document.getElementById("sheet-scrim");
const panel = document.getElementById("sheet");
const drag = document.getElementById("sheet-drag");
const closeButton = document.getElementById("sheet-close");
const label = document.getElementById("sheet-label");
const body = document.getElementById("sheet-body");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DRAG_DISMISS_PX = 90;
const underneath = () => [document.querySelector(".screens"), document.querySelector(".bottom-nav"),
  document.getElementById("reader")].filter((el) => el && !el.hidden);

let current = null; // { token }
let token = 0;
let opener = null;
let hideTimer = 0;
let dragFromY = null;

function focusables() {
  return [...panel.querySelectorAll(FOCUSABLE)];
}

function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSheet();
    return;
  }
  if (event.key !== "Tab") return;
  const items = focusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function isSheetOpen() {
  return current !== null;
}

export function openSheet({ title = "", content, opener: openedFrom = null } = {}) {
  clearTimeout(hideTimer);
  label.textContent = title;
  body.replaceChildren(...(Array.isArray(content) ? content : [content]));
  opener = openedFrom || document.activeElement;
  token += 1;
  current = { token };
  for (const el of underneath()) el.inert = true;
  root.hidden = false;
  panel.style.transform = "";
  history.pushState({ almanacSheet: token }, "");
  const focusFirst = focusables()[0] || panel;
  const reveal = () => root.classList.add("is-open");
  if (reduced.matches) reveal();
  else requestAnimationFrame(() => requestAnimationFrame(reveal));
  focusFirst.focus({ preventScroll: true });
  document.addEventListener("keydown", onKeydown);
}

/** The visible half: hides the layer once the close transition (or none, reduced
 * motion) has run. Never touches history; closeSheet() and the popstate listener
 * decide when this runs. */
function dismiss() {
  if (!current) return;
  current = null;
  root.classList.remove("is-open");
  document.removeEventListener("keydown", onKeydown);
  for (const el of underneath()) el.inert = false;
  const done = () => {
    if (!current) {
      root.hidden = true;
      body.replaceChildren();
      panel.style.transform = "";
    }
  };
  if (reduced.matches) done();
  else hideTimer = setTimeout(done, 220);
  opener?.focus?.({ preventScroll: true });
  opener = null;
}

/** Closes the sheet from inside (a menu item, the scrim, a completed swipe): steps
 * back through the history entry openSheet pushed, which fires popstate and dismisses
 * it there, the one path every close (including the back button itself) goes through. */
export function closeSheet() {
  if (!current) return;
  if (history.state?.almanacSheet === current.token) history.back();
  else dismiss();
}

addEventListener("popstate", () => {
  if (current) dismiss();
});

scrim.addEventListener("click", closeSheet);
closeButton.addEventListener("click", closeSheet);

// Swipe down to dismiss, from the drag handle and label row only, so a tap on a menu
// item never gets mistaken for the start of a drag.
function onPointerDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  dragFromY = event.clientY;
  panel.style.transition = "none";
  drag.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  if (dragFromY === null) return;
  const dy = Math.max(0, event.clientY - dragFromY);
  panel.style.transform = `translateY(${dy}px)`;
}

function onPointerUp(event) {
  if (dragFromY === null) return;
  const dy = Math.max(0, event.clientY - dragFromY);
  dragFromY = null;
  panel.style.transition = "";
  if (dy > DRAG_DISMISS_PX) closeSheet();
  else panel.style.transform = "";
}

drag.addEventListener("pointerdown", onPointerDown);
drag.addEventListener("pointermove", onPointerMove);
drag.addEventListener("pointerup", onPointerUp);
drag.addEventListener("pointercancel", onPointerUp);
