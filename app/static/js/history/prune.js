// S15: retention (DESIGN-v1.1 section 7, R23). Opened keeps a year, shown-but-not-
// opened keeps 14 days; pruned on startup, not on every write, so an ordinary page
// load stays cheap and a burst of scrolling never triggers a sweep mid-session.
// `store` is the {get, put, delete, list} shape history/store.js exports, or a plain
// stand-in in tests.
export const DAY_MS = 86_400_000;
export const OPENED_RETENTION_MS = 365 * DAY_MS;
export const SHOWN_RETENTION_MS = 14 * DAY_MS;

const epochMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Every record in `store` older than `retentionMs` as of `nowMs`, deleted. Returns
 * the ids removed, so a caller (prune.js's own pruneHistory, or a test) can also drop
 * them from the compact localStorage summary. */
export async function pruneStore(store, retentionMs, nowMs) {
  const all = await store.list();
  const stale = all.filter((rec) => nowMs - epochMs(rec.time) > retentionMs).map((rec) => rec.id);
  for (const id of stale) await store.delete(id);
  return stale;
}

/** Both stores, their own retention window. `now` is a Date.now()-shaped number. */
export async function pruneHistory({ openedStore, shownStore }, now = Date.now()) {
  const [opened, shown] = await Promise.all([
    pruneStore(openedStore, OPENED_RETENTION_MS, now),
    pruneStore(shownStore, SHOWN_RETENTION_MS, now),
  ]);
  return { opened, shown };
}
