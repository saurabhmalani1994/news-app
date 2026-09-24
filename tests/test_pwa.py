"""S18 proof: the manifest, icons and service worker are installable, Lighthouse-style,
checked without a browser. The headless-Chrome proof (tests/browser/pwa_cls.mjs) covers
what only a real browser can: SW install, an offline load, cache replacement on a new
build, and CSP violations.
"""
import json
import re
import struct
from pathlib import Path

import pytest

from app import build
from app.serviceworker import build_service_worker, cache_version, precache_files, write_service_worker

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "fixtures" / "golden_pool.json"
STATIC = ROOT / "app" / "static"


def _build(tmp_path):
    assert build.main(["--pool", str(GOLDEN), "--out", str(tmp_path)]) == 0
    return tmp_path


# ---- manifest.webmanifest -------------------------------------------------

def _manifest():
    return json.loads((STATIC / "manifest.webmanifest").read_text(encoding="utf-8"))


def test_manifest_has_the_required_installability_fields():
    m = _manifest()
    assert m["name"] == "Almanac"
    assert m["short_name"] == "Almanac"
    assert m["display"] == "standalone"
    assert re.fullmatch(r"#[0-9A-Fa-f]{6}", m["background_color"])
    assert re.fullmatch(r"#[0-9A-Fa-f]{6}", m["theme_color"])
    # Tokens (app/static/tokens.css): dark background, R3.
    assert m["background_color"] == "#121212"
    assert m["theme_color"] == "#121212"
    assert m["start_url"].startswith("/")
    assert m["scope"].startswith("/")


def test_manifest_icons_cover_192_512_and_a_maskable_512():
    icons = _manifest()["icons"]
    by_purpose_size = {(i["sizes"], i.get("purpose", "any")) for i in icons}
    assert ("192x192", "any") in by_purpose_size
    assert ("512x512", "any") in by_purpose_size
    assert ("512x512", "maskable") in by_purpose_size
    for icon in icons:
        assert icon["type"] == "image/png"
        assert (STATIC / icon["src"]).is_file()


def test_index_and_profile_pages_link_the_manifest_and_apple_touch_icon(tmp_path):
    out = _build(tmp_path)
    for name in ("index.html", "profile.html"):
        html = (out / name).read_text(encoding="utf-8")
        assert '<link rel="manifest" href="manifest.webmanifest">' in html
        assert '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">' in html
        assert '<script src="js/sw-register.js" defer></script>' in html


# ---- icons themselves: real PNGs, the sizes the manifest claims -----------

def _png_size(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    width, height = struct.unpack(">II", data[16:24])
    return width, height


@pytest.mark.parametrize("name, size", [
    ("icon-192.png", 192), ("icon-512.png", 512), ("icon-512-maskable.png", 512),
    ("apple-touch-icon.png", 180),
])
def test_icon_is_a_real_square_png_of_the_stated_size(name, size):
    path = STATIC / "icons" / name
    assert path.is_file()
    assert path.stat().st_size > 200  # not an empty or truncated file
    width, height = _png_size(path)
    assert (width, height) == (size, size)


def test_icons_are_committed_pngs_from_a_committed_generator_not_hand_made_binaries():
    # app/design/generate_icons.py is the one and only place pixels are set; the PNGs
    # under app/static/icons are its output, reproducible by anyone from the venv.
    from app.design.generate_icons import ICONS, generate
    assert {name for name, *_ in ICONS} == {p.name for p in (STATIC / "icons").glob("*.png")}


# ---- the service worker: precache list, versioning, a real fetch handler --

def test_precache_list_is_the_shell_only_never_pool_json_bodies_or_itself(tmp_path):
    out = _build(tmp_path)
    rel = precache_files(out)
    assert "pool.json" in {p.name for p in out.iterdir()}  # it exists, just not precached
    assert "pool.json" not in rel
    assert "_headers" not in rel
    assert "sw.js" not in rel
    assert not any("bodies/" in p for p in rel)  # S25 owns bodies/* in IndexedDB
    for must in ("index.html", "profile.html", "tokens.css", "style.css",
                 "manifest.webmanifest", "icons/icon-512.png", "js/sw-routes.js"):
        assert must in rel, must


def test_cache_version_changes_when_a_shell_file_changes(tmp_path):
    out = _build(tmp_path)
    rel = precache_files(out)
    v1 = cache_version(out, rel)
    (out / "style.css").write_text((out / "style.css").read_text(encoding="utf-8") + "\n/* x */\n", encoding="utf-8")
    v2 = cache_version(out, rel)
    assert v1 != v2


def test_build_writes_a_module_service_worker_with_fetch_install_activate_and_skip_waiting(tmp_path):
    out = _build(tmp_path)
    sw = (out / "sw.js").read_text(encoding="utf-8")
    assert 'import { STRATEGY, strategyFor } from "./js/sw-routes.js";' in sw
    for handler in ('addEventListener("install"', 'addEventListener("activate"', 'addEventListener("fetch"'):
        assert handler in sw
    # H1 reverses S18's no-skipWaiting rule: a phone stuck on a broken worker must be
    # taken over by the fixed one at once, not after every tab closes.
    assert "self.skipWaiting()" in sw
    assert "clients.claim()" in sw
    # The cache name is tied to the build: SHELL_CACHE is a template literal over VERSION,
    # itself a hash of the precached files' own bytes (app/serviceworker.py).
    assert re.search(r'const VERSION = "[0-9a-f]{16}";', sw)
    assert 'const SHELL_CACHE = `almanac-shell-${VERSION}`;' in sw


# ---- H1: precache and serve the URLs Cloudflare Pages serves, never a redirect --

@pytest.mark.parametrize("rel, url", [
    ("index.html", "/"), ("profile.html", "/profile"), ("health.html", "/health"),
    ("sub/index.html", "/sub/"), ("style.css", "/style.css"), ("icons/icon-192.png", "/icons/icon-192.png"),
])
def test_page_url_is_the_pretty_url_pages_serves(rel, url):
    from app.serviceworker import page_url
    assert page_url(rel) == url


def test_precache_list_names_pretty_page_urls_never_an_html_file(tmp_path):
    # Pages 308s "/index.html" to "/" and "/x.html" to "/x"; a precached redirect is a
    # response Chrome refuses for a navigation, the blank screen H1 fixed.
    out = _build(tmp_path)
    sw = (out / "sw.js").read_text(encoding="utf-8")
    listed = re.search(r"const PRECACHE_URLS = \[(.*?)\];", sw, re.S).group(1)
    urls = re.findall(r'"([^"]+)"', listed)
    for page in ("/", "/profile", "/health"):
        assert page in urls, page
    assert not [u for u in urls if u.endswith(".html")]


def test_worker_never_stores_or_serves_a_redirected_page_and_pages_are_network_first():
    text = (ROOT / "app" / "sw_template.js").read_text(encoding="utf-8")
    assert "cache.addAll(" not in text  # addAll stores redirected responses as they come
    assert "if (!response.redirected) return response;" in text
    assert "new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })" in text
    assert re.search(r"NAVIGATION_TIMEOUT_MS = 3000;", text)
    assert "STRATEGY.PAGE) { event.respondWith(pageNetworkFirst(event))" in text
    # activate deletes every other almanac-shell-* cache and claims open pages.
    assert 'key.startsWith("almanac-shell-") && key !== SHELL_CACHE' in text
    assert "self.clients.claim()" in text
    # Only the app's own pages are stored from a navigation, never a login page.
    assert "!PAGE_KEYS.has(key)" in text


def test_pool_json_treats_a_redirect_as_a_network_failure_and_never_caches_it():
    # A later slice may put Cloudflare Access in front: a redirect to its login page
    # must fall back to the cached pool, not replace it.
    text = (ROOT / "app" / "sw_template.js").read_text(encoding="utf-8")
    pool = text[text.index("async function poolNetworkFirst"):text.index("async function readImageIndex")]
    assert 'const failed = !response || response.redirected || response.type === "opaqueredirect";' in pool
    assert pool.index("if (!failed)") < pool.index("cache.put(")
    assert "(await cache.match(request)) || Response.error()" in pool


def test_sw_js_is_served_no_cache_so_an_update_check_always_reaches_the_origin(tmp_path):
    out = _build(tmp_path)
    text = (out / "_headers").read_text(encoding="utf-8")
    assert "/sw.js\n  Cache-Control: no-cache\n" in text


def test_pages_link_each_other_by_pretty_url_never_an_html_file(tmp_path):
    out = _build(tmp_path)
    for name in ("index.html", "profile.html", "health.html"):
        html = (out / name).read_text(encoding="utf-8")
        hrefs = re.findall(r'href="([^"]+)"', html)
        assert not [h for h in hrefs if ".html" in h and not h.startswith("http")], name
    js = (STATIC / "js" / "why-this.js").read_text(encoding="utf-8")
    assert "profile.html" not in js
    assert '"/sw.js"' in (STATIC / "js" / "sw-register.js").read_text(encoding="utf-8")


def test_service_worker_is_syntactically_valid_javascript(tmp_path):
    # Regression: app/serviceworker.py's template substitution once used a plain,
    # all-occurrences str.replace against sentinels the template's own header comment
    # also happened to mention, corrupting the comment into unterminated code.
    import subprocess
    out = _build(tmp_path)
    node = subprocess.run(["node", "--check", str(out / "sw.js")], capture_output=True, text=True)
    assert node.returncode == 0, node.stderr


def test_service_worker_never_caches_a_network_error_response():
    text = (ROOT / "app" / "sw_template.js").read_text(encoding="utf-8")
    assert 'response.type !== "error"' in text


def test_image_cache_has_a_size_cap_and_an_expiry():
    text = (ROOT / "app" / "sw_template.js").read_text(encoding="utf-8")
    assert re.search(r"IMAGE_MAX_ENTRIES = \d+", text)
    assert re.search(r"IMAGE_MAX_AGE_MS = ", text)


def test_write_service_worker_returns_the_path_it_wrote(tmp_path):
    out = _build(tmp_path)
    # write_service_worker already ran inside build.main(); calling it again is
    # idempotent (same shell bytes in, same version and content out).
    before = (out / "sw.js").read_text(encoding="utf-8")
    path = write_service_worker(out)
    assert path == out / "sw.js"
    assert path.read_text(encoding="utf-8") == before
