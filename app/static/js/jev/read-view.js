// J13: reading with Jev, the reader's half (js/jev/read.js is the pure half). A quiet bar
// at the top of a full-text article offers "Read with Jev"; only that tap asks Jev. Then
// each paragraph Jev was sure about gets a small label in the app's own words, the key
// sentences are highlighted in place, and Skim folds away background, reaction and
// analysis. The publisher's text is never changed or rewritten: labels are the app's
// own elements beside it, and the highlight is the CSS Custom Highlight API (a range
// painted over the text, no markup inserted), falling back to marking the paragraph.

import { askJev } from "./client.js";
import { readingBlocks, readingQuestions, readingView, readCache } from "./read.js";

const HIGHLIGHT = "jev-key";
const PHRASE = "jev-phrase"; // J16: the few key phrases, painted stronger than a sentence
const cache = readCache(window.localStorage);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The reader's paragraphs, in order: its own p and li elements with text. */
function paragraphsOf(body) {
  return [...body.querySelectorAll("p, li")].filter((node) => !node.closest(".jev-read-bar") && node.textContent.trim());
}

/** A Range over `needle` inside `node`'s text, spaces matched loosely, or null. With
 * `whole`, the match must start and end on a word boundary (a phrase, not part of one). */
function rangeFor(node, needle, whole = false) {
  const pattern = needle.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const match = new RegExp(whole ? `(?<![\\w$£€])${pattern}(?![\\w])` : pattern).exec(node.textContent);
  if (!match) return null;
  const start = match.index;
  const end = start + match[0].length;
  const range = document.createRange();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let began = false;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const next = seen + t.data.length;
    if (!began && start < next) { range.setStart(t, start - seen); began = true; }
    if (began && end <= next) { range.setEnd(t, end - seen); return range; }
    seen = next;
  }
  return null;
}

/** Removes every mark this module made in `body` (labels, classes, highlights). */
export function clearReading(body = document.querySelector(".reader-body")) {
  if (typeof CSS !== "undefined" && CSS.highlights) {
    CSS.highlights.delete(HIGHLIGHT);
    CSS.highlights.delete(PHRASE);
  }
  if (!body) return;
  body.classList.remove("jev-skim", "jev-marked");
  body.querySelectorAll(".jev-role, .jev-facts").forEach((n) => n.remove());
  body.querySelectorAll(".jev-minor, .jev-key-para").forEach((n) => n.classList.remove("jev-minor", "jev-key-para"));
}

/** Draws a reading: a label before each paragraph Jev was sure about, the key sentences
 * highlighted, and the paragraphs Skim folds marked. */
function applyReading(body, elements, blocks, view, bar) {
  clearReading(body);
  const ranges = [];
  for (const p of blocks.paragraphs) {
    const node = elements[p.index];
    if (!node) continue;
    const label = view.labels[p.id];
    if (label) {
      const tag = el("div", "jev-role", label);
      tag.dataset.role = label;
      node.before(tag);
    }
    if (!view.skim.has(p.id)) node.classList.add("jev-minor");
    for (const s of p.sentences) {
      if (!view.keys.includes(s.id)) continue;
      const range = rangeFor(node, s.text);
      if (range) ranges.push(range);
      else node.classList.add("jev-key-para");
    }
  }
  if (ranges.length && typeof Highlight !== "undefined" && CSS.highlights) {
    CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
  } else {
    for (const r of ranges) r.commonAncestorContainer.parentElement?.closest("p, li")?.classList.add("jev-key-para");
  }
  // J16: each key phrase at its first appearance in the article, whole words only, and
  // the Key facts line quoting them, each a tap that scrolls to it.
  const found = [];
  for (const phrase of view.phrases) {
    for (const node of elements) {
      const range = rangeFor(node, phrase.text, true);
      if (range) { found.push({ phrase, range }); break; }
    }
  }
  if (found.length) {
    if (typeof Highlight !== "undefined" && CSS.highlights) CSS.highlights.set(PHRASE, new Highlight(...found.map((f) => f.range)));
    const facts = el("div", "jev-facts");
    facts.setAttribute("aria-label", "Key facts");
    for (const { phrase, range } of found) {
      const chip = el("button", "jev-fact");
      chip.type = "button";
      chip.append(el("span", "jev-fact-kind", phrase.kind), el("span", "jev-fact-text", phrase.text));
      chip.addEventListener("click", () => {
        const scroller = body.closest(".reader-scroll") || document.scrollingElement;
        const top = range.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 120;
        scroller.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      });
      facts.append(chip);
    }
    bar.after(facts);
  }
  body.classList.add("jev-marked");
  return found.length;
}

/** The bar at the top of a full-text article: "Read with Jev", then Skim and Hide marks. */
export function readBar({ id, body, headline, outlet }) {
  const bar = el("div", "jev-read-bar");
  const read = el("button", "jev-read-go", "Read with Jev");
  read.type = "button";
  const note = el("p", "jev-read-note", "Jev marks the key phrases and the paragraphs that carry the news. The words stay the publisher's.");
  const skim = el("button", "jev-read-toggle", "Skim");
  skim.type = "button";
  skim.setAttribute("aria-pressed", "false");
  skim.hidden = true;
  const hide = el("button", "jev-read-toggle", "Hide marks");
  hide.type = "button";
  hide.hidden = true;
  bar.append(read, skim, hide, note);

  const show = (answers) => {
    const elements = paragraphsOf(body);
    const blocks = readingBlocks(elements.map((n) => n.textContent), { headline, outlet });
    const view = readingView(answers, blocks, headline);
    const phrases = applyReading(body, elements, blocks, view, bar);
    const labels = Object.keys(view.labels).length;
    const marked = phrases
      ? `${phrases} key phrase${phrases === 1 ? "" : "s"}`
      : view.keys.length ? `${view.keys.length} key sentence${view.keys.length === 1 ? "" : "s"}` : "nothing it was sure of";
    note.textContent = `Jev marked ${marked}${labels ? ` and labelled ${labels} paragraph${labels === 1 ? "" : "s"}` : ""}. The words are the publisher's.`;
    read.hidden = true;
    skim.hidden = false;
    hide.hidden = false;
  };

  read.addEventListener("click", async () => {
    if (read.getAttribute("aria-busy") === "true") return;
    const saved = cache.get(id);
    if (saved) { show(saved.answers); return; }
    read.setAttribute("aria-busy", "true");
    read.textContent = "Jev is reading…";
    const elements = paragraphsOf(body);
    const blocks = readingBlocks(elements.map((n) => n.textContent), { headline, outlet });
    try {
      const calls = readingQuestions(blocks, headline);
      const results = await Promise.all(calls.map((questions) => askJev(blocks.state, questions)));
      const answers = Object.assign({}, ...results.map((r) => r.answers));
      if (!results.some((r) => r.model === "mock-jev")) cache.put(id, { answers, at: new Date().toISOString() });
      show(answers);
    } catch (error) {
      note.textContent = error.message;
      read.textContent = "Read with Jev";
    } finally {
      read.removeAttribute("aria-busy");
    }
  });
  skim.addEventListener("click", () => {
    const on = !body.classList.contains("jev-skim");
    body.classList.toggle("jev-skim", on);
    skim.setAttribute("aria-pressed", String(on));
  });
  hide.addEventListener("click", () => {
    clearReading(body);
    skim.hidden = true;
    hide.hidden = true;
    skim.setAttribute("aria-pressed", "false");
    read.hidden = false;
    read.textContent = "Read with Jev";
    note.textContent = "Jev marks the key phrases and the paragraphs that carry the news. The words stay the publisher's.";
  });
  return bar;
}
