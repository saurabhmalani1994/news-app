"""B11: the private leak guard. Run it before every push.

The owner's work watch list is confidential and lives outside this repo (the repo, its
Actions logs and artifacts are public). When that list is present on this machine, this
script extracts every term from it and fails when one appears where it must never be:

- any tracked file in the working tree, and any new file git would pick up,
- the added lines of `git diff <base>` (default origin/main), and
- the commit messages of `<base>..HEAD`.

A term already present in the repo at BASELINE (B10, the reviewed commit that added the
generic industrial terms and company names on purpose) is not private and is skipped;
so is any single word that was already there. Everything else in the list counts: each
list item whole, and each of its words of four or more letters.

Where the list is: $ALMANAC_WORK_WATCH_SOURCE, else DEFAULT_SOURCE below (outside the
repo). When it is absent (CI, another machine) the guard prints "skipped" and passes.
It never prints a term: a hit is reported by file and line only.

    python scripts/private_leak_guard.py [--base origin/main]

Exit 0 clean or skipped, 1 on a hit, 2 on a usage or git error.
"""
import argparse
import io
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path

BASELINE = "051efacb50b4aacc253290dbaa8475c69bb09188"
DEFAULT_SOURCE = (Path.home() / "OneDrive - Personal" / "OneDrive" / "Saurabh" / "Personal Projects"
                  / "News App" / "private" / "work-watch-source.md")
ENV_NAME = "ALMANAC_WORK_WATCH_SOURCE"
MIN_WORD = 4
REPO = Path(__file__).resolve().parents[1]


def extract_terms(text):
    """Every term in the list: each comma, slash or parenthesis separated part of each
    bullet line, each quoted word in its notes, and each word of MIN_WORD letters or
    more from those. Comment lines (#) and headings are not terms."""
    items = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("*"):
            continue
        line = line.lstrip("* ").strip()
        items.update(q.strip() for q in re.findall(r'"([^"]+)"', line))
        line = re.sub(r'"[^"]*"', " ", line)
        head = line.split(":", 1)[0] if re.match(r"^[^,]*:", line) else line
        for part in re.split(r"[,/()]|\bor\b|\band\b", head):
            part = " ".join(part.split()).strip(" .;:")
            if part:
                items.add(part)
    words = {w for item in items for w in re.findall(r"[^\W_][^\W_*.'-]*(?:[*.'-][^\W_]+)*", item) if len(w) >= MIN_WORD}
    return {t for t in items | words if len(t) >= 2}


def pattern(term):
    """A term as a case-insensitive whole-word regex."""
    return re.compile(r"(?<![0-9A-Za-z])" + re.escape(term) + r"(?![0-9A-Za-z])", re.IGNORECASE)


def git(*args):
    out = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed")
    return out.stdout.decode("utf-8", "replace")


def baseline_text():
    """Every text file of the repo at BASELINE, read from one `git archive`."""
    out = subprocess.run(["git", "-C", str(REPO), "archive", "--format=tar", BASELINE], capture_output=True)
    if out.returncode != 0:
        raise RuntimeError("git archive failed")
    chunks = []
    with tarfile.open(fileobj=io.BytesIO(out.stdout)) as tar:
        for member in tar:
            if member.isfile():
                data = tar.extractfile(member).read()
                if b"\0" not in data[:4096]:
                    chunks.append(data.decode("utf-8", "replace"))
    return "\n".join(chunks)


def private_terms(terms, public_text):
    return sorted((t for t in terms if not pattern(t).search(public_text)), key=str.lower)


def scan(label, text, patterns):
    """[(where, term index)] for every line of text that holds a private term."""
    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        for i, p in enumerate(patterns):
            if p.search(line):
                hits.append((f"{label}:{n}", i))
    return hits


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fail when a private work watch term is in the repo.")
    ap.add_argument("--base", default="origin/main")
    args = ap.parse_args(argv)
    source = Path(os.environ.get(ENV_NAME) or DEFAULT_SOURCE)
    try:
        inside = source.resolve().is_relative_to(REPO)
    except OSError:
        inside = False
    if inside:
        print("leak guard: the private list must live outside the repo", file=sys.stderr)
        return 2
    if not source.is_file():
        print("leak guard: skipped (no private list on this machine)")
        return 0
    try:
        terms = private_terms(extract_terms(source.read_text(encoding="utf-8")), baseline_text())
        patterns = [pattern(t) for t in terms]
        hits = []
        tracked = git("ls-files").splitlines() + git("ls-files", "--others", "--exclude-standard").splitlines()
        for name in tracked:
            path = REPO / name
            try:
                data = path.read_bytes()
            except OSError:
                continue
            if b"\0" in data[:4096]:
                continue
            hits += scan(name, data.decode("utf-8", "replace"), patterns)
        added = "\n".join(line[1:] for line in git("diff", args.base, "--", ".").splitlines()
                          if line.startswith("+") and not line.startswith("+++"))
        hits += scan("diff", added, patterns)
        hits += scan("commits", git("log", "--format=%B", f"{args.base}..HEAD"), patterns)
    except RuntimeError as exc:
        print(f"leak guard: {exc}", file=sys.stderr)
        return 2
    if hits:
        for where, i in hits[:50]:
            print(f"leak guard: private term #{i + 1} at {where}")
        print(f"leak guard: FAILED, {len(hits)} hit(s) over {len(terms)} private terms")
        return 1
    print(f"leak guard: clean ({len(terms)} private terms checked against tracked files, the diff and the commits)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
