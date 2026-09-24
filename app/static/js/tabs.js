// S27: the app chrome's behaviour. Section tabs over a native scroll-snap pager, so a
// tap or a horizontal swipe changes section with no reload and nothing reflowing: each
// panel is its own vertical scroller beside the others, which is also why each keeps its
// scroll position. The strip keeps the active tab centred, as NYT's does. Bottom nav
// screens (Following, Saved) are layers over Home, switched by the URL fragment, so
// Home keeps its state underneath.
//
// Section panels start empty in the HTML. Once Today is in its final order (after any
// rank-gate re-rank), each panel is filled with clones of Today's rows, filtered by the
// one section table (sections.js) and re-tiered by the shared routine (tiers.js): the
// same ranked pool, the same tiers and hero rules, no second copy in the page.
//
// S13: a section's order is its own page from the post-passes (passes.js): the same
// list filtered, then that tab's lean quota and other-side slot, for the profile the
// page is showing (the stored one when rank-gate re-ranked, else the default).
//
// S33: the Live tab is the one exception to "starts empty, filled from Today's rows
// later": which event is live (live.js currentLiveEvent, the pool's own pick plus the
// owner's pin and block overrides) decides the tab's own shown/hidden state and label,
// and that has to be right from the first frame, not after the idle-deferred build
// every other panel waits for, or a pin or a block taken on a stored profile would
// flash the wrong tab into the strip. syncLiveTab is cheap (no ranking, just
// live.js's pure pick) and runs at once, then again after any profile save that could
// change the outcome (story-actions.js, live-actions.js).
import { rankPages } from "./passes.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { STORAGE_KEY } from "./profile/store.js";
import { SECTIONS } from "./sections.js";
import { retier, placeOtherSide } from "./tiers.js";
import { currentLiveEvent } from "./live.js";

const root = document.documentElement;
const pager = document.getElementById("pager");
const strip = document.querySelector(".tabs-scroll");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const input = JSON.parse(document.getElementById("rank-input").content.textContent);
let built = false;

const visibleTabs = () => [...strip.querySelectorAll(".tab")].filter((t) => !t.hidden);
const panelFor = (tab) => document.getElementById(tab.getAttribute("aria-controls"));
const currentIndex = () => visibleTabs().findIndex((t) => t.getAttribute("aria-selected") === "true");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// The same quiet three-dot glyph the story overflow menu uses (app/build.py
// STORY_OVERFLOW, story-actions.js ICONS.more): one filled path, no text, no brand.
const OVERFLOW_ICON_D = "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z";

function overflowIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "story-overflow-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", OVERFLOW_ICON_D);
  svg.append(path);
  return svg;
}

/** The stored profile straight from localStorage, bypassing rank-gate's own narrower
 * ranking-fields check (rank-gate.js only reruns the ranker when a *ranking* field
 * differs from the build's default; live_overrides is not one, so window.almanacProfile
 * can be unset even though the owner has pinned or blocked something). Never throws;
 * an absent or corrupt store falls through to the default, the same as rank-gate.js. */
function storedProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const history = JSON.parse(raw).history;
    return Array.isArray(history) && history.length ? history[history.length - 1].profile : null;
  } catch {
    return null;
  }
}

/** The profile every section, including Live, ranks and picks overrides against: a
 * rerank.js result if one already ran this load, else the real stored profile, else
 * the shipped default. Exported so story-actions.js's own profile-save re-render (and
 * the Live panel's own override sheet) read the same profile this module does. */
export function currentProfile() {
  return window.almanacProfile || storedProfile() || buildDefaultProfile(input.now);
}

/** Keeps the Live tab and panel's own chrome, shown or hidden and its label, in sync
 * with whichever event is live right now for this profile (live.js currentLiveEvent):
 * cheap and synchronous, so it runs before the panel's own stories are ever built and
 * again after any profile save that could change the outcome. Falls back to Today if
 * the tab it just hid was the active one, since a panel with no tab left cannot stay
 * on screen. Returns the event, or null when the tab is hidden. */
export function syncLiveTab(profile) {
  const tab = document.getElementById("tab-live");
  const panel = document.getElementById("section-live");
  if (!tab || !panel) return null;
  const event = currentLiveEvent(input.events || [], profile);
  const wasActive = tab.getAttribute("aria-selected") === "true";
  tab.hidden = !event;
  panel.hidden = !event;
  if (event) {
    tab.textContent = event.label;
    tab.dataset.label = event.label; // style.css reserves the bold width from this
  }
  if (!event && wasActive) {
    const today = document.getElementById("tab-today");
    const i = today && visibleTabs().indexOf(today);
    if (i >= 0) select(i, true);
  }
  placeInk();
  return event;
}

/** The skeleton build.py gives Today, then rows placed by the shared re-tier. */
function fillPanel(panel, section, ids, rows, input) {
  const top = el("ol", "river river--top");
  panel.append(top);
  let more = null;
  let rest = null;
  if (ids.length > 15) {
    const module = el("section", "module");
    const label = el("h2", "module-label", "More headlines");
    label.id = `more-label-${section.id}`;
    module.setAttribute("aria-labelledby", label.id);
    more = el("ol", "river river--text-only");
    module.append(label, more);
    if (ids.length > 35) {
      const details = el("details", "more-rest");
      details.append(el("summary", "more-toggle", `Show ${ids.length - 35} more headlines`));
      rest = el("ol", "river river--text-only");
      details.append(rest);
      module.append(details);
    }
    panel.append(module);
  }
  retier([top, more, rest], ids, rows, input.deks || {}, input.images || {});
  if (!ids.length) {
    const empty = el("div", "empty empty--section");
    empty.append(el("p", "empty-head", `No ${section.label} stories right now`),
      el("p", "empty-text", "This section fills as the next edition comes in."));
    panel.append(empty);
  }
}

/** S33: the Live panel's own header, a small kicker naming it live plus the event's
 * own label (the tab strip already carries the red dot and the same label; this is
 * the "sub-strip or header naming the event" the panel itself needs, since a reader
 * can land here straight from a swipe without ever reading the tab). The overflow
 * button opens the S24 sheet with the owner's pin and block actions
 * (live-actions.js), the one owner-only surface for the R22 overrides. Then the
 * event's own clusters, ranked, tiered exactly like any other section's river. */
export function fillLivePanel(panel, liveSection, rows, input) {
  const header = el("header", "live-header");
  header.append(
    el("p", "live-kicker", "Live"),
    el("h2", "live-title", liveSection.event.label),
  );
  const overflow = el("button", "story-overflow live-overflow");
  overflow.type = "button";
  overflow.setAttribute("aria-haspopup", "dialog");
  overflow.setAttribute("aria-label", `Live coverage settings: ${liveSection.event.label}`);
  overflow.dataset.eventId = liveSection.event.id;
  overflow.dataset.eventLabel = liveSection.event.label;
  overflow.append(overflowIcon());
  header.append(overflow);
  panel.append(header);
  const ids = liveSection.stories.map((s) => s.id).filter((id) => rows.has(id));
  fillPanel(panel, { id: "live", label: liveSection.label }, ids, rows, input);
}

function buildSections() {
  if (built) return;
  built = true;
  const profile = currentProfile();
  const pages = rankPages(input.pool, profile, input.now, { buckets: input.buckets, leans: input.leans, names: input.names, health: input.health, events: input.events || [] });
  syncLiveTab(profile);
  const todayRows = [...document.querySelectorAll("#section-today li.story[data-sid]")];
  const byId = new Map(todayRows.map((li) => [li.dataset.sid, li]));
  for (const section of SECTIONS) {
    if (section.all) continue;
    const panel = document.getElementById(`section-${section.id}`);
    if (!panel || panel.childElementCount) continue;
    const page = pages.sections.find((p) => p.id === section.id);
    if (section.slot === "live") {
      if (!page.event) continue; // tab hidden; nothing to build until an event is live
      const stories = page.stories.filter((s) => byId.has(s.id));
      const rows = new Map(stories.map((s) => [s.id, byId.get(s.id).cloneNode(true)]));
      fillLivePanel(panel, page, rows, input);
      continue;
    }
    const stories = page.stories.filter((s) => byId.has(s.id));
    const ids = stories.map((s) => s.id);
    const rows = new Map(ids.map((id) => [id, byId.get(id).cloneNode(true)]));
    fillPanel(panel, section, ids, rows, input);
    for (const story of stories) placeOtherSide(rows.get(story.id), story.other_side || null, input);
  }
  root.dataset.sections = "ready";
}

function whenRanked(fn) {
  if (!root.classList.contains("rerank")) { fn(); return; }
  const watch = new MutationObserver(() => {
    if (!root.classList.contains("rerank")) { watch.disconnect(); fn(); }
  });
  watch.observe(root, { attributes: true, attributeFilter: ["class"] });
}

// D3: one underline (the "ink") for the whole strip, so a change of tab slides it rather
// than jumping. It sits inside the scroller, so it scrolls with the labels, and moves by
// transform only (translateX and scaleX of a 1px bar), never by layout, so it can never
// count as a layout shift. A tap or key eases it to the new tab (style.css, 160ms
// ease-out, none under reduced motion); a swipe drives it straight from the pager's
// scroll position, so it follows the finger. Until this runs, the active tab paints its
// own underline (style.css), in the same place, so first paint already has one.
const INSET = 6; // the underline reaches 4dp past the label: 10dp padding less 4
const ink = document.createElement("span");
ink.className = "tabs-ink";
ink.setAttribute("aria-hidden", "true");
let jumpTarget = null;

/** The tab's box in the strip's own scrolled coordinates, to the subpixel (offsetLeft
 * would round), less the inset each side. */
function inkBox(tab) {
  const r = tab.getBoundingClientRect();
  const x = r.left - strip.getBoundingClientRect().left - strip.clientLeft + strip.scrollLeft;
  return { x: x + INSET, w: Math.max(0, r.width - 2 * INSET) };
}

function setInk(box, animate) {
  ink.classList.toggle("is-tracking", !animate);
  ink.style.transform = `translateX(${box.x}px) scaleX(${box.w})`;
}

/** Puts the ink under the selected tab, without easing (load, resize, relabel). */
function placeInk() {
  const tab = visibleTabs()[currentIndex()];
  if (tab) setInk(inkBox(tab), false);
}

/** The ink for the pager's scroll position: between the two tabs whose panels straddle
 * it, in proportion, so mid-swipe it sits part way and part width between them. */
function trackInk() {
  const tabs = visibleTabs();
  const lefts = tabs.map((t) => panelFor(t).offsetLeft);
  const x = pager.scrollLeft;
  let i = 0;
  while (i < tabs.length - 1 && lefts[i + 1] <= x) i++;
  const a = inkBox(tabs[i]);
  const next = tabs[i + 1];
  const span = next ? lefts[i + 1] - lefts[i] : 0;
  const f = span > 0 ? Math.min(1, Math.max(0, (x - lefts[i]) / span)) : 0;
  const b = next ? inkBox(next) : a;
  setInk({ x: a.x + (b.x - a.x) * f, w: a.w + (b.w - a.w) * f }, false);
}

strip.append(ink);
placeInk();
strip.classList.add("has-ink");
new ResizeObserver(placeInk).observe(strip);
document.fonts?.ready.then(placeInk);

/** Marks tab i active; with `move`, jumps the pager to its panel (tap, key). */
function select(i, move) {
  const tabs = visibleTabs();
  const tab = tabs[i];
  if (!tab) return;
  if (move && !built && !root.classList.contains("rerank")) buildSections();
  tabs.forEach((t, n) => {
    t.setAttribute("aria-selected", n === i ? "true" : "false");
    t.tabIndex = n === i ? 0 : -1;
  });
  if (move) {
    setInk(inkBox(tab), !reduced.matches);
    jumpTarget = panelFor(tab).offsetLeft;
    pager.scrollTo({ left: jumpTarget, behavior: "instant" });
  }
  const left = tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2;
  strip.scrollTo({ left: Math.max(0, left), behavior: reduced.matches ? "instant" : "smooth" });
}

strip.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  const i = visibleTabs().indexOf(tab);
  if (i === currentIndex()) panelFor(tab).scrollTo({ top: 0, behavior: reduced.matches ? "instant" : "smooth" });
  else select(i, true);
});

strip.addEventListener("keydown", (e) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  const tabs = visibleTabs();
  const i = (currentIndex() + step + tabs.length) % tabs.length;
  select(i, true);
  tabs[i].focus();
  e.preventDefault();
});

// A swipe settles on a panel by scroll snapping; the tab follows once the pager is
// past half way, read once per frame.
let frame = 0;
pager.addEventListener("scroll", () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!built && !root.classList.contains("rerank")) buildSections();
    // A tap's own instant jump lands exactly on its panel: the ink is already easing
    // there, so leave it be. Any other scroll is a finger (or its snap): track it.
    if (jumpTarget !== null && Math.abs(pager.scrollLeft - jumpTarget) < 1) jumpTarget = null;
    else { jumpTarget = null; trackInk(); }
    const width = pager.clientWidth || 1;
    const tabs = visibleTabs();
    const i = tabs.findIndex((t) => Math.abs(panelFor(t).offsetLeft - pager.scrollLeft) < width / 2);
    if (i >= 0 && i !== currentIndex()) select(i, false);
  });
}, { passive: true });

// Bottom nav: #following and #saved raise their layer over Home; anything else is Home.
// Tapping Home while on Home takes the current section back to its top, as NYT does.
const screens = [...document.querySelectorAll(".screen")];
function route() {
  const want = location.hash.slice(1);
  const name = screens.some((s) => s.dataset.screen === want) ? want : "home";
  for (const screen of screens) {
    const on = screen.dataset.screen === name;
    screen.classList.toggle("is-current", on);
    screen.inert = !on;
  }
  document.querySelectorAll(".nav-item").forEach((a) => {
    if (a.dataset.screen === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}
document.querySelector('.nav-item[data-screen="home"]')?.addEventListener("click", (e) => {
  if (!document.getElementById("screen-home").classList.contains("is-current")) return;
  e.preventDefault();
  const tab = visibleTabs()[currentIndex()];
  if (tab) panelFor(tab).scrollTo({ top: 0, behavior: reduced.matches ? "instant" : "smooth" });
});
addEventListener("hashchange", route);
route();

// S33: the Live tab's own shown/hidden state and label are correct from the first
// frame the SSR gives them (app/build.py, the default profile); this only corrects
// them for a stored profile whose pin or block changes the outcome, before anything
// paints, so there is nothing to correct visibly later.
whenRanked(() => syncLiveTab(currentProfile()));

// Fill the other sections off the critical path: after Today's first paint and any
// re-rank, when the main thread is idle (or at once, on the first tap or swipe).
whenRanked(() => {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(buildSections, { timeout: 1500 });
});
