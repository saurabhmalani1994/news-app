// S17: the pure logic behind the Health screen's pool-age line. relativeAge is
// js/offline-format.js's own (S18), imported rather than copied since this file is a
// real ES module, not a classic script. js/health-age.js keeps its own inline copy of
// everything here, byte-for-byte, because it must run as a synchronous classic script
// at a fixed point in the page for zero layout shift (the same reason js/offline.js
// cannot statically import js/offline-format.js either); tests/js/health-format.test.js
// diffs the two copies.

import { relativeAge } from "./offline-format.js";

// Cadence is 30 to 60 minutes (R30). fetcher/health.py already settled on "3 times the
// cadence" as a single source's own unhealthy threshold; the same reasoning applied to
// the whole pool gives 3 hours (app/health.py's STALE_THRESHOLD_SECONDS, kept equal).
export const STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000;

export function isStale(generatedAt, now, thresholdMs = STALE_THRESHOLD_MS) {
  const then = Date.parse(generatedAt);
  if (Number.isNaN(then) || !now) return false;
  return now - then > thresholdMs;
}

/** The pool-age line's full text, from the device's real clock. */
export function poolAgeText(generatedAt, now) {
  const age = relativeAge(generatedAt, now);
  if (!age) return "Pool age unknown.";
  return isStale(generatedAt, now) ? `Stale. Last updated ${age}.` : `Updated ${age}.`;
}
