// S11: build-time entry to the one ranker. Reads {pool, now, buckets, leans, names,
// health} as JSON on stdin, ranks with the shipped default profile
// (app/static/js/profile/default-profile.js), runs the S13 post-passes
// (app/static/js/passes.js) and writes {key, ranked, removed, sections, notices} as JSON
// on stdout for app/frontpage.py. `ranked` is Today in page order, each story with its score,
// explanation, pass entries and any other-side link; `removed` is what mute and dedup
// took, each saying why; `sections` is every section tab's ids after its own passes
// (S27's one table, app/static/js/sections.js), with their entries and links; `notices`
// is S28's silence alarm for Today (app/static/js/standing.js). Node only, no packages.
import { profileKey } from "./static/js/ranker.js";
import { rankPages, pageOptions } from "./static/js/passes.js";
import { buildDefaultProfile } from "./static/js/profile/default-profile.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const { pool, now } = input;
const profile = buildDefaultProfile(now);
const pages = rankPages(pool, profile, now, pageOptions(input));
const record = ({ id, score, explanation, must_know, passes, other_side }) => ({ id, score, explanation, must_know, passes, ...(other_side ? { other_side } : {}) });
const touched = (stories) => Object.fromEntries(stories.filter((s) => s.passes.length).map((s) => [s.id, s.passes]));
const links = (stories) => Object.fromEntries(stories.filter((s) => s.other_side).map((s) => [s.id, s.other_side]));
process.stdout.write(JSON.stringify({
  key: profileKey(profile),
  ranked: pages.today.map(record),
  removed: pages.removed.map(({ id, passes }) => ({ id, passes })),
  // S33: a "live" entry's ids are the current live event's own clusters (empty, and
  // the tab hidden, when none is live); event is {id, label} or null.
  sections: [
    { id: "today", label: "Today", slot: null, ids: pages.today.map((s) => s.id) },
    ...pages.sections.map((s) => ({ id: s.id, label: s.label, slot: s.slot, ids: s.stories.map((x) => x.id), passes: touched(s.stories), other_side: links(s.stories), event: s.event || null })),
  ],
  notices: pages.notices,
}));
