// S34: what a tap on a History row does, pure so Node can test the decision without a
// page. Stories leave the live pool within days (the pool itself turns over in about
// 72h), so a row's reopen choice is: the in-app reader when the body is still cached on
// the device (js/reader/cache.js) or the story is still in the live pool with a body;
// otherwise a link out to the outlet, the record's own url. Never "try the network and
// see": a body file that outlived both the cache and the pool is not treated as a third
// case, since the ask names exactly two.

/** The article id a row reopens: the record's own `article_id` (S34), or, for a record
 * written before that field existed, the story id itself, correct for the common
 * unclustered case and the best guess for the rest. Never throws on a bare `{}`. */
export function articleIdFor(record) {
  if (!record) return null;
  return record.article_id || record.id || null;
}

/**
 * The reopen decision for `record`: `{mode: "reader", id}` (open article `id` in the
 * in-app reader), `{mode: "link", url}` (link out), or `{mode: "none"}` (neither a
 * cached body, a live one, nor a url to fall back to). `cached` and `poolHasBody` are
 * booleans the caller has already worked out (bodyCache.get(id) and a check of the
 * page's own embedded pool), kept out of this module so it stays a pure decision.
 */
export function reopenTarget(record, { cached = false, poolHasBody = false } = {}) {
  const id = articleIdFor(record);
  if (id && (cached || poolHasBody)) return { mode: "reader", id };
  if (record && record.url) return { mode: "link", url: record.url };
  return { mode: "none" };
}
