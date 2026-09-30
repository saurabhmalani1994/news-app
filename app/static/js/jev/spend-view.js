// J25: the Health screen's "Your phone's Jev use today" row (app/health.py JEV_TODAY),
// from GET /api/jev's phone_budget: what the Ask bar, Jev's read and Read with Jev spent
// today against their daily lane. Set as text; the row stays hidden when there is
// nothing to show (offline, not signed in, the free route).

const row = document.getElementById("jev-phone-spend");
const value = document.getElementById("jev-phone-spend-value");

async function fill() {
  if (!row || !value) return;
  try {
    const res = await fetch("/api/jev", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok || res.redirected) return;
    const budget = (await res.json())?.phone_budget;
    if (!budget || typeof budget.cap_usd !== "number") return;
    value.textContent = budget.unenforced
      ? `limit $${budget.cap_usd.toFixed(2)} (not tracked here)`
      : `$${Number(budget.usd || 0).toFixed(3)} of $${budget.cap_usd.toFixed(2)}, ${budget.calls || 0} call${budget.calls === 1 ? "" : "s"}`;
    row.hidden = false;
  } catch {
    // Offline or signed out: the row stays hidden.
  }
}

fill();
