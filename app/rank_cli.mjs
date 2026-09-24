// S11: build-time entry to the one ranker. Reads {pool, now} as JSON on stdin, ranks
// with the shipped default profile (app/static/js/profile/default-profile.js), and
// writes {key, ranked} as JSON on stdout for app/frontpage.py. Node only, no packages.
import { rank, profileKey } from "./static/js/ranker.js";
import { buildDefaultProfile } from "./static/js/profile/default-profile.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { pool, now } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const profile = buildDefaultProfile(now);
const ranked = rank(pool, profile, now).map(({ id, score, explanation, must_know }) => ({ id, score, explanation, must_know }));
process.stdout.write(JSON.stringify({ key: profileKey(profile), ranked }));
