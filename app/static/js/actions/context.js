// S24: the attributes a thumb, a save or a mute/boost action reads off a story, from
// the page's own embedded ranking input (app/frontpage.py rank_input, the same JSON
// rank-gate.js, tabs.js and reader.js already read) plus the tab and rank the DOM row
// says it was shown at. Pure given that input, so it is Node-testable without a page.

/** {id, topics, source, source_name, lean, cluster_size} for story `sid`. `source` is
 * the source id (for Mute source); `topics` are the lead article's own pool tags (for
 * Mute/Boost topic and the thumb record); cluster_size is R19's "the story's
 * attributes" independent-source count, 1 for an unclustered story. */
export function storyAttributes(input, sid) {
  const byId = new Map((input.pool?.articles || []).map((a) => [a.id, a]));
  const cluster = (input.pool?.clusters || []).find((c) => c.id === sid);
  const articleId = cluster ? cluster.lead : sid;
  const article = byId.get(articleId) || byId.get(sid) || {};
  const sourceId = article.source_id || null;
  return {
    id: sid,
    article_id: article.id || sid,
    topics: article.topics || [],
    source: sourceId,
    source_name: (input.names || {})[sourceId] || sourceId || "",
    lean: (input.leans || {})[sourceId] || null,
    cluster_size: cluster ? (cluster.independent_sources ?? cluster.article_ids?.length ?? 1) : 1,
  };
}

/** The story (cluster) id that fronts article `articleId`, for the reader (S25),
 * which only knows the lead article's id (app/build.py body_id): the cluster whose
 * `lead` is this article, or the article's own id when it is not clustered. Keeps a
 * thumb recorded from the reader keyed the same way as one recorded from the card. */
export function storyIdForArticle(input, articleId) {
  const cluster = (input.pool?.clusters || []).find((c) => c.lead === articleId);
  return cluster ? cluster.id : articleId;
}

/** The tab (section id) and 1-based rank a story row was shown at, read from the DOM:
 * its panel's own `data-section`, and its position among the story rows in its own
 * list (top river, "more" or "rest"). Browser only (reads layout), not Node-tested. */
export function domPlacement(li) {
  const panel = li.closest(".panel");
  const tab = panel?.dataset.section || "today";
  const list = li.closest("ol.river");
  const rank = list ? [...list.children].filter((n) => n.matches?.("li.story[data-sid]")).indexOf(li) + 1 : null;
  return { tab, rank: rank && rank > 0 ? rank : null };
}
