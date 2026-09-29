// J1: the Ask bar on Today (app/build.py ASK_BAR). The owner types a request in plain
// words ("less US politics, more Singapore"); Jev maps it onto the owner's own sections
// (js/jev/questions.js askQuestions), js/jev/ask.js turns that into one S19 proposal, the
// gate (js/ai/gate.js) checks it, and a sheet shows the change for Apply or Not now.
// Apply saves exactly one profile version through ProfileStore and re-ranks the built
// panels the way a mute or boost does; the toast's Undo reverts it. Nothing changes
// until Apply, and a refused proposal is counted in the S19 rejection ledger.

import { askJev } from "./client.js";
import { askQuestions } from "./questions.js";
import { askState, cleanRequest, proposalFromAsk, confidenceLine, askSuggestions } from "./ask.js";
import { submitProposal, applyApprovedProposal } from "../ai/review.js";
import { RejectionLedger } from "../ai/ledger.js";
import { openSheet, closeSheet } from "../sheet.js";
import { showToast } from "../toast.js";
import { getStore, rerenderAfterProfileChange } from "../story-actions.js";
import { pageInput } from "../page-input.js";

const NO_PROPOSAL = Object.freeze({
  no_match: "Jev couldn't match that to one of your sections. Try naming one, like “more Singapore”.",
  conflict: "That asks for more and less of the same section.",
  at_limit: "Those sections are already as high or low as they go.",
});

const pct = (p) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "");

let schemasPromise = null;
function loadSchemas() {
  const get = (name) => fetch(name, { credentials: "same-origin" }).then((r) => {
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    return r.json();
  });
  if (!schemasPromise) {
    schemasPromise = Promise.all([get("profile.schema.json"), get("proposal.schema.json")])
      .then(([profileSchema, proposalSchema]) => ({ profileSchema, proposalSchema }))
      .catch((error) => { schemasPromise = null; throw error; });
  }
  return schemasPromise;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmt = (x) => (Math.round(x * 100) / 100).toFixed(2);

/** The review sheet: the request, one row per change with Jev's confidence under it,
 * the size Jev read, then Apply and Not now. */
function reviewContent(request, built, review, onApply) {
  const nodes = [el("p", "why-headline jev-ask-request", `“${request}”`)];
  const rows = el("div", "why-rows");
  for (const [i, change] of review.changes.entries()) {
    const target = built.targets[i];
    const row = el("div", "why-row");
    row.append(
      el("span", "why-row-label", `${target.direction === "more" ? "More" : "Less"} ${target.label}`),
      el("span", "why-row-value", `${fmt(change.before)} → ${fmt(change.after)}`),
      el("span", "jev-why", confidenceLine(target)),
    );
    rows.append(row);
  }
  nodes.push(rows);
  const size = built.strength.label
    ? `Size: ${built.strength.label.toLowerCase()}${built.strength.confidence !== null ? ` (${pct(built.strength.confidence)})` : ""}, a step of ${fmt(built.strength.step)}.`
    : `Size: Jev didn't say, so the small step of ${fmt(built.strength.step)}.`;
  nodes.push(el("p", "why-scale-note jev-note", `${size} Nothing changes until you apply it, and Undo puts it back.`));
  const apply = el("button", "sheet-submit", "Apply");
  apply.type = "button";
  apply.addEventListener("click", onApply);
  const skip = el("button", "sheet-submit jev-skip", "Not now");
  skip.type = "button";
  skip.addEventListener("click", () => closeSheet());
  const actions = el("div", "sheet-form jev-actions");
  actions.append(apply, skip);
  nodes.push(actions);
  return nodes;
}

/** J2: Jev's top two sections were too close to call. The owner picks; each button
 * shows Jev's own probability for that option, and nothing is guessed. */
function didYouMeanContent(request, built, onPick) {
  const nodes = [el("p", "why-headline jev-ask-request", `“${request}”`),
    el("p", "why-scale-note", "Jev couldn't tell which section you meant. Pick one:")];
  const list = el("div", "sheet-menu");
  for (const [sideKey, word] of [["raise", "More"], ["lower", "Less"]]) {
    const spread = built.reads[sideKey]?.spread || [];
    for (const option of built.options[sideKey] || []) {
      const p = spread.find(([c]) => c === option)?.[1];
      const button = el("button", "sheet-item jev-option");
      button.type = "button";
      button.append(el("span", "sheet-item-text", `${word} ${option}`), el("span", "jev-option-p", pct(p)));
      button.addEventListener("click", () => onPick({ [sideKey]: option }));
      list.append(button);
    }
  }
  nodes.push(list);
  return nodes;
}

/** Resolves once the sheet has closed and a frame without it has painted, so the next
 * sheet opens fresh (the same wait story-actions.js uses between two sheets). */
function sheetGone() {
  const root = document.getElementById("sheet-root");
  return new Promise((resolve) => {
    const check = () => (root.hidden ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : requestAnimationFrame(check));
    requestAnimationFrame(check);
  });
}

/** Re-ranks every built panel for `profile` and shows Today from its top: an Ask
 * changes the whole feed, so the new lead is what the owner wants to see, not the row
 * that happened to be on screen (a mute's anchored re-render keeps that row instead). */
function showFeedTop(profile) {
  rerenderAfterProfileChange(profile, null);
  const panel = document.getElementById("section-today");
  if (panel) panel.scrollTop = 0;
}

/** Builds the proposal from Jev's answers (and the owner's own pick, if any), gates it,
 * and opens the review sheet, or the Did-you-mean sheet when Jev was split. */
function present(request, answers, { store, schemas, input }, chosen = {}) {
  const profile = store.current();
  const id = `ask-${Date.now().toString(36)}`;
  const built = proposalFromAsk(profile, answers, { request, id, chosen });
  if (!built.ok) {
    if (built.reason === "ambiguous") {
      openSheet({
        title: "Did you mean",
        opener: input,
        content: didYouMeanContent(request, built, async (pick) => {
          closeSheet();
          await sheetGone();
          present(request, answers, { store, schemas, input }, pick);
        }),
      });
      return;
    }
    showToast(NO_PROPOSAL[built.reason]);
    return;
  }
  const ledger = new RejectionLedger({ storage: window.localStorage });
  const verdict = submitProposal(profile, built.proposal, { schemas, ledger });
  if (verdict.decision === "reject") {
    showToast(`That change isn't allowed (${verdict.reason.replace(/_/g, " ")}).`);
    return;
  }
  const content = reviewContent(request, built, verdict.review, () => {
    const saved = applyApprovedProposal(store, { proposal: verdict.review.proposal }, { schemas, ledger });
    closeSheet();
    if (!saved.ok) {
      showToast(`Not applied: ${saved.reason.replace(/_/g, " ")}.`);
      return;
    }
    input.value = "";
    showFeedTop(saved.profile);
    showToast("Feed updated", {
      onAction: () => {
        const reverted = store.revert(saved.previous_version);
        if (reverted.ok) showFeedTop(reverted.profile);
      },
    });
  });
  openSheet({ title: "Jev suggests", content, opener: input });
}

async function onSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  hideHelp();
  const input = form.querySelector(".ask-input");
  const request = cleanRequest(input.value);
  if (!request || form.getAttribute("aria-busy") === "true") return;
  form.setAttribute("aria-busy", "true");
  try {
    const [store, schemas] = await Promise.all([getStore(), loadSchemas()]);
    const profile = store.current();
    const { answers } = await askJev(askState(profile, request), askQuestions(profile));
    present(request, answers, { store, schemas, input });
  } catch (error) {
    showToast(error?.kind ? error.message : "Couldn't ask Jev. Try again once you're online.");
  } finally {
    form.removeAttribute("aria-busy");
  }
}

// J21: what Jev can do, shown under the bar while it has focus: one line on what a
// request is, up to three ready requests from the reader's own sections and today's
// feed (ask.js askSuggestions, no Jev call), and where Jev answers about one story. A
// tap on a suggestion sends it; the review sheet still decides nothing until Apply.
const form = document.getElementById("ask-bar");
const help = document.getElementById("ask-help");
const suggest = document.getElementById("ask-suggest");

function topicCounts() {
  const counts = {};
  try {
    for (const a of pageInput()?.pool?.articles || []) for (const t of a.topics || []) counts[t] = (counts[t] || 0) + 1;
  } catch {
    // No page input: the help line still shows, without suggestions.
  }
  return counts;
}

async function showHelp() {
  if (!help || !help.hidden) return;
  help.hidden = false;
  try {
    const store = await getStore();
    const items = askSuggestions(store.current(), topicCounts()).map((text) => {
      const button = el("button", "ask-suggestion", text);
      button.type = "button";
      button.addEventListener("click", () => {
        const input = form.querySelector(".ask-input");
        input.value = text;
        form.requestSubmit();
      });
      return button;
    });
    suggest?.replaceChildren(...items);
  } catch {
    suggest?.replaceChildren();
  }
}

function hideHelp() {
  if (help) help.hidden = true;
}

if (form) {
  form.addEventListener("submit", onSubmit);
  form.addEventListener("focusin", showHelp);
  // A tap on a suggestion keeps focus in the bar (a phone does not focus a tapped
  // button), so the help stays up until the tap lands.
  help?.addEventListener("mousedown", (event) => {
    if (event.target.closest(".ask-suggestion")) event.preventDefault();
  });
  // Closes when focus leaves the bar and its help, so a tap on a suggestion still lands.
  for (const node of [form, help]) {
    node?.addEventListener("focusout", (event) => {
      const next = event.relatedTarget;
      if (!next || !(form.contains(next) || help?.contains(next))) hideHelp();
    });
  }
}
