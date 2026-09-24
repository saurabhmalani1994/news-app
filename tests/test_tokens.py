"""S03 proof: hero and list headlines resolve to two distinct type tokens, not one
scaled clamp, and every text color pair on the background and on the nav surface
passes WCAG AA in both dark and light, computed from the token values. Plus the design
quality bar items that can be checked without a browser: self-hosted OFL fonts, a lean
preloaded payload, metric-matched fallbacks, one divider weight, the 20dp gutter.
"""
import re
from pathlib import Path

from app.build import PRELOAD_FONTS, render
from app.design.generate_tokens import render as generate_tokens_render

ROOT = Path(__file__).resolve().parents[1]
TOKENS_CSS = (ROOT / "app/static/tokens.css").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "app/static/style.css").read_text(encoding="utf-8")
FONT_DIR = ROOT / "app/static/fonts"

AA_NORMAL = 4.5


def _block_after(css, start_marker):
    """Return the declaration body of the first `<start_marker> { ... }` block."""
    start = css.index(start_marker) + len(start_marker)
    depth = 0
    for i in range(start, len(css)):
        if css[i] == "{":
            depth += 1
        elif css[i] == "}":
            if depth == 0:
                return css[start:i]
            depth -= 1
    raise AssertionError(f"unterminated block for {start_marker!r}")


def _custom_properties(block):
    return dict(re.findall(r"--([a-zA-Z0-9-]+):\s*([^;]+);", block))


def _declarations(block):
    return dict(re.findall(r"^\s*([a-z-]+):\s*([^;]+);", block, re.M))


# The first `:root { ... }` holds the dark (default) tokens. The light override lives
# inside `@media (prefers-color-scheme: light) { :root { ... } }`.
DARK_TOKENS = _custom_properties(_block_after(TOKENS_CSS, ":root {"))
_light_media = TOKENS_CSS[TOKENS_CSS.index("@media (prefers-color-scheme: light)"):]
LIGHT_TOKENS = {**DARK_TOKENS, **_custom_properties(_block_after(_light_media, ":root {"))}


def _resolve(tokens, value):
    """Follow var(--x) references to a literal value."""
    for _ in range(10):
        m = re.fullmatch(r"var\(--([a-zA-Z0-9-]+)\)", value.strip())
        if not m:
            return value.strip()
        value = tokens[m.group(1)]
    raise AssertionError(f"unresolvable {value}")


def _linearize(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def _luminance(hex_color):
    hex_color = hex_color.strip().lstrip("#")
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _linearize(r) + 0.7152 * _linearize(g) + 0.0722 * _linearize(b)


def contrast_ratio(hex_a, hex_b):
    la, lb = _luminance(hex_a), _luminance(hex_b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# Every color token that text is drawn in, and every surface text sits on.
TEXT_ROLES = [
    "color-headline", "color-dek", "color-meta", "color-meta-tertiary",
    "color-tab-active", "color-tab-inactive", "color-nav-inactive",
]
SURFACE_ROLES = ["color-bg", "color-nav-surface", "color-pressed"]


def contrast_table(tokens):
    return {
        (t, s): contrast_ratio(tokens[t], tokens[s]) for t in TEXT_ROLES for s in SURFACE_ROLES
    }


# The proof, part 1: two distinct type tokens.

def _headline_rule(selector):
    return _declarations(_block_after(STYLE_CSS, selector + " {"))


def test_list_and_hero_headlines_resolve_to_two_distinct_tokens():
    list_rule, hero_rule = _headline_rule(".headline"), _headline_rule(".headline--hero")
    assert list_rule["font-size"] == "var(--type-text-only-headline-size)"
    assert hero_rule["font-size"] == "var(--type-hero-headline-size)"
    for prop in ("font-size", "line-height"):
        list_px = _resolve(DARK_TOKENS, list_rule[prop])
        hero_px = _resolve(DARK_TOKENS, hero_rule[prop])
        assert re.fullmatch(r"[\d.]+px", list_px) and re.fullmatch(r"[\d.]+px", hero_px)
        assert float(hero_px[:-2]) > float(list_px[:-2]), (prop, hero_px, list_px)


def test_type_scale_is_not_a_single_scaled_clamp():
    for css in (TOKENS_CSS, STYLE_CSS):
        assert "clamp(" not in css
        assert "calc(var(--type" not in css
    for tier in ("hero-headline", "river-headline", "text-only-headline"):
        assert re.fullmatch(r"[\d.]+px", DARK_TOKENS[f"type-{tier}-size"])


def test_headlines_are_serif_and_meta_is_sans():
    for tier in ("hero-headline", "river-headline", "text-only-headline", "dek"):
        assert DARK_TOKENS[f"type-{tier}-family"] == "var(--font-serif)"
    for role in ("meta", "tab-label", "bottom-nav-label"):
        assert DARK_TOKENS[f"type-{role}-family"] == "var(--font-sans)"
    assert DARK_TOKENS["font-serif"].startswith("'Newsreader'")
    assert DARK_TOKENS["font-sans"].startswith("'Libre Franklin'")


def test_text_only_headline_is_bold_at_dek_size():
    assert DARK_TOKENS["type-text-only-headline-size"] == DARK_TOKENS["type-dek-size"]
    assert DARK_TOKENS["type-text-only-headline-weight"] == "700"
    assert DARK_TOKENS["type-dek-weight"] == "400"


def test_applied_page_has_exactly_one_hero():
    # S03 asserted a single text-only tier with no hero applied, because the hero was
    # S04's decision. S04 made it: one hero, and every other headline a lower token.
    from tests.test_render import GOLDEN

    page = render(GOLDEN)
    assert page.count('<span class="headline headline--hero">') == 1
    assert page.count('<span class="headline') == len(GOLDEN["articles"])


# The proof, part 2: AA contrast in both themes.

def test_dark_tokens_are_the_measured_values():
    expected = {
        "color-bg": "#121212", "color-nav-surface": "#2A2A2A", "color-headline": "#F8F8F8",
        "color-dek": "#BBBBBB", "color-meta": "#BBBBBB", "color-divider": "#3C3C3C",
    }
    for key, value in expected.items():
        assert DARK_TOKENS[key] == value, key


def test_every_text_pair_passes_aa_dark_theme():
    failures = {k: v for k, v in contrast_table(DARK_TOKENS).items() if v < AA_NORMAL}
    assert not failures, f"dark AA failures: {failures}"


def test_every_text_pair_passes_aa_light_theme():
    failures = {k: v for k, v in contrast_table(LIGHT_TOKENS).items() if v < AA_NORMAL}
    assert not failures, f"light AA failures: {failures}"


def test_dark_is_default_and_light_is_the_media_alternate():
    assert _luminance(DARK_TOKENS["color-bg"]) < 0.02
    assert _luminance(LIGHT_TOKENS["color-bg"]) > 0.9
    assert "prefers-color-scheme: dark" not in TOKENS_CSS


# Rules, spacing, fonts.

def test_single_divider_weight_everywhere():
    assert DARK_TOKENS["divider-weight"] == "1px"
    borders = re.findall(r"border(?:-top|-bottom)?:\s*([^;]+);", STYLE_CSS)
    assert borders and all(b == "var(--divider-weight) solid var(--color-divider)" for b in borders)
    assert "box-shadow" not in STYLE_CSS
    # D3 (intended visual change): the one rounded shape is the system bottom sheet's own
    # top and its drag handle, as NYT's sheets have; never a card or a box in the page.
    radii = re.findall(r"([^{}]+)\{[^}]*border-radius:\s*([^;]+);", STYLE_CSS)
    assert sorted((sel.strip().splitlines()[-1].strip(), r) for sel, r in radii) == [
        (".lean > i", "50%"), (".lean-sheet-dots > i", "50%"),  # L1: the lean marker's dots, not boxes
        (".sheet", "16px 16px 0 0"), (".sheet-grabber", "2px")]


def test_gutter_is_20dp_and_viewport_is_360dp():
    assert DARK_TOKENS["space-gutter"] == "20px"
    assert DARK_TOKENS["divider-inset"] == "20px"
    assert DARK_TOKENS["viewport-primary"] == "360px"


def test_touch_target_and_motion_tokens():
    assert DARK_TOKENS["touch-min"] == "48px"
    ms = int(DARK_TOKENS["motion-duration"].rstrip("ms"))
    assert 150 <= ms <= 200
    assert "prefers-reduced-motion: reduce" in STYLE_CSS
    assert "-webkit-tap-highlight-color: transparent" in STYLE_CSS
    assert ":hover" not in STYLE_CSS


def _font_faces():
    return re.findall(r"@font-face\s*{([^}]+)}", TOKENS_CSS)


def test_web_fonts_are_self_hosted_woff2_with_swap():
    hosted = [b for b in _font_faces() if "url(" in b]
    assert len(hosted) == 3
    for block in hosted:
        src = re.search(r"url\(['\"]?([^'\")]+)['\"]?\)", block).group(1)
        assert not re.match(r"^[a-zA-Z]+://", src) and "//" not in src
        assert src.endswith(".woff2")
        assert (ROOT / "app/static" / src).is_file(), src
        assert "font-display: swap" in block


def test_every_web_family_has_metric_matched_local_fallbacks():
    fallbacks = [b for b in _font_faces() if "url(" not in b]
    for family in ("Newsreader Fallback", "Libre Franklin Fallback"):
        faces = [b for b in fallbacks if f"'{family}" in b]
        assert len(faces) >= 2, family  # desktop and Android local fonts
        for block in faces:
            assert "local(" in block
            for prop in ("size-adjust", "ascent-override", "descent-override"):
                assert re.search(prop + r":\s*[\d.]+%", block), (family, prop)
    assert "'Newsreader Fallback'" in DARK_TOKENS["font-serif"]
    assert "'Libre Franklin Fallback'" in DARK_TOKENS["font-sans"]


def test_font_payload_is_lean():
    preloaded = sum((FONT_DIR / f).stat().st_size for f in PRELOAD_FONTS)
    total = sum(p.stat().st_size for p in FONT_DIR.glob("*.woff2"))
    assert preloaded <= 40_000, preloaded
    assert total <= 60_000, total


def test_font_licences_are_committed_and_ofl():
    for name in ("LICENSE-Newsreader.txt", "LICENSE-LibreFranklin.txt"):
        text = (FONT_DIR / name).read_text(encoding="utf-8")
        assert "SIL Open Font License" in text
    assert not list(FONT_DIR.glob("Inter-*"))


def test_tokens_css_matches_generator_output():
    # Checked against, not hand edited: regenerating from nyt-design-values.json
    # must reproduce the committed file exactly.
    assert generate_tokens_render() == TOKENS_CSS


def test_masthead_is_almanacs_own_wordmark():
    from tests.test_render import GOLDEN

    page = render(GOLDEN)
    assert '<h1 class="wordmark">Almanac</h1>' in page
    for borrowed in ("New York Times", "NYTimes", "nytimes"):
        assert borrowed not in page
