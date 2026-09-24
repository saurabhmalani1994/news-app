// S24: a brief, quiet confirmation with an optional Undo, shared by every action that
// can be undone (save, thumbs, mute, boost). One at a time; showing a new one replaces
// whatever is on screen. Static chrome, app/build.py TOAST: #toast, always present,
// empty and hidden until shown.
const root = document.getElementById("toast");
const text = document.getElementById("toast-text");
const action = document.getElementById("toast-action");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const DURATION_MS = 5000;

let hideTimer = 0;
let dismissTimer = 0;

/** Shows `message`, with an "Undo" button when `onAction` is given. */
export function showToast(message, { actionLabel = "Undo", onAction = null } = {}) {
  clearTimeout(hideTimer);
  clearTimeout(dismissTimer);
  root.classList.remove("is-open");
  text.textContent = message;
  action.hidden = !onAction;
  action.textContent = actionLabel;
  action.onclick = () => {
    hideToast();
    onAction?.();
  };
  root.hidden = false;
  void root.offsetWidth; // restarts the transition if a toast is already showing
  root.classList.add("is-open");
  dismissTimer = setTimeout(hideToast, DURATION_MS);
}

export function hideToast() {
  clearTimeout(dismissTimer);
  root.classList.remove("is-open");
  const done = () => { root.hidden = true; };
  if (reduced.matches) done();
  else hideTimer = setTimeout(done, 200);
}
