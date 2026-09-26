// S33: the Live panel's own overrides menu (R22), opened from its header's overflow
// button (tabs.js fillLivePanel) through the reusable S24 sheet (sheet.js). Owner
// only: ai/gate.js reserves the whole live_overrides path, so this is the one place
// these fields are ever written, the same as mute and boost (actions/mute-boost.js)
// go through story-actions.js rather than the AI proposal path.
import { openSheet, closeSheet } from "./sheet.js";
import { showToast } from "./toast.js";
import { ProfileStore } from "./profile/store.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { rankPages, pageOptions } from "./passes.js";
import {
  overridesOf, withEventPinned, withEventUnpinned, withEventBlocked,
} from "./live.js";
import { currentProfile, syncLiveTab, fillLivePanel } from "./tabs.js";
import { pageInput } from "./page-input.js";

let cachedInput = null;
function getInput() {
  if (!cachedInput) {
    try {
      cachedInput = pageInput();
    } catch {
      cachedInput = { pool: { articles: [], clusters: [] }, events: [] };
    }
  }
  return cachedInput;
}

let schemaPromise = null;
function loadSchema() {
  if (!schemaPromise) {
    schemaPromise = fetch("profile.schema.json", { credentials: "same-origin" })
      .then((r) => { if (!r.ok) throw new Error(`schema ${r.status}`); return r.json(); });
  }
  return schemaPromise;
}

let storeInstance = null;
async function getStore() {
  if (!storeInstance) {
    storeInstance = new ProfileStore({ storage: window.localStorage, schema: await loadSchema(), seedDefault: buildDefaultProfile });
  }
  return storeInstance;
}

function menuItem(action, text, pressed) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "sheet-item";
  node.dataset.action = action;
  if (pressed !== undefined) node.setAttribute("aria-pressed", String(pressed));
  const label = document.createElement("span");
  label.className = "sheet-item-text";
  label.textContent = text;
  node.append(label);
  return node;
}

function openLiveMenu(button) {
  const event = { id: button.dataset.eventId, label: button.dataset.eventLabel };
  const overrides = overridesOf(currentProfile());
  const pinned = overrides.pinned_event_id === event.id;
  const menu = document.createElement("div");
  menu.className = "sheet-menu";
  menu.setAttribute("role", "menu");
  menu.append(
    menuItem("pin", pinned ? "Unpin from Live" : "Pin to Live", pinned),
    menuItem("block", `Block "${event.label}"`),
  );
  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".sheet-item[data-action]");
    if (!item) return;
    handleAction(item.dataset.action, event, pinned);
  });
  openSheet({ title: "Live coverage", content: menu, opener: button });
}

/** Rebuilds the Live tab's own chrome and panel content for a saved profile: the tab
 * might now name a different event, the same event, or none at all (a block just
 * removed the only live one). Unlike a mute or a boost (story-actions.js
 * rerenderAfterProfileChange, which only ever reorders or drops rows already in a
 * panel), a pin or a block can swap the panel to an entirely different event's
 * clusters, ids the panel has never held a row for, so this always rebuilds from
 * Today's own rows fresh rather than re-tiering whatever is already there. */
function refreshLivePanel(profile) {
  window.almanacProfile = profile;
  const event = syncLiveTab(profile);
  const panel = document.getElementById("section-live");
  if (!panel) return;
  panel.replaceChildren();
  if (!event) return;
  const input = getInput();
  const pages = rankPages(input.pool, profile, input.now, pageOptions(input));
  const liveSection = pages.sections.find((s) => s.id === "live");
  const todayRows = [...document.querySelectorAll("#section-today li.story[data-sid]")];
  const byId = new Map(todayRows.map((li) => [li.dataset.sid, li]));
  const rows = new Map(liveSection.stories.filter((s) => byId.has(s.id)).map((s) => [s.id, byId.get(s.id).cloneNode(true)]));
  fillLivePanel(panel, liveSection, rows, input);
}

async function handleAction(action, event, wasPinned) {
  let store;
  try {
    store = await getStore();
  } catch {
    showToast("Couldn't save that. Try again once you're online.");
    return;
  }
  const before = store.current();
  const draft = action === "pin"
    ? (wasPinned ? withEventUnpinned(before) : withEventPinned(before, event))
    : withEventBlocked(before, event);
  if (!draft) {
    closeSheet();
    showToast("Already set.");
    return;
  }
  const beforeVersion = before.profile_version;
  const result = store.save(draft);
  closeSheet();
  if (!result.ok) {
    showToast("Couldn't save that change.");
    return;
  }
  refreshLivePanel(result.profile);
  const message = action === "pin" ? (wasPinned ? "Unpinned from Live" : "Pinned to Live") : `Blocked "${event.label}"`;
  showToast(message, {
    onAction: () => {
      const reverted = store.revert(beforeVersion);
      if (reverted.ok) refreshLivePanel(reverted.profile);
    },
  });
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".live-overflow");
  if (!button) return;
  event.preventDefault();
  openLiveMenu(button);
});
