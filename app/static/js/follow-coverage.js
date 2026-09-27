// S30: the one-line coverage count for a follow's page ("14 outlets in 6 countries this
// week"), reusing coverage.js's own context builder (coverageContext) rather than a new
// reader of the pool's articles and sources. Distinct unmuted outlets and the distinct
// countries they answer from, across every one of the follow's current clusters; an
// outlet with no country on file (ctx.countries, U3) is a US outlet by that field's own
// convention (only an outlet outside the US scale carries one), so it counts as "US".
import { coverageContext } from "./coverage.js";

/** {outlets, countries, text} for a follow's current matches (`stories`, ranker.js
 * story records from following.js's followMatches). `input` is the page's own decoded
 * #rank-input; `muted` is the viewer's profile.mutes.sources. */
export function followCoverageSummary(stories, input, muted = []) {
  const ctx = coverageContext(input, { muted });
  const outlets = new Set();
  const countries = new Set();
  for (const story of stories || []) {
    for (const articleId of story.article_ids || []) {
      const article = ctx.articleById.get(articleId);
      if (!article || ctx.muted.has(article.source_id)) continue;
      outlets.add(article.source_id);
      countries.add(ctx.countries[article.source_id] || "US");
    }
  }
  const n = outlets.size;
  const c = countries.size;
  const text = n ? `${n} ${n === 1 ? "outlet" : "outlets"} in ${c} ${c === 1 ? "country" : "countries"} this week` : "No coverage this week";
  return { outlets: n, countries: c, text };
}
