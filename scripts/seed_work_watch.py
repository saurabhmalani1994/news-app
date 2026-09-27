"""B11: seed the owner's work watch rules straight into the interests KV store.

This writes nothing by itself. It reads a rules file, checks the rules with the very
function the site uses (functions/api/interests.js validatePayload, run under Node),
reads the current KV value for one user, merges only the work rules into it, and prints
the one `wrangler kv key put` command that would store the result. The owner (or the
orchestrator) runs that command by hand.

The rules file is either the S35 work watch file the You page imports
({"format_version": 3, "scope": "work_watch", "profile": {"work_watch": [...]}}) or a
bare list of rules, each {id, label, tier, terms, pair_any, exclude, exact}.

Which KV key: the Pages Function stores each reader's value under the SHA-256 hex of
their Cloudflare Access email, trimmed and lowercased (functions/api/interests.js
userKey). Pass that hex with --key, or pass --email and this script hashes it the same
way. It never guesses an email.

What is kept: the stored phrase and standing-story queries stay exactly as they are; the
value becomes {"v": 2, "queries": <as stored>, "work": <the rules, each with its tag>}.
The phone takes these rules into its own profile at its next sync while it has none of
its own (app/static/js/interests-sync.js), and from then on sends its own list.

    python scripts/seed_work_watch.py RULES.json --email ADDRESS --namespace-id ID
        dry run (the default): rule labels and counts only; nothing written
    python scripts/seed_work_watch.py RULES.json --key HEX --namespace-id ID --write-file
        also writes the merged value to a temp file and prints the exact command,
        which passes that file with --path, never the value on the command line
    --current-file PATH reads the current value from a file instead of from KV (tests).

Terms are never printed. Exit 0 on success, 1 when the rules or the merge fail the
site's own check, 2 on a usage or read error.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WRANGLER = ["npx", "--yes", "wrangler@4.137.0"]
KEY_RE = re.compile(r"^[0-9a-f]{64}$")
RULE_KEYS = ("id", "label", "tier", "terms", "pair_any", "exclude", "exact")

# validatePayload from the site's own function, fed the payload on stdin.
CHECK_JS = """
import { validatePayload } from "./functions/api/interests.js";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const result = await validatePayload(JSON.parse(Buffer.concat(chunks).toString("utf8")));
process.stdout.write(JSON.stringify(result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }));
"""


def user_key(email):
    """functions/api/interests.js userKey: SHA-256 hex of the trimmed, lowercased email."""
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def work_tag(rule_id):
    """The rule's watch tag, as work-watch.js workTag and fetcher/workwatch.py work_tag."""
    normalized = " ".join(f"work:{rule_id}".strip().lower().split())
    return "w:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:10]


def load_rules(path):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(doc, dict):
        if doc.get("scope") != "work_watch" or not isinstance(doc.get("profile"), dict):
            raise ValueError("expected a work watch file (scope work_watch) or a list of rules")
        doc = doc["profile"].get("work_watch")
    if not isinstance(doc, list):
        raise ValueError("no rule list found")
    return doc


def payload_rules(rules):
    """The rules as the phone sends them: every profile field plus the tag."""
    out = []
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError("a rule is not an object")
        item = {k: rule.get(k) for k in RULE_KEYS}
        out.append({"id": item["id"], "label": item["label"], "tag": work_tag(str(item["id"])), "tier": item["tier"],
                    "terms": item["terms"], "pair_any": item["pair_any"] if item["pair_any"] is not None else [],
                    "exclude": item["exclude"] if item["exclude"] is not None else [], "exact": item["exact"] is True})
    return out


def merged_value(current, rules):
    """The stored value with only its work rules replaced; queries kept as stored."""
    queries = current.get("queries", []) if isinstance(current, dict) else []
    return {"v": 2, "queries": queries, "work": payload_rules(rules)}


def site_check(value, node="node"):
    """functions/api/interests.js validatePayload on value: (ok, stored value or error)."""
    out = subprocess.run([node, "--input-type=module", "-e", CHECK_JS], input=json.dumps(value).encode("utf-8"),
                         capture_output=True, cwd=str(REPO))
    if out.returncode != 0:
        return False, "the site's check did not run (is Node installed?)"
    result = json.loads(out.stdout.decode("utf-8"))
    return (True, result["value"]) if result["ok"] else (False, result["error"])


def read_current(args, key):
    if args.current_file:
        text = Path(args.current_file).read_text(encoding="utf-8").strip()
        return json.loads(text) if text else None
    npx = shutil.which("npx")
    if not npx:
        raise RuntimeError("npx is not on PATH")
    cmd = [npx, *WRANGLER[1:], "kv", "key", "get", key, "--namespace-id", args.namespace_id, "--remote"]
    out = subprocess.run(cmd, capture_output=True, cwd=str(REPO))
    if out.returncode != 0:
        text = out.stderr.decode("utf-8", "replace")
        if "not found" in text.lower() or "404" in text:
            return None
        raise RuntimeError("wrangler kv key get failed")
    text = out.stdout.decode("utf-8").strip()
    return json.loads(text) if text else None


def main(argv=None):
    ap = argparse.ArgumentParser(description="Seed work watch rules into the interests KV store (prints the command).")
    ap.add_argument("rules", help="a work watch file or a JSON list of rules")
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument("--key", help="the KV key: SHA-256 hex of the owner's Access email")
    who.add_argument("--email", help="the owner's Access email, hashed here into the key")
    ap.add_argument("--namespace-id", required=True, help="the almanac-interests KV namespace id")
    ap.add_argument("--current-file", help="read the current value from this file, not from KV")
    ap.add_argument("--write-file", action="store_true", help="write the merged value to a temp file and print the put command")
    args = ap.parse_args(argv)

    key = args.key.lower() if args.key else user_key(args.email)
    if not KEY_RE.match(key):
        print("seed: --key must be 64 hex characters", file=sys.stderr)
        return 2
    try:
        rules = load_rules(args.rules)
        current = read_current(args, key)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"seed: {type(exc).__name__}: could not read the rules or the current value", file=sys.stderr)
        return 2
    if current is not None and not (isinstance(current, dict) and current.get("v") in (1, 2)):
        print("seed: the current value is not a version 1 or 2 interests value; not merging", file=sys.stderr)
        return 1
    value = merged_value(current, rules)
    ok, checked = site_check(value)
    if not ok:
        print(f"seed: the site's own check refuses the merged value: {checked}", file=sys.stderr)
        return 1
    size = len(json.dumps(checked, separators=(",", ":")).encode("utf-8"))
    tiers = {t: sum(1 for r in checked["work"] if r["tier"] == t) for t in (1, 2, 3, 4)}
    before = len(current.get("work", [])) if isinstance(current, dict) else 0
    print(f"seed: key {key[:8]}... current value: {'none' if current is None else 'v' + str(current.get('v'))}, "
          f"{len(checked['queries'])} queries kept, {before} work rules replaced")
    print(f"seed: {len(checked['work'])} rules (tier 1: {tiers[1]}, 2: {tiers[2]}, 3: {tiers[3]}, 4: {tiers[4]}), "
          f"{sum(len(r['terms']) for r in checked['work'])} terms, value {size} bytes (limit 32768)")
    for r in checked["work"]:
        print(f"  tier {r['tier']}  {r['label']}  ({len(r['terms'])} terms, {len(r['pair_any'])} pair, "
              f"{len(r['exclude'])} exclude{', exact' if r['exact'] else ''})")
    if not args.write_file:
        print("seed: dry run, nothing written. Add --write-file to write the value and print the put command.")
        return 0
    fd, path = tempfile.mkstemp(prefix="almanac-work-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(checked, fh, separators=(",", ":"))
    print("seed: value written. To store it, run:")
    print(f'  {" ".join(WRANGLER)} kv key put {key} --namespace-id {args.namespace_id} --path "{path}" --remote')
    print("seed: then delete that temp file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
