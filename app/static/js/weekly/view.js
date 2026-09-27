// S29: the You page's #weekly view, the weekly review's suggestions with Accept and
// Skip, the week's accepted changes with one Undo, and the patterns that point at
// nothing the review may change, collapsed. Text only (R26): every string, the
// sentences included, goes in through textContent via the page's own `el` helper.
// The page (profile-screen.js) owns the store, the handlers and the redraw; this file
// only lays out nodes, so it stays small and the page's own file barely changes.

const word = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmt = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(Math.round(x * 100) / 100));

/**
 * @param {object} ctx
 *   el, section         the page's own node helpers
 *   data                undefined while history is read, null when it failed, else
 *                       {review, state} (weekly/review.js, weekly/state.js)
 *   onAccept(item), onSkip(item), onUndo()
 */
export function weeklyView({ el, section, data, onAccept, onSkip, onUndo }) {
  if (data === undefined) return [el("p", { class: "settings-hint settings-hint--top", text: "Reading your history. Open this page again in a moment." })];
  if (data === null) return [el("p", { class: "settings-hint settings-hint--top", text: "Your reading history could not be read just now. Open this page again to retry." })];
  const { review, state } = data;

  const items = review.proposals.map((item) => el("div", { class: "setting-row setting-row--stack weekly-item", "data-path": item.path }, [
    el("p", { class: "weekly-sentence", text: item.sentence }),
    el("div", { class: "weekly-actions" }, [
      el("button", { class: "weekly-action", type: "button", "data-action": "accept", "data-focus-key": `accept-${item.path}`, text: "Accept", onclick: () => onAccept(item) }),
      el("button", { class: "weekly-action weekly-action--quiet", type: "button", "data-action": "skip", "data-focus-key": `skip-${item.path}`, text: "Skip", onclick: () => onSkip(item) }),
    ]),
  ]));

  const intro = review.total.shown
    ? `From the last 7 days: ${word(review.total.shown, "story", "stories")} shown, ${review.total.opened} opened. Nothing changes until you accept.`
    : "No reading recorded in the last 7 days yet.";
  const nodes = [
    section("This week", () => [
      el("p", { class: "settings-hint settings-hint--top", id: "weekly-intro", text: intro }),
      ...(items.length ? items : [el("p", { class: "settings-hint", id: "weekly-empty", text: review.slots ? "No suggestions this week." : "This week's changes are done. More next week." })]),
      review.held.length
        ? el("p", { class: "settings-hint", id: "weekly-held", text: `Breadth is down this week, so ${word(review.held.length, "suggestion")} that would narrow your reading ${review.held.length === 1 ? "is" : "are"} held back.` })
        : null,
    ], { id: "weekly-proposals" }),
  ];

  if (state.accepted.length) {
    nodes.push(section("Accepted this week", () => [
      ...state.accepted.map((a) => el("div", { class: "setting-row weekly-accepted" }, [
        el("span", { class: "setting-label", text: a.label || a.path }),
        el("span", { class: "setting-value", text: `${fmt(a.old_value)} to ${fmt(a.new_value)}` }),
      ])),
      el("button", { class: "btn-row", type: "button", id: "weekly-undo", text: state.accepted.length === 1 ? "Undo this change" : "Undo this week's changes", onclick: () => onUndo() }),
    ], { id: "weekly-accepted" }));
  }

  if (review.noticed.length) {
    nodes.push(el("details", { class: "settings-section weekly-noticed", id: "weekly-noticed" }, [
      el("summary", { class: "settings-label" }, [document.createTextNode("Also noticed"), el("span", { class: "setting-chevron", "aria-hidden": "true", text: "›" })]),
      el("div", { class: "weekly-noticed-body" }, review.noticed.map((n) => el("p", { class: "settings-hint weekly-noticed-line", text: n.sentence }))),
    ]));
  }
  return nodes;
}
