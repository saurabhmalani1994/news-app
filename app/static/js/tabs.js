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
import { rankPages } from "./passes.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { SECTIONS } from "./sections.js";
import { retier, placeOtherSide } from "./tiers.js";

const root = document.documentElement;
const pager = document.getElementById("pager");
const strip = document.querySelector(".tabs-scroll");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
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

function buildSections() {
  if (built) return;
  built = true;
  const input = JSON.parse(document.getElementById("rank-input").content.textContent);
  const profile = window.almanacProfile || buildDefaultProfile(input.now);
  const pages = rankPages(input.pool, profile, input.now, { buckets: input.buckets, leans: input.leans, names: input.names });
  const todayRows = [...document.querySelectorAll("#section-today li.story[data-sid]")];
  const byId = new Map(todayRows.map((li) => [li.dataset.sid, li]));
  for (const section of SECTIONS) {
    if (section.all || section.slot) continue;
    const panel = document.getElementById(`section-${section.id}`);
    if (!panel || panel.childElementCount) continue;
    const page = pages.sections.find((p) => p.id === section.id);
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
  if (move) pager.scrollTo({ left: panelFor(tab).offsetLeft, behavior: "instant" });
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

// Fill the other sections off the critical path: after Today's first paint and any
// re-rank, when the main thread is idle (or at once, on the first tap or swipe).
whenRanked(() => {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(buildSections, { timeout: 1500 });
});
