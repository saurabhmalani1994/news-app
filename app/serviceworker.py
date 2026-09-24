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

H2: every script, stylesheet and shell data file is addressed as `<path>?v=<version>`,
in the pages, in every module import and in the few runtime fetches, and precached
under exactly that key. Pages are network-first and the rest cache-first, so before H2 a
page from a new deploy ran the previous deploy's cached scripts under the old worker:
U2's profile.html with S10's profile-screen.js, which looked up buttons U2 removed. A
new page now names URLs no older cache holds, so it can only ever run its own build.
Each page also carries `<meta name="almanac-build" content="<version>">`, which the
worker checks before it stores a page. Stamping is idempotent: the version hashes the
files with any earlier stamp removed.
"""
import hashlib
import re
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
# U2: source-catalog.json likewise: the You page's source picker must work offline.
SHELL_EXTRA_FILES = ("profile.schema.json", "source-catalog.json")


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


# H2: the build stamp. BUILD_META sits right after <meta charset>; a stamped URL carries
# ?v=<version>. Both are removed again before hashing, so a re-stamp changes nothing.
BUILD_META = '<meta name="almanac-build" content="{version}">'
BUILD_META_RE = re.compile(r'\n?<meta name="almanac-build" content="[0-9a-f]{16}">')
STAMP = r"(?:\?v=[0-9a-f]{16})?"
STAMP_RE = re.compile(r"\?v=[0-9a-f]{16}")
TEXT_SUFFIXES = (".html", ".css", ".js", ".json", ".webmanifest")
# A page's own scripts and stylesheets (relative or root-relative, never another origin).
PAGE_ASSET_RE = re.compile(r'(<(?:script|link)\b[^>]*?\s(?:src|href)=")((?!https?:|//)[^"?#]+\.(?:js|css))' + STAMP + '(")')
# Module specifiers: `from "./x.js"`, `import "./x.js"`, `import("./x.js")`.
IMPORT_RE = re.compile(r"((?:\bfrom|\bimport)\s*\(?\s*)([\"'])(\.{1,2}/[^\"'?#]+\.js)" + STAMP + r"\2")
# The runtime fetches of shell files: the schema, the source catalog, rank-gate's rerank.js.
RUNTIME_RE = re.compile(r"([\"'])(profile\.schema\.json|source-catalog\.json|js/rerank\.js)" + STAMP + r"\1")


def is_versioned(rel: str) -> bool:
    """Scripts, stylesheets and shell data files are addressed with ?v=<version>; pages,
    fonts, icons and the manifest keep their plain URL."""
    return rel.endswith((".js", ".css")) or rel in SHELL_EXTRA_FILES


def _unstamped(dist: Path, rel: str) -> bytes:
    data = (dist / rel).read_bytes()
    if not rel.endswith(TEXT_SUFFIXES):
        return data
    text = data.decode("utf-8")
    return STAMP_RE.sub("", BUILD_META_RE.sub("", text)).encode("utf-8")


def cache_version(dist: Path, rel_paths):
    digest = hashlib.sha256()
    for rel in rel_paths:
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(_unstamped(dist, rel))
    return digest.hexdigest()[:16]


def stamp_assets(dist: Path, version: str):
    """Rewrites the built pages and scripts in place so every script, stylesheet, module
    import and shell data fetch names `?v=<version>`, and every page carries its build."""
    stamp = f"?v={version}"
    for page in sorted(dist.glob("*.html")):
        text = BUILD_META_RE.sub("", page.read_bytes().decode("utf-8"))  # bytes: keep line endings
        text = PAGE_ASSET_RE.sub(lambda m: m.group(1) + m.group(2) + stamp + m.group(3), text)
        text = text.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + BUILD_META.format(version=version), 1)
        page.write_bytes(text.encode("utf-8"))
    for script in sorted((dist / "js").rglob("*.js")):
        text = script.read_bytes().decode("utf-8")
        text = IMPORT_RE.sub(lambda m: m.group(1) + m.group(2) + m.group(3) + stamp + m.group(2), text)
        text = RUNTIME_RE.sub(lambda m: m.group(1) + m.group(2) + stamp + m.group(1), text)
        script.write_bytes(text.encode("utf-8"))


def precache_url(rel: str, version: str) -> str:
    """The key a shell file is precached under: exactly the URL the stamped build names."""
    return page_url(rel) + (f"?v={version}" if is_versioned(rel) else "")


def build_service_worker(dist: Path) -> str:
    rel_paths = precache_files(dist)
    version = cache_version(dist, rel_paths)
    stamp_assets(dist, version)
    urls = "[\n" + "".join(f'  "{precache_url(p, version)}",\n' for p in rel_paths) + "]"
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
