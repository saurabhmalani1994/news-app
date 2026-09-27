// S30 proof: the Coverage section's one-line count ("N outlets in M countries this
// week"), reusing coverage.js's own coverageContext rather than a second reader of the
// pool. Outlets with no country on file count as US (U3's own convention: a country code
// is only set for an outlet outside the US scale), and a muted outlet never counts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { followCoverageSummary } from "../../app/static/js/follow-coverage.js";

const ARTICLES = [
  { id: "a1", source_id: "npr", title: "US outlet, no country on file" },
  { id: "a2", source_id: "bbc_world", title: "GB outlet" },
  { id: "a3", source_id: "kyodo_news", title: "JP outlet" },
  { id: "a4", source_id: "fox_politics", title: "Also US" },
  { id: "a5", source_id: "muted_outlet", title: "Muted, never counted" },
];
const input = () => ({ pool: { articles: ARTICLES }, names: {}, leans: {}, countries: { bbc_world: "GB", kyodo_news: "JP" }, coverage: {} });

test("followCoverageSummary: distinct outlets and countries across every current match", () => {
  const stories = [
    { article_ids: ["a1", "a2"] },
    { article_ids: ["a3", "a4", "a5"] },
  ];
  const summary = followCoverageSummary(stories, input(), ["muted_outlet"]);
  assert.equal(summary.outlets, 4); // npr, bbc_world, kyodo_news, fox_politics; a5 muted
  assert.equal(summary.countries, 3); // US (npr, fox_politics), GB, JP
  assert.equal(summary.text, "4 outlets in 3 countries this week");
});

test("followCoverageSummary: singular wording at one and one", () => {
  const summary = followCoverageSummary([{ article_ids: ["a1"] }], input(), []);
  assert.equal(summary.text, "1 outlet in 1 country this week");
});

test("followCoverageSummary: no current matches reads as no coverage", () => {
  assert.equal(followCoverageSummary([], input(), []).text, "No coverage this week");
  assert.equal(followCoverageSummary(undefined, input(), []).text, "No coverage this week");
});

test("followCoverageSummary: an outlet with no country on file counts as US", () => {
  const summary = followCoverageSummary([{ article_ids: ["a1"] }], input(), []);
  assert.equal(summary.countries, 1);
});
