// J13, J17: reading with Jev, the reader's half (js/jev/read.js is the pure half). A quiet
// bar at the top of a full-text article offers "Read with Jev"; only that tap asks Jev.
// Then the Takeaways block quotes the sentences Jev picked, each with its fixed name
// ("The news", "Why it matters" ...) and a tap that scrolls to it; those sentences are
// tinted in place; and Skim shows only the paragraphs that hold one. The publisher's
// text is never changed: the tint is the CSS Custom Highlight API (a range painted over
// the text, no markup inserted), falling back to tinting the paragraph.

import { askJev } from "./client.js";
import { readingBlocks, readingQuestions, readingView, readingDensity, readCache } from "./read.js";
// J19: each read and each Skim or Hide marks, recorded on this phone for the Health screen.
import { recordRead, recordEvent } from "./read-stats.js";
import { whenRead } from "./story-view.js";

function record(fn, ...args) {
  try {
    fn(window.localStorage, ...args);
  } catch {
    // Storage blocked: reading works the same, only the record is lost.
  }
}

const HIGHLIGHT = "jev-key";
const POINT = "jev-point"; // J18: the lighter tint for key points through the article
const cache = readCache(window.localStorage);
const INTRO = "Jev picks the sentences that carry the news, why it matters, the evidence, the other side and what's next. The words stay the publisher's.";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The reader's paragraphs, in order: its own p and li elements with text. */
function paragraphsOf(body) {
  return [...body.querySelectorAll("p, li")].filter((node) => !node.closest(".jev-read-bar, .jev-takeaways") && node.textContent.trim());
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

/** Removes every mark this module made in `body`. */
export function clearReading(body = document.querySelector(".reader-body")) {
  if (typeof CSS !== "undefined" && CSS.highlights) {
    CSS.highlights.delete(HIGHLIGHT);
    CSS.highlights.delete(POINT);
  }
  if (!body) return;
  body.classList.remove("jev-skim", "jev-marked");
  body.querySelectorAll(".jev-takeaways").forEach((n) => n.remove());
  body.querySelectorAll(".jev-minor, .jev-key-para").forEach((n) => n.classList.remove("jev-minor", "jev-key-para"));
}

function scrollTo(body, target) {
  const scroller = body.closest(".reader-scroll") || document.scrollingElement;
  const rect = target.getBoundingClientRect();
  const top = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop - 120;
  scroller.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

/** Tints `items` with highlight `name`; a paragraph class where the API is missing. */
function tint(nodeOf, items, name, fallbackClass) {
  const ranges = [];
  for (const t of items) {
    const node = nodeOf.get(t.paragraph);
    if (!node) continue;
    const range = rangeFor(node, t.text);
    t.range = range;
    if (range) ranges.push(range);
    else node.classList.add(fallbackClass);
  }
  if (ranges.length && typeof Highlight !== "undefined" && CSS.highlights) CSS.highlights.set(name, new Highlight(...ranges));
  else for (const r of ranges) r.commonAncestorContainer.parentElement?.closest("p, li")?.classList.add(fallbackClass);
}

/** Draws a reading: the Takeaways block after `bar` (named takeaways only), the named
 * sentences tinted strongly and the key points lightly, and the paragraphs Skim folds
 * marked. Returns whether anything was drawn. */
function applyReading(body, elements, blocks, view, bar) {
  clearReading(body);
  if (!view.takeaways.length && !view.points.length) return false;
  const nodeOf = new Map(blocks.paragraphs.map((p) => [p.id, elements[p.index]]));
  tint(nodeOf, view.takeaways, HIGHLIGHT, "jev-key-para");
  tint(nodeOf, view.points, POINT, "jev-point-para");
  if (view.takeaways.length) {
    const box = el("section", "jev-takeaways");
    box.setAttribute("aria-label", "Takeaways");
    box.append(el("p", "jev-takeaways-head", "Takeaways"));
    for (const t of view.takeaways) {
      const item = el("button", "jev-takeaway");
      item.type = "button";
      item.append(el("span", "jev-takeaway-name", t.name), el("span", "jev-takeaway-text", t.text));
      item.addEventListener("click", () => scrollTo(body, t.range || nodeOf.get(t.paragraph)));
      box.append(item);
    }
    bar.after(box);
  }
  for (const p of blocks.paragraphs) {
    if (view.skim && !view.skim.has(p.id)) elements[p.index]?.classList.add("jev-minor");
  }
  body.classList.add("jev-marked");
  return true;
}

/** The bar at the top of a full-text article: "Read with Jev", then Skim and Hide marks. */
export function readBar({ id, body, headline, outlet }) {
  const bar = el("div", "jev-read-bar");
  const read = el("button", "jev-read-go", "Read with Jev");
  read.type = "button";
  const note = el("p", "jev-read-note", INTRO);
  const skim = el("button", "jev-read-toggle", "Skim");
  skim.type = "button";
  skim.setAttribute("aria-pressed", "false");
  skim.hidden = true;
  const hide = el("button", "jev-read-toggle", "Hide marks");
  hide.type = "button";
  hide.hidden = true;
  bar.append(read, skim, hide, note);
  // J30: an article Jev has already read on this phone says so before the tap, so
  // showing its marks again never looks like a new call.
  const saved = cache.get(id);
  if (saved) {
    read.textContent = "Show Jev's marks";
    const when = whenRead(saved.at);
    note.textContent = `Jev has read this article${when ? ` (${when})` : ""}. Showing its marks again asks Jev nothing.`;
  }

  const show = (answers) => {
    const elements = paragraphsOf(body);
    const blocks = readingBlocks(elements.map((n) => n.textContent), { headline, outlet });
    const view = readingView(answers, blocks);
    const drawn = applyReading(body, elements, blocks, view, bar);
    const d = readingDensity(view, blocks);
    record(recordRead, d);
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    note.textContent = drawn
      ? `Jev marked ${plural(d.marked, "passage")} across ${plural(d.paragraphs, "paragraph")}: ${plural(view.takeaways.length, "takeaway")} above, ${plural(view.points.length, "key point")} in the text. The words are the publisher's.`
      : "Jev wasn't sure of any takeaway in this article, so nothing is marked.";
    read.hidden = true;
    skim.hidden = !drawn;
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
      record(recordEvent, "error");
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
    if (on) record(recordEvent, "skim");
  });
  hide.addEventListener("click", () => {
    record(recordEvent, "hide");
    clearReading(body);
    skim.hidden = true;
    hide.hidden = true;
    skim.setAttribute("aria-pressed", "false");
    read.hidden = false;
    const again = cache.get(id);
    read.textContent = again ? "Show Jev's marks" : "Read with Jev";
    note.textContent = again ? "Jev has read this article. Showing its marks again asks Jev nothing." : INTRO;
  });
  return bar;
}
