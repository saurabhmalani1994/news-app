// J40: the one switch for Jev (owner, 2026-11-16: "pause using Jev for now"). While it is
// true nothing asks Jev anything: the hourly Jev step reads and changes nothing
// (fetcher/jev_shadow.py), the keep rule ignores Jev's earlier answers (fetcher/fanout.py),
// /api/jev refuses with reason "paused" (functions/api/jev.js), and the page leaves out
// the Ask bar and Read with Jev. Answers already saved on a phone still show. To resume,
// set it to false and merge; nothing else needs to change. fetcher/jev_switch.py reads
// this very line, so the server and the page can never disagree.
export const JEV_PAUSED = true;
