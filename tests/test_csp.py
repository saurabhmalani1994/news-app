"""S37: the build writes dist/_headers with a strict CSP that fits the pages it built."""
import json
import re
from pathlib import Path

import pytest

from app import build
from app.csp import content_security_policy, headers_file, scan, style_hash

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "fixtures" / "golden_pool.json"


def _rules(text):
    lines = text.splitlines()
    assert lines[0] == "/*"
    return dict(line.strip().split(": ", 1) for line in lines[1:])


def _directives(csp):
    return {d.split(" ", 1)[0]: d.split(" ", 1)[1] if " " in d else "" for d in csp.split("; ")}


def test_build_writes_headers_for_its_own_pages(tmp_path):
    assert build.main(["--pool", str(GOLDEN), "--out", str(tmp_path)]) == 0
    rules = _rules((tmp_path / "_headers").read_text(encoding="utf-8"))
    csp = _directives(rules["Content-Security-Policy"])
    assert csp["default-src"] == "'self'"
    assert csp["script-src"] == "'self'"
    assert csp["style-src"] == "'self'"
    assert csp["img-src"] == "'self' https:"
    assert csp["connect-src"] == "'self'"
    assert csp["object-src"] == "'none'"
    assert csp["base-uri"] == "'none'"
    assert csp["form-action"] == "'self'"
    assert csp["frame-ancestors"] == "'none'"
    assert "unsafe-inline" not in rules["Content-Security-Policy"]
    assert "unsafe-eval" not in rules["Content-Security-Policy"]
    assert rules["Referrer-Policy"] == "no-referrer"
    assert rules["X-Content-Type-Options"] == "nosniff"
    assert "camera=()" in rules["Permissions-Policy"] and "geolocation=()" in rules["Permissions-Policy"]
    # Cloudflare Pages caps one header at 2,000 characters.
    assert all(len(v) < 2000 for v in rules.values())
    # Every built page fits the policy: no inline script or handler, every style
    # attribute value is hashed in style-src-attr.
    for page in tmp_path.glob("*.html"):
        styles, problems = scan(page.read_text(encoding="utf-8"))
        assert problems == []
        for value in styles:
            assert style_hash(value) in csp["style-src-attr"]


def test_hero_box_style_is_allowed_by_its_exact_hash_only():
    pool = json.loads(GOLDEN.read_text(encoding="utf-8"))
    lead = pool["articles"][0]
    lead["image"] = {"url": "https://img.example/a.jpg", "width": 1200, "height": 900}
    html = build.render(pool)
    styles, problems = scan(html)
    assert problems == []
    csp = _directives(_rules(headers_file({"index.html": html}))["Content-Security-Policy"])
    if styles:
        assert csp["style-src-attr"].startswith("'unsafe-hashes' 'sha256-")
        assert len(re.findall(r"'sha256-", csp["style-src-attr"])) == len(styles)
    else:
        assert csp["style-src-attr"] == "'none'"


def test_style_attr_is_none_when_no_page_has_one():
    assert "style-src-attr 'none'" in content_security_policy(())


def test_known_hash_value():
    # The CSP hash is base64(sha256(value)) of the attribute value exactly as parsed.
    assert style_hash("--box: 360 / 270") == "'sha256-wjoDZ7WUH8PxixAv15isf+SeVTrbz5tKXsD4RX00vkQ='"


@pytest.mark.parametrize("page", [
    "<script>alert(1)</script>",
    '<p onclick="x()">x</p>',
    "<style>p{}</style>",
    '<a href="javascript:x()">x</a>',
])
def test_a_page_the_policy_would_break_fails_the_build(page):
    with pytest.raises(ValueError, match="would break under the CSP"):
        headers_file({"index.html": page})


def test_external_scripts_are_fine():
    text = headers_file({"index.html": '<script src="js/a.js"></script><script type="module" src="js/b.js"></script>'})
    assert "script-src 'self'" in text
