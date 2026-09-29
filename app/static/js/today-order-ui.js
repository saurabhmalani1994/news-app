// J22: the For you / Latest / Urgent switch at the top of Today (app/build.py). The
// stored choice is already on <html> as an order-* class (rank-gate.js), which the page's
// style shows before first paint; this sets aria-pressed to match, and a tap saves the
// choice on this phone, re-orders Today (story-actions.js rerenderAfterProfileChange
// reads it) and shows Today from its top.

import { ORDERS, readOrder, saveOrder } from "./today-order.js";
import { getStore, rerenderAfterProfileChange } from "./story-actions.js";

const root = document.documentElement;
const group = document.getElementById("today-order");

function mark(order) {
  for (const o of ORDERS) root.classList.toggle(`order-${o.replace("_", "-")}`, o === order);
  for (const b of group?.querySelectorAll(".today-order-btn") || []) b.setAttribute("aria-pressed", String(b.dataset.order === order));
}

async function choose(order) {
  if (!ORDERS.includes(order) || order === (window.almanacTodayOrder || "for_you")) return;
  saveOrder(window.localStorage, order);
  window.almanacTodayOrder = order;
  mark(order);
  let profile = window.almanacProfile;
  if (!profile) {
    try {
      profile = (await getStore()).current();
    } catch {
      return;
    }
  }
  rerenderAfterProfileChange(profile, null);
  const panel = document.getElementById("section-today");
  if (panel) panel.scrollTop = 0;
}

if (group) {
  if (!window.almanacTodayOrder) window.almanacTodayOrder = readOrder(window.localStorage);
  mark(window.almanacTodayOrder);
  group.addEventListener("click", (event) => {
    const button = event.target.closest(".today-order-btn");
    if (button) choose(button.dataset.order);
  });
}
