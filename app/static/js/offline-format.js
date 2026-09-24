// S18: the pure formatting behind the offline line and the offline meta-age refresh,
// split out from js/offline.js (a classic, DOM-touching script, not a module) so it is
// unit-testable under Node (tests/js/offline-format.test.js). js/offline.js keeps its
// own copy of relativeAge inline, kept byte-for-byte identical to this one (checked by
// that same test), because it must run as a synchronous classic script at a fixed point
// in the page for zero layout shift, which rules out a static `import`.
//
// Mirrors app/build.py's relative_age exactly, just against the device's real clock
// instead of the pool's own generated_at (D1: the build-time age goes stale offline).

export function relativeAge(publishedAt, now) {
  const then = Date.parse(publishedAt);
  if (Number.isNaN(then) || !now) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60000));
  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

/** The quiet line under the nameplate: "Offline. Showing news from 2h ago". */
export function offlineLineText(generatedAt, now) {
  const age = relativeAge(generatedAt, now);
  return age ? `Offline. Showing news from ${age}` : "Offline. Showing cached news.";
}

const AGE_RE = /\d+(?: min|[hd]) ago$/;

/** A row's existing `.meta-rest` text with only its trailing age token swapped for
 * `freshAge`, whatever led it (a source name, "N sources", the middot) kept as is. */
export function refreshedMetaText(oldText, freshAge) {
  if (!freshAge || !AGE_RE.test(oldText)) return oldText;
  return oldText.replace(AGE_RE, freshAge);
}
