// S24: per-story actions (DESIGN-v1.1 "Story actions", R19). The quiet three-dot
// button every card carries (app/build.py STORY) opens the reusable sheet (sheet.js).
// J38 (owner, 2026-10-08): four items, Save, More like this, Less like this and About
// this story; the nine older ones (thumbs, Boost topic, Mute topic, Mute source, Follow
// this story, Why this, Jev's read, Open at source) live one tap inside those.
//
// Save and thumbs write to actions/store.js (IndexedDB, local only, never sent
// anywhere, never touches profile.json: R19 holds because thumbs.js never imports
// ProfileStore at all). Mute and boost go through the S10 ProfileStore, exactly one
// new version each; the affected panel re-ranks in place with the scroll anchored
// (actions/scroll-anchor.js) and a quiet toast offers Undo, which reverts to the
// version saved just before the action, itself one more ordinary append.
//
// W1: "Follow this story" opens the standing-story form (standing-form.js) prefilled
// with a name and keywords from the story's own headlines (story-keywords.js); Follow
// saves it as one version, re-ranks the built panels (its floor may place a card), and
// offers Undo. Every save here also schedules the interests sync, and the page checks
// it once on load, so an edit made offline reaches the hourly search later.
import { openSheet, closeSheet } from "./sheet.js";
import { showToast } from "./toast.js";
import { ProfileStore } from "./profile/store.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { nowIso } from "./profile/time.js";
import { rankPages, pageOptions } from "./passes.js";
import { retier, placeFace, placeReadChoice, placeOtherSide } from "./tiers.js";
import { storyAttributes, domPlacement } from "./actions/context.js";
import { savesStore, thumbsStore } from "./actions/store.js";
import { toggleSave, undoSave } from "./actions/saves.js";
// S26: pins a saved has_body story's cached body past the reader's normal 200-entry
// eviction, and unpins on unsave; the same helper the Saved screen's own Unsave uses,
// so a save made from any card and one made from the Saved screen agree.
import { syncSavePin, syncUndoPin } from "./actions/save-pin.js";
import { bodyCache } from "./reader/cache.js";
import { loadBody } from "./reader/core.js";
import { toggleThumb, undoThumb } from "./actions/thumbs.js";
import { withSourceMuted, withTopicMuted, withTopicBoosted, withTopicLess } from "./actions/mute-boost.js";
import { topicLabel, resolveTopic } from "./actions/topic-resolve.js";
import { anchoredRerender } from "./actions/scroll-anchor.js";
import { explainLead, renderWhyContent } from "./why-this.js";
// S15: "opened" (R17, R23), and the seen-penalty term (history/penalty.js) so the
// device re-rank after a mute or boost, and the why-this sheet, agree with what the
// page already shows.
import { openedStore } from "./history/store.js";
import { recordOpened } from "./history/record.js";
import { readSummary, summaryToHistory, noteSeen } from "./history/summary.js";
import { seenPenaltyTerm } from "./history/penalty.js";
import { standingStatus, withStandingAdded, commitEdit, withWorkAdopted } from "./profile/you-edits.js";
import { suggestStanding } from "./story-keywords.js";
import { standingForm, standingMessage } from "./standing-form.js";
import { scheduleSync, startSync } from "./interests-sync.js";
import { pageInput } from "./page-input.js";
import { orderToday, readOrder } from "./today-order.js";
import { raisedTopics, loadReserve, mergeReserve, reserveRow, addedMessage } from "./reserve.js";
// J1: "Analyse with Jev", a typed read of the story (js/jev/*): answers are the app's own
// labels only, cached per story on this phone, and change nothing in the profile.
import { analysisCache, hourlyAnswers } from "./jev/story.js";
import { renderAnalysis } from "./jev/story-view.js";

function currentHistoryTerms() {
  return [seenPenaltyTerm(summaryToHistory(readSummary(window.localStorage)))];
}

// Generic geometric glyphs (Material-style single path, no text, no brand marks), the
// same filled-icon convention as the bottom nav and the reader bar (app/build.py).
const ICONS = Object.freeze({
  open: "M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3zM19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2z",
  save: "M6.2 2.6h11.6c.5 0 .9.4.9.9v18.1L12 17.1l-6.7 4.5V3.5c0-.5.4-.9.9-.9z",
  up: "M9 21h8.1c.8 0 1.5-.5 1.8-1.3l2.4-5.6c.1-.2.1-.4.1-.6v-1.8c0-1-.8-1.8-1.8-1.8h-5.1l.7-3.6.1-.5c0-.4-.2-.8-.4-1.1L13.1 3 8.3 7.8c-.3.3-.5.7-.5 1.1V19c0 1.1.9 2 2 2zM3 10h3v11H3z",
  down: "M15 3H6.9c-.8 0-1.5.5-1.8 1.3L2.7 9.9c-.1.2-.1.4-.1.6v1.8c0 1 .8 1.8 1.8 1.8h5.1l-.7 3.6-.1.5c0 .4.2.8.4 1.1l.8 1.7 4.8-4.8c.3-.3.5-.7.5-1.1V5c0-1.1-.9-2-2-2zM21 14h-3V3h3z",
  mute: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM4 12c0-4.4 3.6-8 8-8 1.8 0 3.5.6 4.9 1.7L5.7 16.9C4.6 15.5 4 13.8 4 12zm8 8c-1.8 0-3.5-.6-4.9-1.7L18.3 7.1C19.4 8.5 20 10.2 20 12c0 4.4-3.6 8-8 8z",
  boost: "M4 14l1.4 1.4L11 9.8V20h2V9.8l5.6 5.6L20 14l-8-8-8 8z",
  follow: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  jev: "M21.4 11.6l-9-9C12.1 2.2 11.6 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .6.2 1.1.6 1.4l9 9c.4.4.9.6 1.4.6s1-.2 1.4-.6l7-7c.4-.4.6-.9.6-1.4s-.2-1.1-.6-1.4zM5.5 7C4.7 7 4 6.3 4 5.5S4.7 4 5.5 4 7 4.7 7 5.5 6.3 7 5.5 7z",
  why: "M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8z",
  more: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
});

let cachedInput = null;
function getInput() {
  if (!cachedInput) {
    try {
      cachedInput = pageInput();
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
/** The page's one ProfileStore (J1: the Ask bar saves through it too). */
export async function getStore() {
  if (!storeInstance) {
    storeInstance = new ProfileStore({
      storage: window.localStorage, schema: await loadSchema(), seedDefault: buildDefaultProfile,
      onSave: () => scheduleSync(),
    });
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
  const image = li.dataset.face ? input.fronts?.[li.dataset.face]?.i : input.images?.[li.dataset.sid];
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
  const attrs = storyAttributes(input, sid, li.dataset.face || null);
  const facts = cardFacts(li, input);
  const [saved, thumb] = await Promise.all([savesStore.get(sid), thumbsStore.get(sid)]);

  // J38 (owner): four items, named by what the reader wants. More like this and Less
  // like this each count as a thumb and open the stronger choices (a boost, a follow;
  // less of a topic, hiding a topic or an outlet); About this story is Why this and
  // Jev's read on one sheet. Everything the nine old items did is still here.
  const items = [
    menuItem({ action: "save", icon: ICONS.save, text: saved ? "Saved" : "Save", pressed: Boolean(saved) }),
    menuItem({ action: "more", icon: ICONS.up, text: "More like this", pressed: thumb?.direction === "up" }),
    menuItem({ action: "less", icon: ICONS.down, text: "Less like this", pressed: thumb?.direction === "down" }),
    menuItem({ action: "about", icon: ICONS.why, text: "About this story" }),
  ];

  const menu = document.createElement("div");
  menu.className = "sheet-menu";
  menu.setAttribute("role", "menu");
  menu.append(...items);
  menu.addEventListener("click", (event) => {
    const button = event.target.closest(".sheet-item[data-action]");
    if (!button) return;
    event.preventDefault();
    handleAction(button.dataset.action, { li, sid, attrs, facts });
  });
  openSheet({ title: "Story actions", content: menu, opener: li.querySelector(".story-overflow") });
}

function handleAction(action, ctx) {
  if (action === "save") return doSave(ctx);
  if (action === "more") return doMoreLess("up", ctx);
  if (action === "less") return doMoreLess("down", ctx);
  if (action === "about") return doAbout(ctx);
  if (action === "up" || action === "down") return doThumb(action, ctx);
  if (action === "mute-source") return doMuteSource(ctx);
  if (action === "mute-topic") return doMuteTopic(ctx);
  if (action === "less-topic") return doLessTopic(ctx);
  if (action === "boost-topic") return doBoostTopic(ctx);
  if (action === "follow") return doFollow(ctx);
  return null;
}

/** J38: the second sheet of More like this (direction "up") or Less like this ("down").
 * Opening it counts as that thumb (the weekly review reads it; nothing changes at
 * once), and the sheet offers the choices that do change the feed at once. */
async function doMoreLess(direction, ctx) {
  const { li, sid, attrs } = ctx;
  const opener = li.querySelector(".story-overflow");
  const up = direction === "up";
  const before = await thumbsStore.get(sid);
  if (before?.direction !== direction) await toggleThumb(thumbsStore, sid, direction, attrs, nowIso);
  let profile = null;
  try {
    profile = (await getStore()).current();
  } catch {
    profile = buildDefaultProfile(getInput().now);
  }
  const topicId = resolveTopic(attrs.topics, profile.topics || {});
  const topic = topicId ? profile.topics?.[topicId]?.label || topicLabel(topicId) : "";
  const boosted = (profile.boosts || []).some((b) => b.id === `boost-topic-${topicId}`);
  closeSheet();
  const note = document.createElement("p");
  note.className = "why-scale-note more-less-note";
  note.textContent = up
    ? "Noted that you liked this. Your weekly review counts it. To change your feed now:"
    : "Noted that you did not like this. Your weekly review counts it. To change your feed now:";
  const items = up
    ? [
      topic && !boosted ? menuItem({ action: "boost-topic", icon: ICONS.boost, text: `More ${topic}` }) : null,
      menuItem({ action: "follow", icon: ICONS.follow, text: "Follow this story" }),
      menuItem({ action: "up", icon: ICONS.up, text: "Take back my thumbs up" }),
    ]
    : [
      topic && withTopicLess(profile, attrs.topics) ? menuItem({ action: "less-topic", icon: ICONS.down, text: `Less ${topic}` }) : null,
      topic ? menuItem({ action: "mute-topic", icon: ICONS.mute, text: `Hide ${topic}` }) : null,
      menuItem({ action: "mute-source", icon: ICONS.mute, text: attrs.source_name ? `Hide ${attrs.source_name}` : "Hide this outlet" }),
      menuItem({ action: "down", icon: ICONS.down, text: "Take back my thumbs down" }),
    ];
  const menu = document.createElement("div");
  menu.className = "sheet-menu";
  menu.setAttribute("role", "menu");
  menu.append(...items.filter(Boolean));
  menu.addEventListener("click", (event) => {
    const button = event.target.closest(".sheet-item[data-action]");
    if (!button) return;
    event.preventDefault();
    handleAction(button.dataset.action, ctx);
  });
  await sheetClosed();
  openSheet({ title: up ? "More like this" : "Less like this", content: [note, menu], opener });
}

function doLessTopic({ li, attrs }) {
  return runProfileAction(li, (profile) => withTopicLess(profile, attrs.topics), "Showing less of this topic");
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
  const pages = rankPages(input.pool, profile, input.now, pageOptions(input, { terms: currentHistoryTerms() }));
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

// J1, J33: Jev's read shows what Jev has already said about a story: the hourly run's
// answers, with Read with Jev's saved ones for an article read on this phone. It never
// asks Jev itself; Read with Jev, in the open article, does.
const jevCache = analysisCache(window.localStorage);

// J11: the hourly run's answers (dist/jev.json), fetched once per page and reused, so a
// story Jev already read shows its answers at once without a call.
let hourlyPromise = null;
function hourlyDoc() {
  if (!hourlyPromise) {
    hourlyPromise = fetch("jev.json", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return hourlyPromise;
}

/** The row's own article first, then the rest of its story's members. */
function storyArticleIds(sid, attrs) {
  const cluster = (getInput().pool?.clusters || []).find((c) => c.id === sid);
  const ids = cluster ? cluster.article_ids : [sid];
  return [...new Set([attrs.article_id, ...ids].filter(Boolean))];
}

// J12: two steps. "Jev's read" first shows what the hourly run already answered, at once
// and with no call; only the sheet's own button asks Jev live, reading the full article
// when Almanac has it, for what the hourly run does not ask. A story read live before
// opens with its full result.
/** J38: About this story, one sheet in two parts. "Why it is here" is the ranker's own
 * explanation for the tab the card is on (why-this.js, no AI). "What Jev says" is what
 * Jev has already said about it: the hourly run's answers, with Read with Jev's saved
 * ones for an article read on this phone, and any tag it added or versions it joined.
 * It asks Jev nothing. The publisher's page is linked at the foot. */
async function doAbout({ li, sid, attrs, facts }) {
  const opener = li.querySelector(".story-overflow");
  const [{ story, profile, input }, hourlyAll] = await Promise.all([storyForWhy(li, sid), hourlyDoc()]);
  const hourly = hourlyAnswers(hourlyAll, storyArticleIds(sid, attrs));
  closeSheet();
  const part = (text) => {
    const h = document.createElement("h3");
    h.className = "about-part";
    h.textContent = text;
    return h;
  };
  const why = document.createElement("div");
  why.className = "about-why";
  if (story) {
    const nowMs = typeof input.now === "number" ? input.now : Date.parse(input.now) || Date.now();
    why.append(...renderWhyContent({ story, profile, nowMs, names: input.names || {}, headline: facts.title, lead: explainLead(input, sid, profile) }));
  }
  const jev = document.createElement("div");
  jev.className = "about-jev";
  const full = jevCache.get(sid);
  const ruleTopics = ruleTopicsOf(attrs.article_id || sid);
  if (full) {
    // J33: Read with Jev saves only the questions the hourly run skips; show both.
    const merged = { ...full, answers: { ...(hourly?.answers || {}), ...full.answers },
      hourly: full.hourly || (hourly ? Object.keys(hourly.answers).length : 0) };
    jev.append(...analysisContent(merged, { ...facts, title: "" }, true, ruleTopics));
  } else if (hourly) {
    jev.append(...renderAnalysis({ answers: hourly.answers, headline: "", hourly: Object.keys(hourly.answers).length, live: false, ruleTopics }));
  }
  jev.append(...jevChangeNote(sid), askInArticle(facts.has_body, Boolean(hourly)));
  const content = [part("Why it is here"), why, part("What Jev says"), jev];
  if (facts.url) {
    const open = menuItem({ action: "open", icon: ICONS.open, text: "Open at source", href: facts.url });
    open.classList.add("about-open");
    open.addEventListener("click", () => {
      recordOpened(openedStore, sid, { ...attrs, ...facts }, nowIso, (snapshot) => noteSeen(window.localStorage, "opened", snapshot.id, snapshot.time)).catch(() => {});
      closeSheet();
    });
    content.push(open);
  }
  await sheetClosed();
  openSheet({ title: "About this story", content, opener });
}

/** J32: where to ask Jev more about a story: in the article, when Almanac can open it. */
function askInArticle(hasBody, hourly) {
  const p = document.createElement("p");
  p.className = "why-scale-note jev-note";
  const first = hourly ? "" : "Jev hasn't read this story in its hourly run yet. ";
  p.textContent = first + (hasBody
    ? "For more (the key sentences, the kind of story, its significance, the headline's tone), open the article with Read here and tap Read with Jev at the top."
    : hourly ? "Almanac can't open this outlet's full text, so these hourly answers are what Jev has for it."
      : "Almanac can't open this outlet's full text, so there is nothing more to ask it about here.");
  return p;
}

/** J22: the rules' topics for an article, from the page's own ranking input. */
function ruleTopicsOf(id) {
  const pool = getInput().pool || {};
  const lead = (pool.clusters || []).find((c) => c.id === id)?.lead || id;
  const article = (pool.articles || []).find((a) => a.id === lead);
  // J36: a tag Jev added is Jev's, not the rules'.
  const added = new Set(article?.jev?.tags || []);
  return article ? (article.topics || []).filter((t) => !added.has(t)) : null;
}

/** J36: what Jev changed about a story in the hourly run, as plain lines for the Why
 * this and Jev's read sheets: a tag it added (the rules gave none), versions it joined
 * from a story the rules had left apart. [] when it changed nothing. */
function jevChangeLines(sid) {
  const pool = getInput().pool || {};
  const cluster = (pool.clusters || []).find((c) => c.id === sid);
  const ids = new Set(cluster ? cluster.article_ids : [sid]);
  const members = (pool.articles || []).filter((x) => ids.has(x.id));
  const lead = members.find((x) => x.id === (cluster?.lead || sid));
  const lines = [];
  const tags = (lead?.jev?.tags || []).map((t) => topicLabel(t));
  if (tags.length) lines.push(`Jev added the ${tags.join(" and ")} tag to this story: the rules had not tagged it. It counts for your ${tags.join(" and ")} setting and tab.`);
  const joined = members.filter((x) => x.jev?.joined).length;
  if (joined) lines.push(`Jev joined ${joined} version${joined === 1 ? "" : "s"} to this story that the rules had left as a separate card, so it counts ${joined === 1 ? "that outlet" : "those outlets"} too.`);
  return lines;
}

function jevChangeNote(sid) {
  const lines = jevChangeLines(sid);
  if (!lines.length) return [];
  const p = document.createElement("p");
  p.className = "why-scale-note jev-note jev-changed";
  p.textContent = lines.join(" ");
  return [p];
}

function analysisContent(result, facts, cached, ruleTopics = null) {
  return renderAnalysis({
    ruleTopics,
    answers: result.answers, missing: result.missing, headline: facts.title, cached, at: result.at || "",
    fullText: Boolean(result.full_text), model: result.model || "", hourly: result.hourly || 0, liveFailed: result.live_failed || "",
  });
}

async function doSave({ sid, attrs, facts }) {
  const result = await toggleSave(savesStore, sid, { ...attrs, ...facts }, nowIso);
  closeSheet();
  syncSavePin(result, { cache: bodyCache, fetchBody: loadBody }).catch(() => {});
  showToast(result.action === "added" ? "Saved" : "Removed from Saved", {
    onAction: () => {
      undoSave(savesStore, sid, result.action, result.previous);
      syncUndoPin(result.action, result.record, result.previous, { cache: bodyCache, fetchBody: loadBody }).catch(() => {});
    },
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
function applyPanel(panel, stories, input, faces = {}, trust = {}) {
  const cache = panel.__almanacRemovedRows || (panel.__almanacRemovedRows = new Map());
  const rows = new Map([...panel.querySelectorAll("li.story[data-sid]")].map((li) => [li.dataset.sid, li]));
  for (const [sid, li] of cache) if (!rows.has(sid)) rows.set(sid, li);
  const order = stories.map((s) => s.id);
  const onPage = new Set(order);
  // J26: a story pulled in from the reserve has no card yet; it gets one, cloned from
  // one of the page's own cards (reserve.js reserveRow).
  const template = document.querySelector("#section-today li.story[data-sid]:not([data-reserve])");
  for (const sid of order) {
    if (rows.has(sid) || !input.reserve?.[sid]) continue;
    const li = reserveRow(sid, input, template);
    if (li) rows.set(sid, li);
  }
  for (const [sid, li] of rows) {
    if (onPage.has(sid)) { cache.delete(sid); continue; }
    if (li.isConnected) li.remove();
    cache.set(sid, li);
  }
  // B5: a mute or a trust change can pick another best version for a story; its row
  // is fronted with that version (tiers.js placeFace) before it is re-tiered.
  const leads = new Map((input.pool?.clusters || []).map((c) => [c.id, c.lead]));
  const shown = new Map(order.filter((sid) => rows.has(sid)).map((sid) => [sid, rows.get(sid)]));
  for (const [sid, li] of shown) placeFace(li, faces[sid], leads.get(sid), input);
  retier(panelLists(panel), order, rows, input.deks || {}, input.images || {}, input.fronts || {});
  placeReadChoice(shown, input, trust, faces);
  for (const story of stories) placeOtherSide(rows.get(story.id), story.other_side || null, input);
  const toggle = panel.querySelector(".more-toggle");
  if (toggle) toggle.textContent = `Show ${Math.max(0, order.length - MORE_SPLIT)} more headlines`;
}

/** Re-ranks every already-built panel for the new profile: the one the action was
 * taken on (`sourcePanel`) with its scroll anchored, since it is the one on screen;
 * every other already-built panel is refreshed too, off screen, so returning to it
 * later shows the same profile without a reload. A panel S27 has not built yet needs
 * nothing: it builds fresh from window.almanacProfile the first time it is opened. */
export function rerenderAfterProfileChange(profile, sourcePanel) {
  const input = getInput();
  // The page shows the default profile until a stored one re-ranks it (rank-gate.js).
  const before = window.almanacProfile || buildDefaultProfile(input.now);
  window.almanacProfile = profile;
  // J26: raising a topic also pulls its reserve in (after this render, then once more).
  const raised = raisedTopics(before, profile);
  if (raised.length) pullReserve(raised, profile);
  const pages = rankPages(input.pool, profile, input.now, pageOptions(input, { terms: currentHistoryTerms() }));
  // J22: Today in the reader's chosen order (today-order.js); the tabs keep theirs.
  const order = window.almanacTodayOrder || readOrder(window.localStorage);
  const today = orderToday(pages.today, order, input.pool, Date.parse(input.now), pages.faces);
  const storiesFor = (id) => (id === "today" ? today : (pages.sections.find((s) => s.id === id)?.stories || []));
  for (const panel of document.querySelectorAll(".panel")) {
    if (!panel.childElementCount) continue;
    const run = () => applyPanel(panel, storiesFor(panel.dataset.section), input, pages.faces, profile.trust || {});
    if (panel === sourcePanel) anchoredRerender(panel, run);
    else run();
  }
}

/** J26: loads the reserve files for `topics`, merges what the page lacks, re-ranks
 * every built panel once more and says how many stories came in. Quiet when there is
 * nothing to add or the files cannot be read (offline, another edition). */
async function pullReserve(topics, profile) {
  const input = getInput();
  const { records } = await loadReserve(topics, input.now);
  const added = mergeReserve(input, records);
  if (!added.length || window.almanacProfile !== profile) return;
  // The panel on screen keeps its place (its selected tab names it, tabs.js).
  const tab = document.querySelector('.tab[role="tab"][aria-selected="true"]');
  const panel = tab ? document.getElementById(tab.getAttribute("aria-controls")) : null;
  rerenderAfterProfileChange(profile, panel);
  const labels = topics.map((t) => profile.topics?.[t]?.label || t);
  showToast(addedMessage(added.length, labels), { keepAction: true });
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

// --- W1: follow a story as a standing story. ---

/** The story's own headlines (every member of its cluster, or the one article) and
 * every headline in the pool, from the page's own rank input. */
function storyTitles(input, sid) {
  const articles = input.pool?.articles || [];
  const byId = new Map(articles.map((a) => [a.id, a]));
  const cluster = (input.pool?.clusters || []).find((c) => c.id === sid);
  const ids = cluster ? cluster.article_ids : [sid];
  return { own: ids.map((id) => byId.get(id)?.title).filter(Boolean), pool: articles.map((a) => a.title).filter(Boolean) };
}

async function doFollow({ li, sid }) {
  const opener = li.querySelector(".story-overflow");
  const input = getInput();
  const { own, pool } = storyTitles(input, sid);
  const suggestion = suggestStanding(own.length ? own : [li.querySelector(".headline")?.textContent || ""], pool);
  closeSheet();
  const content = standingForm({
    label: suggestion.label,
    keywords: suggestion.keywords,
    submitText: "Follow",
    onSubmit: async (label, keywords) => {
      let store;
      try {
        store = await getStore();
      } catch {
        return "Could not save that. Try again once you are online.";
      }
      const before = store.current();
      const status = standingStatus(before, { label, keywords });
      if (!status.ok) return standingMessage(status.reason);
      const result = store.save(withStandingAdded(before, { label, keywords }));
      if (!result.ok) return `Not saved: ${result.errors[0]}`;
      closeSheet();
      rerenderAfterProfileChange(result.profile, panelOf(li));
      showToast(`Following ${status.label}`, {
        onAction: () => {
          const reverted = store.revert(before.profile_version);
          if (reverted.ok) rerenderAfterProfileChange(reverted.profile, panelOf(li));
        },
      });
      return null;
    },
  });
  await sheetClosed();
  openSheet({ title: "Follow this story", content, opener });
}

// W1: once per page load, a check that the phone's searches reached the hourly run.
// B11: work rules seeded into the server's store come back into a profile with none.
startSync(3000, {
  adopt: async (rules) => {
    const result = commitEdit(await getStore(), (p) => withWorkAdopted(p, rules));
    return result && result.ok ? result.profile : null;
  },
});

// C3: the action row's open button ("Read here" or "Open site") is the card's own tap,
// handed to the row's link, so the reader, the opened record (R17) and the new tab all
// behave exactly as a tap on the card does. The link's click happens inside this
// trusted tap, so a browser still lets it open its tab.
document.addEventListener("click", (event) => {
  const open = event.target.closest(".story-act--open");
  if (!open) return;
  event.preventDefault();
  open.closest("li.story")?.querySelector(".story-link")?.click();
});

// J21: the other side's "Read here" opens that version in Almanac's reader. A throwaway
// a.story-link[data-body] is clicked inside this trusted tap, so reader.js's own
// document listener opens it (coverage-view.js does the same), and history and the
// opened record behave exactly as for a card.
document.addEventListener("click", (event) => {
  const read = event.target.closest(".other-side-read");
  if (!read?.dataset.body) return;
  event.preventDefault();
  const a = document.createElement("a");
  a.className = "story-link";
  a.hidden = true;
  a.href = read.closest(".other-side")?.querySelector(".other-side-go")?.getAttribute("href") || "#";
  a.dataset.body = read.dataset.body;
  read.closest("li.story")?.append(a);
  a.click();
  a.remove();
});

document.addEventListener("click", (event) => {
  const button = event.target.closest(".story-overflow");
  if (!button) return;
  event.preventDefault();
  const li = button.closest("li.story[data-sid]");
  if (li) openStoryMenu(li);
});
