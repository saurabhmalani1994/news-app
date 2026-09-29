// J19: how reading with Jev works for this reader, measured from their own use, with no
// labelling. Each Read with Jev records how its marks spread (js/jev/read.js
// readingDensity), and whether the reader then used Skim or Hide marks; the Health
// screen shows the summary against targets fixed here before any data (js/jev/
// read-stats-view.js). Kept on this phone only (localStorage), never sent anywhere.

export const STATS_KEY = "almanac.jev.readstats.v1";
export const RECENT_CAP = 50;
export const MIN_READS = 10;

/** Targets fixed before any data, as the hourly scorecard's (fetcher/jev_shadow.py):
 * key, label, how to read the summary, the direction, the target. */
export const READING_TARGETS = Object.freeze([
  ["share_low", "Marked share of paragraphs, at least", (s) => s.avgShare, ">=", 0.15],
  ["share_high", "Marked share of paragraphs, at most", (s) => s.avgShare, "<=", 0.30],
  ["gap", "Longest unmarked run, on average (paragraphs)", (s) => s.avgGap, "<=", 8],
  ["hide", "Reads where you tapped Hide marks", (s) => s.hideRate, "<=", 0.30],
  ["empty", "Reads where Jev marked nothing", (s) => s.emptyRate, "<=", 0.20],
]);

function empty() {
  return { reads: 0, skims: 0, hides: 0, empties: 0, errors: 0, recent: [] };
}

function load(storage) {
  try {
    const data = JSON.parse(storage.getItem(STATS_KEY) || "null");
    if (data && typeof data === "object" && Number.isInteger(data.reads) && Array.isArray(data.recent)) return { ...empty(), ...data };
  } catch {
    // A corrupt record starts over.
  }
  return empty();
}

function save(storage, data) {
  try {
    storage.setItem(STATS_KEY, JSON.stringify(data));
  } catch {
    // Full storage only loses the record.
  }
}

/** One read that drew marks: its density ({marked, paragraphs, share, longestGap}). */
export function recordRead(storage, density, now = new Date().toISOString()) {
  const data = load(storage);
  data.reads += 1;
  if (!density.marked) data.empties += 1;
  data.recent.push({ at: now, paragraphs: density.paragraphs, marked: density.marked, share: Math.round(density.share * 1000) / 1000, gap: density.longestGap });
  if (data.recent.length > RECENT_CAP) data.recent.splice(0, data.recent.length - RECENT_CAP);
  save(storage, data);
}

/** One of: "skim" (turned Skim on), "hide" (tapped Hide marks), "error" (Jev did not answer). */
export function recordEvent(storage, kind) {
  const data = load(storage);
  if (kind === "skim") data.skims += 1;
  else if (kind === "hide") data.hides += 1;
  else if (kind === "error") data.errors += 1;
  save(storage, data);
}

/** The summary the Health screen shows, averages over the recent reads that marked
 * something, and each target's status: pass, fail, or not_enough_data below MIN_READS. */
export function readingSummary(storage) {
  const data = load(storage);
  const marked = data.recent.filter((r) => r.marked > 0);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const summary = {
    reads: data.reads,
    errors: data.errors,
    avgShare: mean(marked.map((r) => r.share)),
    avgGap: mean(marked.map((r) => r.gap)),
    skimRate: data.reads ? data.skims / data.reads : null,
    hideRate: data.reads ? data.hides / data.reads : null,
    emptyRate: data.reads ? data.empties / data.reads : null,
  };
  summary.checks = READING_TARGETS.map(([key, label, read, direction, target]) => {
    const value = read(summary);
    let status = "not_enough_data";
    if (data.reads >= MIN_READS && value !== null) status = (direction === ">=" ? value >= target : value <= target) ? "pass" : "fail";
    return { key, label, value, direction, target, status };
  });
  return summary;
}
