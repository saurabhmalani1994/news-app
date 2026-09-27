// S16: the narrowing banner on Today (DESIGN-v1.1 section 6, breadth-number brief).
// Computed on the device only, from the opened-history store (history/store.js, S15):
// nothing here is server-rendered, since the history it reads never leaves the device
// (R23). A quiet line under the standing-story notices, same rhythm as the offline
// line and the notices above it, no colored panel; dismissible until the window's own
// numbers change (DISMISS_KEY below), never shown on insufficient data.
import { openedStore } from "./history/store.js";
import { weekOverWeek, formatNarrowingBanner } from "./breadth/math.js";

const DISMISS_KEY = "almanac.breadth.dismissed";

/** The window pair's own signature: as long as this string is unchanged, the reader
 * has dismissed this exact narrowing and it stays dismissed; once the rolling window
 * moves enough to change either score, a fresh signature shows the banner again if it
 * is still narrowed. */
function signature(result) {
  return `${result.current.score}|${result.previous.score}`;
}

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) || "";
  } catch {
    return "";
  }
}

function writeDismissed(sig) {
  try {
    localStorage.setItem(DISMISS_KEY, sig);
  } catch {
    // No localStorage: the banner simply cannot remember a dismissal this session.
  }
}

async function main() {
  const root = document.getElementById("breadth-banner");
  const text = document.getElementById("breadth-banner-text");
  const dismiss = document.getElementById("breadth-banner-dismiss");
  if (!root || !text || !dismiss) return;

  let records;
  try {
    records = await openedStore.list();
  } catch {
    return; // No IndexedDB, or it failed to open: the banner just stays hidden.
  }

  const result = weekOverWeek(records, Date.now());
  const line = formatNarrowingBanner(result);
  if (!line) return;

  const sig = signature(result);
  if (readDismissed() === sig) return;

  text.textContent = line;
  root.hidden = false;
  dismiss.addEventListener("click", () => {
    writeDismissed(sig);
    root.hidden = true;
  });
}

main();
