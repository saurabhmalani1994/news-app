// S34: the History segment's local text search, over headlines and outlet names only,
// nothing else and nothing sent anywhere (the ask is explicit: "nothing leaves the
// phone"). A plain case-insensitive substring match, the same quiet rule Ctrl-F uses;
// no ranking, no fuzzy match, so what matched is always obvious.
export function searchHistory(records, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return records;
  return records.filter((r) => (r.title || "").toLowerCase().includes(q) || (r.source || "").toLowerCase().includes(q));
}
