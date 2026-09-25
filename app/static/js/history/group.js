// S34: the History segment's day grouping and its Seen filter, both pure so Node can
// test them without a page. Days are calendar days, "Today" and "Yesterday" against the
// device's own clock, then a plain date (DESIGN's QUEUE row: "grouped by day"). `now` is
// a Date.now()-shaped number throughout, never `new Date()` itself, so a caller (and a
// test) always names its own clock.
export const DAY_MS = 86_400_000;

const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

/** `ms`'s calendar day as "YYYY-MM-DD" in `timeZone` (the device's own zone when unset),
 * for same-day comparisons that do not care what the wall-clock time within the day was. */
function dayKey(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayFields(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** "Today", "Yesterday", or a plain date ("Sept. 20", "Sept. 20, 2025" once the year
 * differs from `nowMs`'s). Yesterday is `nowMs` less one day's worth of milliseconds,
 * close enough for a personal history screen; the one day a year a DST change could shift
 * it by an hour never moves it onto a different calendar day. */
export function historyDayLabel(ms, nowMs, { timeZone } = {}) {
  const key = dayKey(ms, timeZone);
  if (key === dayKey(nowMs, timeZone)) return "Today";
  if (key === dayKey(nowMs - DAY_MS, timeZone)) return "Yesterday";
  const { year, month, day } = dayFields(ms, timeZone);
  const thisYear = dayFields(nowMs, timeZone).year;
  return year === thisYear ? `${MONTHS[month - 1]} ${day}` : `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** `records` grouped by calendar day, newest day first and newest record first within a
 * day; a record with an unparsable `time` sorts last, under its own "Unknown" group,
 * rather than being dropped. Each group is `{key, label, records}`. */
export function groupHistoryByDay(records, nowMs, opts = {}) {
  const sorted = [...records].sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  const groups = [];
  const byKey = new Map();
  for (const record of sorted) {
    const ms = Date.parse(record.time);
    const known = Number.isFinite(ms);
    const key = known ? dayKey(ms, opts.timeZone) : "unknown";
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: known ? historyDayLabel(ms, nowMs, opts) : "Unknown", records: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.records.push(record);
  }
  return groups;
}

/** The rows the History segment shows: opened stories always, `shown` (seen but never
 * opened, R23's 14-day window) only when the Seen filter is on, and only for a story
 * that was never opened (an opened story already carries the stronger signal, so it
 * never needs to appear twice). Each row is tagged `kind: "opened"` or `"shown"`, for
 * the row's own "Opened"/"Seen" time label. */
export function visibleHistory(opened, shown, { seen = false } = {}) {
  const openedIds = new Set(opened.map((r) => r.id));
  const rows = opened.map((r) => ({ ...r, kind: "opened" }));
  if (seen) {
    for (const r of shown) if (!openedIds.has(r.id)) rows.push({ ...r, kind: "shown" });
  }
  return rows;
}
