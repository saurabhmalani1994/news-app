// S25: the in-app reader. A tap on a story whose lead article has a body file (the
// build marks its link data-body) opens the story here, set like an NYT article page;
// every other story links out to its source as before (reader/core.js readerChoice).
//
// The reader is one layer over the app (#reader, static markup from build.py). Home is
// never touched underneath: its tab, its pager and each panel's scroll stay exactly
// where they were, so closing is just hiding the layer. Opening pushes a history entry
// (#read-<id>), so the phone's back button and the browser's close it too.
//
// Everything above the body (headline, dek, photo, source and time) comes from what
// the page already holds, so it is laid out in the first frame; the body area shows a
// quiet skeleton in the body's own line rhythm until the text arrives, and nothing above
// it moves. Feed strings are set as text (R26); the body goes through S37's sanitizer,
// which returns a DocumentFragment, and nothing here parses or serializes HTML.
import { sanitizeBody } from "./sanitize.js";
import { bodyCache } from "./reader/cache.js";
import {
  BODY_ID, EMOJI_IMAGE, NOTES, TRAILER, formatPublished, imageStem, loadBody, readerChoice, sameText, smartQuotes, tinyImage,
} from "./reader/core.js";
// S24: thumbs at the end of the reader, the same record and toggle as the card's own
// overflow sheet (story-actions.js), keyed the same way (storyIdForArticle) so a thumb
// given here and one given from the card agree on which story it belongs to.
import { storyAttributes, storyIdForArticle } from "./actions/context.js";
import { thumbsStore } from "./actions/store.js";
import { toggleThumb, undoThumb } from "./actions/thumbs.js";
import { nowIso } from "./profile/time.js";
import { showToast } from "./toast.js";

const reader = document.getElementById("reader");
const scroller = document.getElementById("reader-scroll");
const article = document.getElementById("reader-article");
const back = document.getElementById("reader-back");
const out = document.getElementById("reader-out");
const underneath = [document.querySelector(".screens"), document.querySelector(".bottom-nav")].filter(Boolean);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const HTTPS = /^https:\/\/[^\s]+$/i;
const WEB = /^https?:\/\/[^\s]+$/i;
const HASH = /^#read-([a-z0-9][a-z0-9_-]{0,63})$/;
const SKELETON_LINES = [1, 1, 1, 0.62, 0, 1, 1, 1, 1, 0.4, 0, 1, 1, 0.8];

let input = null;
let current = null; // {id, link, pushed, token}
let token = 0;
let hideTimer = 0;

function pageInput() {
  if (!input) {
    try {
      input = JSON.parse(document.getElementById("rank-input").content.textContent);
    } catch {
      input = {};
    }
    input.byId = new Map((input.pool?.articles || []).map((a) => [a.id, a]));
  }
  return input;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Arrow glyph for the link out, drawn with DOM calls (no markup strings). */
function arrow() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "reader-link-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M7 17 17 7M9 7h8v8");
  svg.append(path);
  return svg;
}

/** What the page knows about the story before its body arrives. */
function storyFacts(id, link) {
  const data = pageInput();
  const record = data.byId.get(id) || {};
  const li = link?.closest("li.story");
  const sid = li?.dataset.sid;
  const deks = (sid && data.deks?.[sid]) || [];
  const href = link?.getAttribute("href") || "";
  return {
    title: link?.querySelector(".headline")?.textContent || record.title || "",
    // The hero's fitted dek; one cut short with an ellipsis is left out, since the
    // body below carries the whole thought.
    dek: deks[0] && !/…\s*$/.test(deks[0]) ? deks[0] : "",
    source: (data.names || {})[record.source_id] || link?.querySelector(".meta-source")?.textContent || "",
    published: record.published_at || "",
    photo: (data.reader || {})[id] || null,
    href: WEB.test(href) ? href : "",
  };
}

function thumbIcon(direction) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "reader-thumb-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", direction === "up"
    ? "M9 21h8.1c.8 0 1.5-.5 1.8-1.3l2.4-5.6c.1-.2.1-.4.1-.6v-1.8c0-1-.8-1.8-1.8-1.8h-5.1l.7-3.6.1-.5c0-.4-.2-.8-.4-1.1L13.1 3 8.3 7.8c-.3.3-.5.7-.5 1.1V19c0 1.1.9 2 2 2zM3 10h3v11H3z"
    : "M15 3H6.9c-.8 0-1.5.5-1.8 1.3L2.7 9.9c-.1.2-.1.4-.1.6v1.8c0 1 .8 1.8 1.8 1.8h5.1l-.7 3.6-.1.5c0 .4.2.8.4 1.1l.8 1.7 4.8-4.8c.3-.3.5-.7.5-1.1V5c0-1.1-.9-2-2-2zM21 14h-3V3h3z");
  svg.append(path);
  return svg;
}

function thumbButton(direction, pressed) {
  const button = el("button", "reader-thumb");
  button.type = "button";
  button.dataset.direction = direction;
  button.setAttribute("aria-pressed", String(pressed));
  button.setAttribute("aria-label", direction === "up" ? "Thumbs up" : "Thumbs down");
  button.append(thumbIcon(direction));
  return button;
}

/** The end-of-reader thumbs row (R19, DESIGN-v1.1 "Story actions"): the same toggle,
 * the same IndexedDB record and the same "never touches profile.json" as the card's
 * own overflow sheet. `id` is the article the reader opened; storyIdForArticle finds
 * the cluster it fronts, if any, so this agrees with a thumb given from the card. */
async function thumbsRow(id) {
  const data = pageInput();
  const sid = storyIdForArticle(data, id);
  const attrs = storyAttributes(data, sid);
  let existing = null;
  try {
    existing = await thumbsStore.get(sid);
  } catch {
    // no IndexedDB (a very old browser, or a private-mode block): thumbs just start unset
  }
  const row = el("div", "reader-thumbs");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Rate this story");
  const up = thumbButton("up", existing?.direction === "up");
  const down = thumbButton("down", existing?.direction === "down");
  row.append(up, down);
  row.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-direction]");
    if (!button || row.dataset.busy) return;
    row.dataset.busy = "1";
    const direction = button.dataset.direction;
    let result;
    try {
      result = await toggleThumb(thumbsStore, sid, direction, attrs, nowIso);
    } catch {
      delete row.dataset.busy;
      return;
    }
    up.setAttribute("aria-pressed", String(result.action === "set" && direction === "up"));
    down.setAttribute("aria-pressed", String(result.action === "set" && direction === "down"));
    delete row.dataset.busy;
    const message = result.action === "cleared" ? "Thumb removed" : direction === "up" ? "Marked helpful" : "Marked not helpful";
    showToast(message, {
      onAction: async () => {
        await undoThumb(thumbsStore, sid, result.previous);
        up.setAttribute("aria-pressed", String(result.previous?.direction === "up"));
        down.setAttribute("aria-pressed", String(result.previous?.direction === "down"));
      },
    });
  });
  return row;
}

function linkOut(url, source) {
  const end = el("footer", "reader-end");
  if (!url) return end;
  const a = el("a", "reader-link");
  a.setAttribute("href", url);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  a.append(el("span", "reader-link-text", source ? `Read at ${source}` : "Read at the source"), arrow());
  end.append(a);
  return end;
}

function skeleton() {
  const box = el("div", "reader-skeleton");
  box.setAttribute("aria-hidden", "true");
  for (const width of SKELETON_LINES) {
    const line = el("span", width ? "reader-skeleton-line" : "reader-skeleton-gap");
    if (width && width < 1) line.classList.add(width < 0.5 ? "is-short" : "is-mid");
    box.append(line);
  }
  return box;
}

function hero(photo) {
  if (!Array.isArray(photo)) return null;
  const [url, width, height, credit] = photo;
  if (!HTTPS.test(url || "") || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const figure = el("figure", "reader-hero");
  const img = document.createElement("img");
  img.className = "reader-hero-img";
  img.setAttribute("width", String(width));
  img.setAttribute("height", String(height));
  img.setAttribute("alt", "");
  img.setAttribute("decoding", "async");
  img.setAttribute("fetchpriority", "high");
  img.setAttribute("referrerpolicy", "no-referrer");
  img.setAttribute("src", url);
  figure.append(img);
  if (credit) figure.append(el("figcaption", "reader-credit", credit));
  return figure;
}

/** The sanitized body, tidied for reading: no tracking pixels, no empty paragraphs, no
 * feed trailer. Only nodes the sanitizer created are touched. */
function tidy(fragment) {
  for (const img of fragment.querySelectorAll("img")) {
    let url = null;
    try { url = new URL(img.src); } catch { /* the sanitizer only keeps https URLs */ }
    if (url && EMOJI_IMAGE.test(url.pathname)) {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") || ""));
    } else if (!url || tinyImage(img.getAttribute("width"), img.getAttribute("height")) || /(^|\.)feedburner\.com$/.test(url.hostname)) {
      (img.closest("figure") || img).remove();
    }
  }
  for (const p of fragment.querySelectorAll("p")) {
    if (TRAILER.test(p.textContent)) p.remove();
    else if (!p.textContent.trim() && !p.querySelector("img")) p.remove();
  }
  // Straight quotes to typographic ones, as the headlines are set, one paragraph at a
  // time; text nodes only, so no markup is ever read or made.
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  let block = null;
  let prev = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const owner = node.parentElement?.closest("p, li, blockquote, h2, h3, h4, h5, h6, figcaption") || null;
    if (owner !== block) { block = owner; prev = ""; }
    if (/['"]/.test(node.data)) node.data = smartQuotes(node.data, prev);
    if (node.data) prev = node.data[node.data.length - 1];
  }
  for (const img of fragment.querySelectorAll("img")) {
    if (!img.closest("figure")) {
      const figure = el("figure", "reader-figure");
      img.replaceWith(figure);
      figure.append(img);
    }
  }
  return fragment;
}

function showNote(state, facts, id, run) {
  const note = NOTES[state] || NOTES.error;
  const box = el("div", "reader-note");
  box.setAttribute("role", "status");
  box.append(el("p", "reader-note-head", note.head), el("p", "reader-note-text", note.text));
  if (note.retry) {
    const again = el("button", "reader-retry", "Try again");
    again.type = "button";
    again.addEventListener("click", () => run(id, facts));
    box.append(again);
  }
  return box;
}

function fill(id, facts) {
  const mine = ++token;
  const body = article.querySelector(".reader-body");
  body.replaceChildren(skeleton());
  body.setAttribute("aria-busy", "true");
  article.querySelector(".reader-end")?.remove();
  article.querySelector(".reader-thumbs")?.remove();
  loadBody(id, { cache: bodyCache }).then(async (result) => {
    if (mine !== token || current?.id !== id) return;
    body.removeAttribute("aria-busy");
    if (result.state !== "ready") {
      body.replaceChildren(showNote(result.state, facts, id, fill));
      const end = linkOut(facts.href, facts.source);
      const thumbs = await thumbsRow(id);
      if (mine === token && current?.id === id) article.append(end, thumbs);
      if (result.state === "offline") addEventListener("online", () => { if (current?.id === id && mine === token) fill(id, facts); }, { once: true });
      return;
    }
    const record = result.body;
    const fragment = tidy(sanitizeBody(record.body_html, { base: record.url || facts.href || undefined }));
    // The body's own copy of the hero photo goes; the hero above it stays put.
    const heroImg = article.querySelector(".reader-hero-img");
    const stem = heroImg && imageStem(heroImg.src);
    const dup = stem && [...fragment.querySelectorAll("img")].find((img) => imageStem(img.src) === stem);
    if (dup) (dup.closest("figure") || dup).remove();
    // A dek that is the body's own first paragraph (many feeds send it as the
    // description) is said once: the paragraph goes, never the dek above it, which
    // would move the page.
    const dek = article.querySelector(".reader-dek");
    const lede = fragment.querySelector("p");
    if (dek && lede && sameText(dek.textContent, lede.textContent)) lede.remove();
    body.replaceChildren(fragment);
    const end = linkOut(record.url || facts.href, record.source_name || facts.source);
    const thumbs = await thumbsRow(id);
    if (mine === token && current?.id === id) article.append(end, thumbs);
    out.hidden = !(record.url || facts.href);
    if (record.url || facts.href) out.setAttribute("href", record.url || facts.href);
  });
}

function render(id, facts) {
  const head = el("header", "reader-head");
  const title = el("h1", "reader-title", facts.title);
  title.id = "reader-title";
  head.append(title);
  if (facts.dek) head.append(el("p", "reader-dek", facts.dek));
  const parts = [head];
  const figure = hero(facts.photo);
  if (figure) parts.push(figure);
  const byline = el("div", "reader-byline");
  if (facts.source) byline.append(el("p", "reader-source", facts.source));
  const when = formatPublished(facts.published);
  if (when) {
    const line = el("p", "reader-time");
    const time = el("time", null, when);
    time.setAttribute("datetime", facts.published);
    line.append(time);
    byline.append(line);
  }
  parts.push(byline, el("div", "reader-body"));
  article.replaceChildren(...parts);
  out.hidden = !facts.href;
  if (facts.href) out.setAttribute("href", facts.href);
  out.setAttribute("aria-label", facts.source ? `Read at ${facts.source}` : "Read at the source");
}

function open(id, link, push) {
  clearTimeout(hideTimer);
  const facts = storyFacts(id, link);
  render(id, facts);
  current = { id, link, pushed: push };
  if (push) history.pushState({ almanacReader: id }, "", `#read-${id}`);
  for (const node of underneath) node.inert = true;
  reader.hidden = false;
  reader.inert = false;
  scroller.scrollTop = 0;
  if (reduced.matches) reader.classList.add("is-open");
  else requestAnimationFrame(() => requestAnimationFrame(() => reader.classList.add("is-open")));
  back.focus({ preventScroll: true });
  fill(id, facts);
}

function close() {
  if (!current) return;
  const { link } = current;
  current = null;
  token++;
  reader.classList.remove("is-open");
  reader.inert = true;
  for (const node of underneath) node.inert = false;
  const done = () => { if (!current) { reader.hidden = true; article.replaceChildren(); } };
  if (reduced.matches) done();
  else hideTimer = setTimeout(done, 170);
  link?.focus({ preventScroll: true });
}

/** The reader's own back: a history step when the reader added one, so the browser's
 * history stays as the owner left it; otherwise (opened from a #read- link) it closes
 * and drops the fragment in place. */
function goBack() {
  if (!current) return;
  if (current.pushed && history.state?.almanacReader === current.id) history.back();
  else {
    history.replaceState(null, "", location.pathname + location.search);
    close();
  }
}

function linkFor(id) {
  return document.querySelector(`#section-today a.story-link[data-body="${id}"]`)
    || document.querySelector(`a.story-link[data-body="${id}"]`);
}

document.addEventListener("click", (event) => {
  const link = event.target.closest?.("a.story-link");
  if (!link || reader.contains(link)) return;
  const id = readerChoice(link, event);
  if (!id) return;
  event.preventDefault();
  open(id, link, true);
});

back.addEventListener("click", goBack);
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && current) goBack();
});

addEventListener("popstate", (event) => {
  const id = event.state?.almanacReader;
  if (id && BODY_ID.test(id)) {
    const link = linkFor(id);
    if (link && current?.id !== id) open(id, link, false);
    if (current) current.pushed = true;
    return;
  }
  close();
});

// A #read-<id> address (a reload, a shared link, one typed in) opens that story when
// the page has it; otherwise the address is dropped and Home shows.
function fromAddress(entry) {
  const direct = HASH.exec(location.hash);
  if (!direct || current?.id === direct[1]) return;
  const link = linkFor(direct[1]);
  if (!link) {
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  open(direct[1], link, false);
  current.pushed = entry; // a same-page hash change made its own history entry
}
addEventListener("hashchange", () => fromAddress(true));
fromAddress(false);
