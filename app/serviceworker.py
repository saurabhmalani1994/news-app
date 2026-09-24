"""S18: writes dist/sw.js from app/sw_template.js, with the precache list and a cache
name tied to the build (R... none yet, S18 row in QUEUE.md).

The version is a hash of every precached file's own bytes and path, so any change to
the app shell, including a change to sw_template.js or sw-routes.js themselves, gets a
new cache name; `activate` in the worker deletes every shell cache that is not this
one. Deterministic: the same dist tree always hashes to the same version, so a build
that changes nothing ships nothing new.

`bodies/` and `pool.json` are never in the precache list (bodies/ is the reader's
IndexedDB cache, S25; pool.json is served network-first with its own runtime cache).

H1: pages are precached under the URL Cloudflare Pages actually serves them at, never
their file name. Pages answers `/index.html` with a 308 to `/` and `/profile.html` with
a 308 to `/profile`, so precaching the file names stored redirected responses, which
Chrome refuses for a navigation: every launch after the first went blank.
"""
import hashlib
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent / "sw_template.js"

# Extensions that make up the app shell: HTML, CSS, JS (including the router module the
# worker imports), fonts and the manifest. Icons are added separately (a whole
# directory). pool.json, _headers and sw.js itself are never precached.
SHELL_EXTENSIONS = (".html", ".css", ".js", ".woff2", ".webmanifest")
# S24: profile.schema.json is the one data file that is app shell, not feed data: S10's
# ProfileStore needs it to validate a save, and offline is exactly when a mute or a
# boost (story-actions.js) or a profile edit (profile-screen.js) most needs to still
# work. Every other .json (pool.json, bodies/*) stays out, fetched at runtime instead.
SHELL_EXTRA_FILES = ("profile.schema.json",)


def precache_files(dist: Path):
    """Sorted paths (relative to dist, POSIX, leading slash) that make up the shell."""
    paths = []
    for path in dist.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(dist).as_posix()
        if rel in ("pool.json", "_headers", "sw.js"):
            continue
        if path.suffix in SHELL_EXTENSIONS or rel.startswith("icons/") or rel in SHELL_EXTRA_FILES:
            paths.append(rel)
    return sorted(paths)


def page_url(rel: str) -> str:
    """The canonical URL Cloudflare Pages serves a built file at: `index.html` is `/`,
    `x/index.html` is `/x/`, any other `x.html` is `/x`, and everything else is itself."""
    if rel == "index.html":
        return "/"
    if rel.endswith("/index.html"):
        return "/" + rel[: -len("index.html")]
    if rel.endswith(".html"):
        return "/" + rel[: -len(".html")]
    return "/" + rel


def cache_version(dist: Path, rel_paths):
    digest = hashlib.sha256()
    for rel in rel_paths:
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update((dist / rel).read_bytes())
    return digest.hexdigest()[:16]


def build_service_worker(dist: Path) -> str:
    rel_paths = precache_files(dist)
    version = cache_version(dist, rel_paths)
    urls = "[\n" + "".join(f'  "{page_url(p)}",\n' for p in rel_paths) + "]"
    text = TEMPLATE.read_text(encoding="utf-8")
    # count=1: the template's own header comment must never mention these sentinels
    # (it would then get rewritten too, the bug that shipped once already), but count=1
    # is the belt to that comment's suspenders.
    text = text.replace("@@CACHE_VERSION@@", version, 1)
    text = text.replace("@@PRECACHE_URLS@@", urls, 1)
    assert "@@" not in text, "a template sentinel was left unfilled"
    return text


def write_service_worker(dist: Path) -> Path:
    out = dist / "sw.js"
    out.write_text(build_service_worker(dist), encoding="utf-8")
    return out
