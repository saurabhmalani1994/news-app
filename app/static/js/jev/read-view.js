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

/** A Range over `needle` inside `node`'s text, spaces matched loosely, or null. */
function rangeFor(node, needle) {
  const pattern = needle.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const match = new RegExp(pattern).exec(node.textContent);
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
  if (typeof CSS !== "undefined" && CSS.highlights) CSS.highlights.delete(HIGHLIGHT);
  if (!body) return;
  body.classList.remove("jev-skim", "jev-marked");
  body.querySelectorAll(".jev-role").forEach((n) => n.remove());
  body.querySelectorAll(".jev-minor, .jev-key-para").forEach((n) => n.classList.remove("jev-minor", "jev-key-para"));
}

/** Draws a reading: a label before each paragraph Jev was sure about, the key sentences
 * highlighted, and the paragraphs Skim folds marked. */
function applyReading(body, elements, blocks, view) {
  clearReading(body);
  const ranges = [];
  for (const p of blocks.paragraphs) {
    const node = elements[p.index];
    if (!node) continue;
    const role = view.roles[p.id];
    if (role) {
      const label = el("div", "jev-role", role.label);
      label.dataset.role = role.label;
      node.before(label);
      if (!view.skim.has(p.id)) label.classList.add("jev-minor");
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
  body.classList.add("jev-marked");
}

/** The bar at the top of a full-text article: "Read with Jev", then Skim and Hide marks. */
export function readBar({ id, body, headline, outlet }) {
  const bar = el("div", "jev-read-bar");
  const read = el("button", "jev-read-go", "Read with Jev");
  read.type = "button";
  const note = el("p", "jev-read-note", "Jev marks the key sentences and says what each paragraph does. The words stay the publisher's.");
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
    const view = readingView(answers, blocks);
    applyReading(body, elements, blocks, view);
    const labelled = Object.keys(view.roles).length;
    note.textContent = `Jev labelled ${labelled} of ${blocks.paragraphs.length} paragraphs and marked ${view.keys.length} key sentence${view.keys.length === 1 ? "" : "s"}. The words are the publisher's.`;
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
      const calls = readingQuestions(blocks);
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
    note.textContent = "Jev marks the key sentences and says what each paragraph does. The words stay the publisher's.";
  });
  return bar;
}
