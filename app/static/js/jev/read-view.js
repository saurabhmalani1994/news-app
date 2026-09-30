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
import { analysisCache, aboutLine, STORY_QUESTIONS } from "./story.js";

// J33: the story questions Read with Jev adds; the hourly run asks the rest.
const ABOUT_QUESTIONS = Object.freeze(Object.fromEntries(["story_type", "significance", "tone"].map((k) => [k, STORY_QUESTIONS[k]])));


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
function applyReading(body, elements, blocks, view, bar, about = "") {
  clearReading(body);
  if (!view.takeaways.length && !view.points.length && !about) return false;
  const nodeOf = new Map(blocks.paragraphs.map((p) => [p.id, elements[p.index]]));
  tint(nodeOf, view.takeaways, HIGHLIGHT, "jev-key-para");
  tint(nodeOf, view.points, POINT, "jev-point-para");
  if (view.takeaways.length || about) {
    const box = el("section", "jev-takeaways");
    box.setAttribute("aria-label", "Takeaways");
    // J33: what Jev says the story is, then the Takeaways.
    if (about) box.append(el("p", "jev-about", about));
    if (view.takeaways.length) box.append(el("p", "jev-takeaways-head", "Takeaways"));
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
export function readBar({ id, body, headline, outlet, sid = "" }) {
  const bar = el("div", "jev-read-bar");
  const read = el("button", "jev-read-go", "Read with Jev");
  read.type = "button";
  // J33 (owner): one button. Read with Jev also asks the story questions the hourly run
  // does not (kind of story, significance, headline tone) about this same article, in
  // the same tap; their answers show as one line above the Takeaways and are saved for
  // Jev's read in the story menu (js/jev/story.js analysisCache).
  const stories = analysisCache(window.localStorage);
  let lastStory = null; // this read's story answers, shown even when not saved (a test stand-in)
  const note = el("p", "jev-read-note", INTRO);
  const skim = el("button", "jev-read-toggle", "Skim");
  skim.type = "button";
  skim.setAttribute("aria-pressed", "false");
  skim.hidden = true;
  const hide = el("button", "jev-read-toggle", "Hide marks");
  hide.type = "button";
  hide.hidden = true;
  bar.append(read, skim, hide, note);

  const show = (answers, { savedAt = null } = {}) => {
    const elements = paragraphsOf(body);
    const blocks = readingBlocks(elements.map((n) => n.textContent), { headline, outlet });
    const view = readingView(answers, blocks);
    const drawn = applyReading(body, elements, blocks, view, bar, aboutLine(stories.get(sid)?.answers || lastStory));
    const d = readingDensity(view, blocks);
    if (!savedAt) record(recordRead, d); // J31: a saved reading shown again is not a new read
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const when = savedAt ? whenRead(savedAt) : "";
    const again = savedAt ? ` Jev read this article earlier${when ? ` (${when})` : ""}; showing it again asked Jev nothing.` : "";
    note.textContent = drawn
      ? `Jev marked ${plural(d.marked, "passage")} across ${plural(d.paragraphs, "paragraph")}: ${plural(view.takeaways.length, "takeaway")} above, ${plural(view.points.length, "key point")} in the text. The words are the publisher's.${again}`
      : `Jev wasn't sure of any takeaway in this article, so nothing is marked.${again}`;
    read.hidden = true;
    skim.hidden = !drawn;
    hide.hidden = false;
  };

  read.addEventListener("click", async () => {
    if (read.getAttribute("aria-busy") === "true") return;
    const saved = cache.get(id);
    if (saved) { show(saved.answers, { savedAt: saved.at || "earlier" }); return; }
    read.setAttribute("aria-busy", "true");
    read.textContent = "Jev is reading…";
    const elements = paragraphsOf(body);
    const blocks = readingBlocks(elements.map((n) => n.textContent), { headline, outlet });
    try {
      const calls = readingQuestions(blocks);
      const askStory = Boolean(sid) && !stories.get(sid);
      const [results, story] = await Promise.all([
        Promise.all(calls.map((questions) => askJev(blocks.state, questions))),
        askStory ? askJev(blocks.state, ABOUT_QUESTIONS).catch(() => null) : Promise.resolve(null),
      ]);
      const answers = Object.assign({}, ...results.map((r) => r.answers));
      const at = new Date().toISOString();
      if (!results.some((r) => r.model === "mock-jev")) cache.put(id, { answers, at });
      lastStory = story?.answers || null;
      if (story && story.model !== "mock-jev" && Object.keys(story.answers).length) {
        stories.put(sid, { answers: story.answers, missing: story.missing, model: story.model, full_text: true,
          hourly: 0, live_failed: "", at });
      }
      globalThis.window?.almanacFillTimes?.(); // J31: the card now says Jev read it
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
  // J31: an article Jev has already read on this phone opens with its marks shown, no
  // tap and no call; Skim and Hide marks are one tap away. Drawn once the bar is in the
  // page (the reader adds it right after this returns).
  const saved = cache.get(id);
  if (saved) queueMicrotask(() => { if (bar.isConnected) show(saved.answers, { savedAt: saved.at || "earlier" }); });
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
