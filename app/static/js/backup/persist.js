// S35 (R24): navigator.storage.persist() once on first run. Local storage in the
// browser sense can be cleared under pressure unless the origin is "persisted"; asking
// once and recording the outcome, quietly, is what the brief asks for ("never nag").
//
// Pure here (ensurePersisted takes every browser call as an argument) so
// tests/js/persist.test.js runs the decision logic under Node with no real
// navigator.storage; init() below is the one browser-facing entry point, called once
// from profile-screen.js.

export const PERSIST_KEY = "almanac.storage.persist.v1";

/** The stored record, or null if nothing has been recorded yet (a corrupt value reads
 * as null too, so a bad write never wedges the first-run check forever). */
export function readPersistRecord(storage) {
  try {
    const data = JSON.parse(storage.getItem(PERSIST_KEY) || "null");
    if (data && typeof data.outcome === "string" && typeof data.checked_at === "string") return data;
    return null;
  } catch {
    return null;
  }
}

function write(storage, record) {
  try { storage.setItem(PERSIST_KEY, JSON.stringify(record)); } catch { /* best effort, checked again next load */ }
  return record;
}

/**
 * Runs the first-run check once (a stored record short-circuits every later call, so
 * this never nags): asks whether the origin is already persisted, and if not, asks the
 * browser to persist it, then records exactly one outcome, "granted", "denied" or
 * "unsupported". `now` is injectable for deterministic tests.
 */
export async function ensurePersisted({ storage, supported, persisted, requestPersist, now = () => new Date().toISOString() }) {
  const existing = readPersistRecord(storage);
  if (existing) return existing;
  if (!supported) return write(storage, { checked_at: now(), outcome: "unsupported" });
  let already = false;
  try { already = Boolean(await persisted()); } catch { already = false; }
  if (already) return write(storage, { checked_at: now(), outcome: "granted" });
  let granted = false;
  try { granted = Boolean(await requestPersist()); } catch { granted = false; }
  return write(storage, { checked_at: now(), outcome: granted ? "granted" : "denied" });
}

/** The quiet You-page line for a record (or none read yet). */
export function persistLabel(record) {
  return record && record.outcome === "granted" ? "Storage: kept" : "Storage: may be cleared by the browser";
}

/** The browser entry point: real navigator.storage, real localStorage by default. */
export function initStoragePersistence(storage = window.localStorage) {
  const supported = Boolean(navigator.storage && navigator.storage.persist);
  return ensurePersisted({
    storage,
    supported,
    persisted: () => navigator.storage.persisted(),
    requestPersist: () => navigator.storage.persist(),
  });
}
