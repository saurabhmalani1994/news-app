// J19: the Health screen's "Your reading with Jev" section (app/health.py JEV_READING),
// filled from this phone's own record (js/jev/read-stats.js). The section is static
// markup at the very end of the page, hidden until there is something to show, so
// filling it moves nothing above it. Every value is set as text.

import { readingSummary, MIN_READS } from "./read-stats.js";

const section = document.getElementById("jev-reading");
const rows = document.getElementById("jev-reading-rows");

function row(label, value) {
  const wrap = document.createElement("div");
  wrap.className = "setting-row";
  const text = document.createElement("div");
  text.className = "setting-row-text";
  const name = document.createElement("span");
  name.className = "setting-label";
  name.textContent = label;
  text.append(name);
  const val = document.createElement("span");
  val.className = "setting-value";
  val.textContent = value;
  wrap.append(text, val);
  return wrap;
}

const pct = (x) => (x === null ? "none yet" : `${Math.round(x * 100)}%`);
const WORD = { pass: "Pass", fail: "Needs work", not_enough_data: "Not enough data" };

let summary = null;
try {
  summary = readingSummary(window.localStorage);
} catch {
  summary = null;
}
if (section && rows && summary && (summary.reads || summary.errors)) {
  const nodes = [
    row("Articles read with Jev", String(summary.reads)),
    row("Marked share of paragraphs, average", pct(summary.avgShare)),
    row("Longest unmarked run, average", summary.avgGap === null ? "none yet" : `${summary.avgGap.toFixed(1)} paragraphs`),
    row("Reads where you used Skim", pct(summary.skimRate)),
    row("Reads where you tapped Hide marks", pct(summary.hideRate)),
    row("Reads where Jev marked nothing", pct(summary.emptyRate)),
    row("Times Jev did not answer", String(summary.errors)),
  ];
  for (const c of summary.checks) {
    const target = c.key === "gap" ? `${c.direction} ${c.target}` : `${c.direction} ${Math.round(c.target * 100)}%`;
    nodes.push(row(`Check: ${c.label} (target ${target})`, WORD[c.status]));
  }
  if (summary.reads < MIN_READS) {
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent = `The checks start after ${MIN_READS} reads.`;
    nodes.push(hint);
  }
  rows.replaceChildren(...nodes);
  section.hidden = false;
}
