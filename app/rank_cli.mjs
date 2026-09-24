// S11: build-time entry to the one ranker. Reads {pool, now, buckets} as JSON on stdin,
// ranks with the shipped default profile (app/static/js/profile/default-profile.js), and
// writes {key, ranked, sections} as JSON on stdout for app/frontpage.py. S27: sections
// is every section tab's story ids in ranked order (app/static/js/sections.js), so the
// build names the tabs from the one table. Node only, no packages.
import { rank, profileKey } from "./static/js/ranker.js";
import { buildDefaultProfile } from "./static/js/profile/default-profile.js";
import { sectionLists } from "./static/js/sections.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { pool, now, buckets } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const profile = buildDefaultProfile(now);
const full = rank(pool, profile, now);
const ranked = full.map(({ id, score, explanation, must_know }) => ({ id, score, explanation, must_know }));
process.stdout.write(JSON.stringify({ key: profileKey(profile), ranked, sections: sectionLists(full, buckets || {}) }));
