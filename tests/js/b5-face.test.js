// B5 proof (DESIGN-bundles section 4a and section 7): each story's face is its best
// version, the cron's bv sum plus the owner's trust term; a muted source never faces and
// is never counted; lean never moves the pick; the why-this sheet's "Leads because"
// terms sum to the lead's score; the lean quota reads the face; the other-side link is
// the best-scored version within its lean.
import { test } from "node:test";
import assert from "node:assert/strict";

import { rankPages } from "../../app/static/js/passes.js";
import { buildVersions, faceOf, leadTerms, leadsBecause, versionScore, versionsContext } from "../../app/static/js/versions.js";
import { explainLead } from "../../app/static/js/why-this.js";
import { visibleSourceCount } from "../../app/static/js/tiers.js";
import { buildDefaultProfile } from "../../app/static/js/profile/default-profile.js";

const NOW = "2026-09-25T12:00:00Z";
const iso = (hoursAgo) => new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const art = (id, source_id, hoursAgo, title = `Headline for ${id}`, topics = ["us_politics"]) =>
  ({ id, source_id, title, published_at: iso(hoursAgo), topics });
const profile = (edit = () => {}) => { const p = buildDefaultProfile(NOW); edit(p); return p; };

// An NPR and Fox bundle with a BBC version and a second Fox piece, Fox's first piece
// ahead by 2 points; a Fox-only story; and two quiet stories.
const ARTICLES = [
  art("npr1", "npr", 3, "Senate passes the budget bill 51 to 49"),
  art("fox1", "fox_news", 2, "GOP claims a win as the budget bill passes"),
  art("fox2", "fox_news", 5, "What the budget bill means for your taxes"),
  art("bbc1", "bbc_world", 4, "US Senate passes $1.2tn spending bill"),
  art("fox3", "fox_news", 1, "A Fox-only story nobody else ran"),
  art("q1", "quiet_a", 6, "A quiet story", ["science"]),
  art("q2", "quiet_b", 7, "Another quiet story", ["science"]),
];
const BV = {
  npr1: [20, 7, 0, 4, 0, 10, 0, 0], // 41
  fox1: [20, 15, 3, 2, 0, 3, 0, 0], // 43
  fox2: [20, 7, 0, 0, 0, 3, 0, 0], // 30
  bbc1: [20, 7, 0, 6, 0, 5, 0, 0], // 38
};
const LEANS = { npr: "center-left", fox_news: "right", bbc_world: "center" };
const NAMES = { npr: "NPR", fox_news: "Fox News", bbc_world: "BBC World", quiet_a: "Quiet A", quiet_b: "Quiet B" };
const CLUSTER = { id: "c1", article_ids: ["npr1", "fox1", "fox2", "bbc1"], near_duplicates: [], independent_sources: 3,
  lean_buckets: ["center", "center-left", "right"], lead: "fox1" };
const POOL = { generated_at: NOW, articles: ARTICLES, clusters: [CLUSTER] };
const INPUT = { pool: POOL, bv: BV, names: NAMES, leans: LEANS };
const OPTS = { leans: LEANS, names: NAMES, bv: BV };
const CTX = versionsContext(INPUT);
const byId = new Map(ARTICLES.map((a) => [a.id, a]));
const ids = (list) => list.map((s) => s.id);

test("an NPR and Fox bundle leads with whichever scores higher, and swapping their leans changes nothing", () => {
  const pages = rankPages(POOL, profile(), NOW, OPTS);
  assert.equal(pages.faces.c1, "fox1");
  assert.equal(buildVersions(CLUSTER, CTX)[0].id, "fox1");
  // NPR scoring higher leads instead.
  const swapped = { ...BV, npr1: BV.fox1, fox1: BV.npr1 };
  assert.equal(rankPages(POOL, profile(), NOW, { ...OPTS, bv: swapped }).faces.c1, "npr1");
  // Swapping the two outlets' leans moves no face, no slide and no card.
  const leans = { ...LEANS, npr: "right", fox_news: "center-left" };
  const again = rankPages(POOL, profile(), NOW, { ...OPTS, leans });
  assert.deepEqual(again.faces, pages.faces);
  assert.deepEqual(ids(buildVersions(CLUSTER, versionsContext({ ...INPUT, leans }))), ids(buildVersions(CLUSTER, CTX)));
  assert.deepEqual(ids(again.today), ids(pages.today));
});

test("with Fox muted, a Fox-only story never renders, and Fox is absent from the carousel and the count", () => {
  const muted = profile((p) => { p.mutes.sources = ["fox_news"]; });
  const pages = rankPages(POOL, muted, NOW, OPTS);
  const shown = [...pages.today, ...pages.sections.flatMap((s) => s.stories)];
  assert.ok(!shown.some((s) => s.id === "fox3"), "the Fox-only story never renders");
  assert.ok(pages.removed.some((s) => s.id === "fox3"));
  // The bundle stays, fronted by its best unmuted version, NPR.
  assert.ok(pages.today.some((s) => s.id === "c1"));
  assert.equal(pages.faces.c1, "npr1");
  const slides = buildVersions(CLUSTER, CTX, { muted: ["fox_news"] });
  assert.deepEqual(ids(slides), ["npr1", "bbc1"]);
  assert.ok(!JSON.stringify(slides).includes("fox_news"));
  assert.equal(visibleSourceCount(CLUSTER, byId, ["fox_news"]), 2);
  assert.equal(faceOf(CLUSTER, CTX, { muted: ["fox_news", "npr", "bbc_world"] }), "fox1", "all muted: the mute pass removes it");
});

test("raising NPR's trust to 1.5 flips a close pick, and the sheet names trust", () => {
  const trusted = profile((p) => { p.trust = { npr: 1.5 }; });
  const pages = rankPages(POOL, trusted, NOW, OPTS);
  assert.equal(pages.faces.c1, "npr1");
  const lead = explainLead(INPUT, "c1", trusted);
  assert.equal(lead.id, "npr1");
  assert.equal(lead.total, 41 + 21); // (1.5 - 1) x 41 = 20.5, rounded half up
  const trust = lead.rows.find((r) => r.term === "trust");
  assert.deepEqual([trust.value, trust.label], [21, "Trust, ×1.5 for NPR"]);
  assert.deepEqual(lead.because, ["your trust in NPR", "original reporting", "first to report"]);
  // At the default trust the sheet names no trust at all.
  const plain = explainLead(INPUT, "c1", profile());
  assert.equal(plain.id, "fox1");
  assert.ok(!plain.rows.some((r) => r.term === "trust"));
  assert.deepEqual(plain.because, ["original reporting", "full text", "depth"]);
});

test('"N sources" counts unmuted outlets, not articles', () => {
  assert.equal(CLUSTER.article_ids.length, 4);
  assert.equal(visibleSourceCount(CLUSTER, byId, []), 3, "Fox's two pieces are one outlet");
  assert.equal(buildVersions(CLUSTER, CTX).length, 3);
  assert.equal(visibleSourceCount(CLUSTER, byId, ["npr"]), 2);
});

test("the listed terms sum to the score, for every version and any trust", () => {
  for (const trust of [{}, { npr: 1.5 }, { fox_news: 0.4 }, { bbc_world: 2, npr: 1.3 }]) {
    for (const id of CLUSTER.article_ids) {
      const version = { id, sourceId: byId.get(id).source_id, bv: BV[id] };
      const terms = leadTerms(version, { trust, names: NAMES });
      assert.equal(terms.reduce((s, t) => s + t.value, 0), versionScore(version, { trust }).score, `${id} ${JSON.stringify(trust)}`);
      assert.ok(leadsBecause(terms).length <= 3);
    }
    const lead = explainLead(INPUT, "c1", profile((p) => { p.trust = trust; }));
    assert.equal(lead.rows.reduce((s, r) => s + r.value, 0), lead.total);
  }
  assert.equal(explainLead(INPUT, "q1", profile()), null, "an unscored story has no pick to explain");
});

test("the lean quota and the other side read the face's lean; the other side takes the best-scored version in its lean", () => {
  // Two right-lean versions of a 3+ source story led by NPR: the older one scores more.
  const arts = [art("n1", "npr", 1), art("r_new", "right_a", 0.5), art("r_old", "right_b", 6), art("c1a", "bbc_world", 2)];
  const bv = { n1: [20, 15, 5, 4, 0, 10, 0, 0], r_new: [0, 7, 0, 0, 0, 10, 0, 0], r_old: [20, 15, 4, 2, 0, 5, 0, 0], c1a: [20, 7, 0, 0, 0, 8, 0, 0] };
  const leans = { npr: "center-left", right_a: "right", right_b: "right", bbc_world: "center" };
  const pool = { generated_at: NOW, articles: arts, clusters: [{ id: "k", article_ids: arts.map((a) => a.id), near_duplicates: [],
    independent_sources: 4, lean_buckets: ["center", "center-left", "right"], lead: "n1" }] };
  const pages = rankPages(pool, profile(), NOW, { leans, bv });
  const k = pages.today.find((s) => s.id === "k");
  assert.equal(k.other_side.article_id, "r_old", "best-scored, not newest");
  assert.match(k.passes.find((e) => e.pass === "other-side").text, /the card itself leads with center-left$/);
  // Trusting the right outlet enough makes it the face: the card now leads with right,
  // so the other side comes from another lean.
  const trusted = rankPages(pool, profile((p) => { p.trust = { right_b: 1.5 }; }), NOW, { leans, bv });
  assert.equal(trusted.faces.k, "r_old");
  const k2 = trusted.today.find((s) => s.id === "k");
  assert.match(k2.passes.find((e) => e.pass === "other-side").text, /the card itself leads with right$/);
  assert.notEqual(leans[arts.find((a) => a.id === k2.other_side.article_id).source_id], "right");
});

test("must-know is unchanged: the face never changes a story's score, eligibility or place", () => {
  const a = rankPages(POOL, profile(), NOW, OPTS);
  const b = rankPages(POOL, profile((p) => { p.trust = { npr: 1.5 }; }), NOW, OPTS);
  const mk = (pages) => pages.today.map((s) => [s.id, s.must_know]);
  assert.deepEqual(mk(a), mk(b));
});
