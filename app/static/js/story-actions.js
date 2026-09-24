// S24: per-story actions (DESIGN-v1.1 "Story actions", R19). The quiet three-dot
// button every card carries (app/build.py STORY) opens the reusable sheet (sheet.js)
// with Open at source, Save, thumbs up/down, Mute source, Mute topic, Boost topic and
// Why this (S12, present but hidden behind WHY_THIS_ENABLED until that slice lands).
//
// Save and thumbs write to actions/store.js (IndexedDB, local only, never sent
// anywhere, never touches profile.json: R19 holds because thumbs.js never imports
// ProfileStore at all). Mute and boost go through the S10 ProfileStore, exactly one
// new version each; the affected panel re-ranks in place with the scroll anchored
// (actions/scroll-anchor.js) and a quiet toast offers Undo, which reverts to the
// version saved just before the action, itself one more ordinary append.
import { openSheet, closeSheet } from "./sheet.js";
import { showToast } from "./toast.js";
import { ProfileStore } from "./profile/store.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { nowIso } from "./profile/time.js";
import { rankPages } from "./passes.js";
import { retier, placeOtherSide } from "./tiers.js";
import { storyAttributes, domPlacement } from "./actions/context.js";
import { savesStore, thumbsStore } from "./actions/store.js";
import { toggleSave, undoSave } from "./actions/saves.js";
import { toggleThumb, undoThumb } from "./actions/thumbs.js";
import { withSourceMuted, withTopicMuted, withTopicBoosted } from "./actions/mute-boost.js";
import { anchoredRerender } from "./actions/scroll-anchor.js";
import { renderWhyContent } from "./why-this.js";
// S15: "opened" (R17, R23), and the seen-penalty term (history/penalty.js) so the
// device re-rank after a mute or boost, and the why-this sheet, agree with what the
// page already shows.
import { openedStore } from "./history/store.js";
import { recordOpened } from "./history/record.js";
import { readSummary, summaryToHistory, noteSeen } from "./history/summary.js";
import { seenPenaltyTerm } from "./history/penalty.js";

function currentHistoryTerms() {
  return [seenPenaltyTerm(summaryToHistory(readSummary(window.localStorage)))];
}

// S12: the why-this sheet reads the same rankPages() output the device re-rank and the
// build already agree on, so the item can stay on from here.
const WHY_THIS_ENABLED = true;

// Generic geometric glyphs (Material-style single path, no text, no brand marks), the
// same filled-icon convention as the bottom nav and the reader bar (app/build.py).
const ICONS = Object.freeze({
  open: "M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3zM19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2z",
  save: "M6.2 2.6h11.6c.5 0 .9.4.9.9v18.1L12 17.1l-6.7 4.5V3.5c0-.5.4-.9.9-.9z",
  up: "M9 21h8.1c.8 0 1.5-.5 1.8-1.3l2.4-5.6c.1-.2.1-.4.1-.6v-1.8c0-1-.8-1.8-1.8-1.8h-5.1l.7-3.6.1-.5c0-.4-.2-.8-.4-1.1L13.1 3 8.3 7.8c-.3.3-.5.7-.5 1.1V19c0 1.1.9 2 2 2zM3 10h3v11H3z",
  down: "M15 3H6.9c-.8 0-1.5.5-1.8 1.3L2.7 9.9c-.1.2-.1.4-.1.6v1.8c0 1 .8 1.8 1.8 1.8h5.1l-.7 3.6-.1.5c0 .4.2.8.4 1.1l.8 1.7 4.8-4.8c.3-.3.5-.7.5-1.1V5c0-1.1-.9-2-2-2zM21 14h-3V3h3z",
  mute: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM4 12c0-4.4 3.6-8 8-8 1.8 0 3.5.6 4.9 1.7L5.7 16.9C4.6 15.5 4 13.8 4 12zm8 8c-1.8 0-3.5-.6-4.9-1.7L18.3 7.1C19.4 8.5 20 10.2 20 12c0 4.4-3.6 8-8 8z",
  boost: "M4 14l1.4 1.4L11 9.8V20h2V9.8l5.6 5.6L20 14l-8-8-8 8z",
  why: "M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8z",
  more: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
});

let cachedInput = null;
function getInput() {
  if (!cachedInput) {
    try {
      cachedInput = JSON.parse(document.getElementById("rank-input").content.textContent);
    } catch {
      cachedInput = { pool: { articles: [], clusters: [] } };
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

function svgIcon(d) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "sheet-item-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function menuItem({ action, icon, text, pressed, hidden, href }) {
  const node = document.createElement(href ? "a" : "button");
  node.className = "sheet-item";
  node.dataset.action = action;
  if (href) {
    node.setAttribute("href", href);
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  } else {
    node.type = "button";
  }
  if (pressed !== undefined) node.setAttribute("aria-pressed", String(pressed));
  if (hidden) node.hidden = true;
  const text_ = document.createElement("span");
  text_.className = "sheet-item-text";
  text_.textContent = text;
  node.append(svgIcon(icon), text_);
  return node;
}

/** What the card itself knows about a story, for Save and for the "Open at source"
 * item: its own DOM row, no ranking input needed. */
function cardFacts(li, input) {
  const link = li.querySelector(".story-link");
  const image = input.images?.[li.dataset.sid];
  return {
    title: li.querySelector(".headline")?.textContent || "",
    url: link?.getAttribute("href") || "",
    has_body: Boolean(link?.dataset.body),
    image: image?.hero?.[0] || image?.thumb || null,
  };
}

async function openStoryMenu(li) {
  const input = getInput();
  const sid = li.dataset.sid;
  const attrs = storyAttributes(input, sid);
  const facts = cardFacts(li, input);
  const [saved, thumb] = await Promise.all([savesStore.get(sid), thumbsStore.get(sid)]);

  const items = [];
  if (facts.url) items.push(menuItem({ action: "open", icon: ICONS.open, text: "Open at source", href: facts.url }));
  items.push(menuItem({ action: "save", icon: ICONS.save, text: saved ? "Saved" : "Save", pressed: Boolean(saved) }));
  items.push(menuItem({ action: "up", icon: ICONS.up, text: "Thumbs up", pressed: thumb?.direction === "up" }));
  items.push(menuItem({ action: "down", icon: ICONS.down, text: "Thumbs down", pressed: thumb?.direction === "down" }));
  items.push(menuItem({ action: "mute-source", icon: ICONS.mute, text: attrs.source_name ? `Mute ${attrs.source_name}` : "Mute source" }));
  items.push(menuItem({ action: "mute-topic", icon: ICONS.mute, text: "Mute topic" }));
  items.push(menuItem({ action: "boost-topic", icon: ICONS.boost, text: "Boost topic" }));
  items.push(menuItem({ action: "why", icon: ICONS.why, text: "Why this", hidden: !WHY_THIS_ENABLED }));

  const menu = document.createElement("div");
  menu.className = "sheet-menu";
  menu.setAttribute("role", "menu");
  menu.append(...items);
  menu.addEventListener("click", (event) => {
    const button = event.target.closest(".sheet-item[data-action]");
    if (!button) return;
    if (button.tagName === "A") {
      // "Open at source": let the link navigate (target="_blank"); record opened (S15).
      recordOpened(openedStore, sid, { ...attrs, ...facts }, nowIso, (snapshot) => noteSeen(window.localStorage, "opened", snapshot.id, snapshot.time)).catch(() => {});
      closeSheet();
      return;
    }
    event.preventDefault();
    handleAction(button.dataset.action, { li, sid, attrs, facts });
  });
  openSheet({ title: "Story actions", content: menu, opener: li.querySelector(".story-overflow") });
}

function handleAction(action, ctx) {
  if (action === "save") return doSave(ctx);
  if (action === "up" || action === "down") return doThumb(action, ctx);
  if (action === "mute-source") return doMuteSource(ctx);
  if (action === "mute-topic") return doMuteTopic(ctx);
  if (action === "boost-topic") return doBoostTopic(ctx);
  if (action === "why") return doWhy(ctx);
  return null;
}

/** S12: the story on the tab it is shown on, ranked with the device's current profile
 * (the same call rerenderAfterProfileChange makes after a mute or boost), so the sheet
 * reads identically whether the page is fresh off the build or already re-ranked. A
 * section tab only ever runs its own SECTION_PASSES (passes.js), so a story's pass
 * entries here are the ones that actually placed it on the tab it was opened from. */
async function storyForWhy(li, sid) {
  const input = getInput();
  let profile;
  try {
    profile = (await getStore()).current();
  } catch {
    profile = buildDefaultProfile(input.now);
  }
  const pages = rankPages(input.pool, profile, input.now, { buckets: input.buckets, leans: input.leans, names: input.names, health: input.health, events: input.events || [], terms: currentHistoryTerms() });
  const { tab } = domPlacement(li);
  const list = tab === "today" ? pages.today : pages.sections.find((s) => s.id === tab)?.stories || pages.today;
  const story = list.find((s) => s.id === sid) || pages.today.find((s) => s.id === sid);
  return { story, profile, input };
}

// A taller sheet swapped in while the shorter one is still on screen would change the
// panel's own rendered height mid-frame: a real reflow, not the transform-only slide,
// so it would count as layout shift. Waiting for #sheet-root to actually go hidden
// (sheet.js's dismiss() sets that only once the close transition has fully run, or
// straight away under reduced motion) means the why-this sheet's first paint is a
// fresh appearance, never a visible one changing shape. That flag flipping true is not
// enough by itself: setting it and reopening can both happen before the browser ever
// paints a frame with the sheet actually gone, which the layout-shift tracker reads
// the same as one visible box silently changing shape. The extra double rAF (the same
// wait sheet.js's own reveal uses to guarantee a paint lands first) makes sure a hidden
// frame is actually painted before the next sheet opens.
function paint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function sheetClosed() {
  const root = document.getElementById("sheet-root");
  if (!root.hidden) {
    await new Promise((resolve) => {
      const check = () => (root.hidden ? resolve() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
  }
  await paint();
}

async function doWhy({ li, sid, facts }) {
  const opener = li.querySelector(".story-overflow");
  const { story, profile, input } = await storyForWhy(li, sid);
  closeSheet();
  if (!story) return;
  const nowMs = typeof input.now === "number" ? input.now : Date.parse(input.now) || Date.now();
  const content = renderWhyContent({ story, profile, nowMs, names: input.names || {}, headline: facts.title });
  await sheetClosed();
  openSheet({ title: "Why this", content, opener });
}

async function doSave({ sid, attrs, facts }) {
  const result = await toggleSave(savesStore, sid, { ...attrs, ...facts }, nowIso);
  closeSheet();
  showToast(result.action === "added" ? "Saved" : "Removed from Saved", {
    onAction: () => undoSave(savesStore, sid, result.action, result.previous),
  });
}

async function doThumb(direction, { sid, attrs }) {
  const result = await toggleThumb(thumbsStore, sid, direction, attrs, nowIso);
  closeSheet();
  const message = result.action === "cleared" ? "Thumb removed" : direction === "up" ? "Marked helpful" : "Marked not helpful";
  showToast(message, { onAction: () => undoThumb(thumbsStore, sid, result.previous) });
}

// --- Mute and boost: through ProfileStore, one version, an anchored re-rank, Undo. ---

function panelOf(li) {
  return li.closest(".panel") || document.getElementById("section-today");
}

/** The top/more/rest lists tiers.js's retier() fills, read back from a built panel's
 * own markup (app/build.py PAGE for Today, tabs.js fillPanel for a section tab: the
 * same river/module/details shape either way). */
function panelLists(panel) {
  const rivers = [...panel.querySelectorAll(".river--text-only")];
  return [panel.querySelector(".river--top"), rivers[0] || null, rivers[1] || null];
}

// The "More headlines" split point (hero + secondary + river + the first text-only
// slot, tiers.js TIERS): the same 35 every panel uses, so "N more" below it is exact.
const MORE_SPLIT = 35;

// A mute pulls a row out of the DOM entirely (retier only reorders rows it can find;
// it never builds one from scratch, so there is no other way to bring it back). A live
// Undo needs that row again, maybe more than once across a session, so each panel
// keeps its own removed rows in memory (a plain property on the element, cheap, never
// serialized) instead of letting them go: applyPanel reclaims one from this cache
// before falling back to leaving it out. Two panels never share a row (S27 clones one
// per section), so the cache lives on the panel, not globally.
function applyPanel(panel, stories, input) {
  const cache = panel.__almanacRemovedRows || (panel.__almanacRemovedRows = new Map());
  const rows = new Map([...panel.querySelectorAll("li.story[data-sid]")].map((li) => [li.dataset.sid, li]));
  for (const [sid, li] of cache) if (!rows.has(sid)) rows.set(sid, li);
  const order = stories.map((s) => s.id);
  const onPage = new Set(order);
  for (const [sid, li] of rows) {
    if (onPage.has(sid)) { cache.delete(sid); continue; }
    if (li.isConnected) li.remove();
    cache.set(sid, li);
  }
  retier(panelLists(panel), order, rows, input.deks || {}, input.images || {});
  for (const story of stories) placeOtherSide(rows.get(story.id), story.other_side || null, input);
  const toggle = panel.querySelector(".more-toggle");
  if (toggle) toggle.textContent = `Show ${Math.max(0, order.length - MORE_SPLIT)} more headlines`;
}

/** Re-ranks every already-built panel for the new profile: the one the action was
 * taken on (`sourcePanel`) with its scroll anchored, since it is the one on screen;
 * every other already-built panel is refreshed too, off screen, so returning to it
 * later shows the same profile without a reload. A panel S27 has not built yet needs
 * nothing: it builds fresh from window.almanacProfile the first time it is opened. */
function rerenderAfterProfileChange(profile, sourcePanel) {
  const input = getInput();
  window.almanacProfile = profile;
  const pages = rankPages(input.pool, profile, input.now, { buckets: input.buckets, leans: input.leans, names: input.names, health: input.health, events: input.events || [], terms: currentHistoryTerms() });
  const storiesFor = (id) => (id === "today" ? pages.today : (pages.sections.find((s) => s.id === id)?.stories || []));
  for (const panel of document.querySelectorAll(".panel")) {
    if (!panel.childElementCount) continue;
    const run = () => applyPanel(panel, storiesFor(panel.dataset.section), input);
    if (panel === sourcePanel) anchoredRerender(panel, run);
    else run();
  }
}

async function runProfileAction(li, build, message) {
  let store;
  try {
    store = await getStore();
  } catch {
    showToast("Couldn't save that. Try again once you're online.");
    return;
  }
  const before = store.current();
  const draft = build(before);
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
  rerenderAfterProfileChange(result.profile, panelOf(li));
  showToast(message, {
    onAction: () => {
      const reverted = store.revert(beforeVersion);
      if (reverted.ok) rerenderAfterProfileChange(reverted.profile, panelOf(li));
    },
  });
}

function doMuteSource({ li, attrs }) {
  const label = attrs.source_name ? `Muted ${attrs.source_name}` : "Source muted";
  return runProfileAction(li, (profile) => withSourceMuted(profile, attrs.source), label);
}

function doMuteTopic({ li, attrs }) {
  return runProfileAction(li, (profile) => withTopicMuted(profile, attrs.topics), "Topic muted");
}

function doBoostTopic({ li, attrs }) {
  return runProfileAction(li, (profile) => withTopicBoosted(profile, attrs.topics), "Topic boosted");
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".story-overflow");
  if (!button) return;
  event.preventDefault();
  const li = button.closest("li.story[data-sid]");
  if (li) openStoryMenu(li);
});
