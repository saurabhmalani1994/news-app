// W1: the standing-story form, a name and keywords, shown in the reusable sheet
// (sheet.js) from two places: the You page's "Add standing story" row (empty) and a
// story row's "Follow this story" menu item (prefilled from the story's own headlines,
// story-keywords.js). The floor and the silence alarm take standing.js STANDING_NEW,
// said once in the hint, and are tuned later on the story's own page.
//
// Text only (R26): every value goes in through textContent or .value, never HTML; the
// prefilled name and keywords come from feed headlines. Styled by style.css .sheet-form,
// which both pages load.
import { STANDING_NEW } from "./standing.js";

function node(tag, className, props = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") el.textContent = value;
    else el.setAttribute(key, value);
  }
  return el;
}

/** The refusal a standingStatus() reason reads as, in plain words. */
export function standingMessage(reason) {
  return {
    name: "Give it a name.",
    keywords: "Give it at least one keyword of two letters or more.",
    duplicate: "You already follow a standing story with this name.",
    full: "You follow 12 standing stories, the most there can be. Remove one first.",
  }[reason] || "That could not be saved.";
}

/**
 * The form's nodes. `onSubmit(label, keywordsText)` saves and returns null on success
 * (the caller closes the sheet) or a message to show under the fields.
 */
export function standingForm({ label = "", keywords = [], submitText = "Add", onSubmit }) {
  const form = node("form", "sheet-form", { novalidate: "" });
  const name = node("input", "sheet-input", {
    type: "text", maxlength: "40", autocomplete: "off", spellcheck: "false", enterkeyhint: "next", id: "standing-name",
  });
  name.value = label;
  const words = node("textarea", "sheet-input sheet-input--area", { rows: "3", spellcheck: "false", id: "standing-keywords" });
  words.value = keywords.join(", ");
  const field = (text, input) => {
    const wrap = node("label", "sheet-field");
    wrap.append(node("span", "sheet-field-label", { text }), input);
    return wrap;
  };
  const { floor_slots: slots, floor_within: within, silence_hours: hours } = STANDING_NEW;
  const hint = node("p", "sheet-hint", {
    text: "A headline with any of these words or phrases counts as this story. Separate them with commas. "
      + `Today keeps ${slots === 1 ? "one of its stories" : `${slots} of its stories`} in the top ${within}, and shows a notice after ${hours} quiet hours.`,
  });
  const error = node("p", "sheet-error", { role: "alert" });
  error.hidden = true;
  const submit = node("button", "sheet-submit", { type: "submit", text: submitText });
  form.append(field("Name", name), field("Keywords", words), hint, error, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = await onSubmit(name.value, words.value);
    error.hidden = !message;
    error.textContent = message || "";
  });
  return form;
}
