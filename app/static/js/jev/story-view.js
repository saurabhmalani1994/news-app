// J1: the "Analyse with Jev" sheet's DOM (browser only; js/jev/story.js is the pure
// half). The overall verdict first, a bar for each of the four sentiments, then one row
// per answered question with Jev's own confidence. Every string is the app's own label
// or a criterion from js/jev/questions.js, set as text, never markup (R13, R26).

import { sortedBy } from "./sorted-by.js";
import { analysisView, confidenceText } from "./story.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function verdictBlock(verdict) {
  const box = el("div", "jev-verdict");
  box.dataset.sentiment = verdict.status === "sure" || verdict.status === "unrated" ? verdict.label.toLowerCase() : "";
  const head = el("p", "jev-verdict-head");
  head.append(el("span", "jev-verdict-kicker", "Overall"), el("span", "jev-verdict-label", verdict.label));
  if (typeof verdict.confidence === "number") head.append(el("span", "jev-verdict-conf", confidenceText(verdict.confidence)));
  box.append(head);
  const bars = el("div", "jev-bars");
  for (const { label, p } of verdict.bars) {
    const row = el("div", "jev-bar-row");
    const track = el("span", "jev-bar-track");
    const fill = el("span", "jev-bar-fill");
    fill.style.setProperty("--p", String(Math.max(0, Math.min(1, p))));
    track.append(fill);
    row.append(el("span", "jev-bar-label", label), track, el("span", "jev-bar-value", confidenceText(p)));
    bars.append(row);
  }
  box.append(bars);
  return box;
}

/** J12: the button that asks Jev live, under the hourly answers (or alone when the hourly
 * run has not read the story yet). The words say what it costs in time: a read of the
 * full article when Almanac has it, else three more questions about the story. */
export function readWithJev({ hasBody, hourly, onClick }) {
  const box = el("div", "sheet-form jev-actions");
  if (!hourly) box.append(el("p", "why-scale-note jev-note", "Jev hasn't read this story in its hourly run yet."));
  const button = el("button", "sheet-submit jev-read", hasBody ? "Read the full article with Jev" : "Ask Jev about this story");
  button.type = "button";
  button.addEventListener("click", () => onClick(button));
  box.append(button, el("p", "why-scale-note jev-note",
    hasBody ? "Jev reads the article and adds the kind of story, its significance and the headline's tone."
      : "Jev reads the headlines and summary and adds the kind of story, its significance and the headline's tone."));
  return box;
}

/** The sheet body for one story's analysis. */
export function renderAnalysis({ answers, missing = [], headline = "", cached = false, fullText = false, model = "", hourly = 0, liveFailed = "", live = true, ruleTopics = null }) {
  const view = analysisView(answers, missing);
  const nodes = [];
  if (headline) nodes.push(el("p", "why-headline", headline));
  if (view.verdict) nodes.push(verdictBlock(view.verdict));
  const list = el("div", "why-rows jev-rows");
  for (const r of view.rows) {
    const row = el("div", "why-row jev-row");
    row.dataset.key = r.key;
    row.dataset.status = r.status;
    const value = el("span", "why-row-value jev-row-value", r.value);
    const conf = el("span", "jev-row-conf", confidenceText(r.confidence));
    const right = el("span", "jev-row-right");
    right.append(value, conf);
    row.append(el("span", "why-row-label", r.label), right);
    list.append(row);
  }
  nodes.push(list);
  // J22: whether the section comes from the rules, Jev, or both agree.
  if (ruleTopics) {
    const by = sortedBy(ruleTopics, answers?.section);
    const box = el("p", "why-scale-note jev-sorted-note");
    box.dataset.kind = by.kind;
    box.append(el("span", "jev-sorted", `Section: ${by.label}. `), by.sentence);
    nodes.push(box);
  }
  const notes = [];
  if (view.missing) notes.push(`Jev left ${view.missing} question${view.missing === 1 ? "" : "s"} unanswered.`);
  if (!live) notes.push("From Jev's hourly run, which reads each article's headline and summary.");
  else notes.push(fullText
    ? "Jev read the full article, the other outlets' headlines and the summary."
    : "Jev read the headlines, outlets and summary only: this outlet doesn't publish its full text.");
  notes.push("A percentage beside an answer is Jev's confidence in it; \u201clikely\u201d means Jev leaned that way, and \u201cA or B\u201d means its top two were too close to call. For an \u201cAbout\u2026\u201d row, the percentage is Jev's probability that the story is about that.");
  if (hourly && live) notes.push(`${hourly} answer${hourly === 1 ? "" : "s"} from the hourly Jev run.`);
  if (liveFailed) notes.push(`Jev couldn't answer the rest just now (${liveFailed}).`);
  if (model === "mock-jev") notes.push("Local test answers from the stand-in, not the real Jev.");
  if (cached) notes.push("Saved from an earlier analysis on this phone.");
  nodes.push(el("p", "why-scale-note jev-note", notes.join(" ")));
  return nodes;
}
