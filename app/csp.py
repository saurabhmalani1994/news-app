"""S37: the security headers Cloudflare Pages serves with every file, written by the
build as dist/_headers (R26).

The Content-Security-Policy allows script only from the app's own files: no inline
script, no eval, no inline event handler. Styles come only from the app's own
stylesheets. The one inline style the build emits is the hero photo frame's
`style="--box: W / H"` (S39/D2, the photo's stated shape, two integers the build
computed), so style attributes are allowed only by the exact hash of each value the
built pages carry ('unsafe-hashes' plus sha256), never 'unsafe-inline'. The device
re-rank sets the same property through CSSOM (tiers.js), which CSP does not govern.

Images may come from any https host: the pool's photos are feed-chosen, from 42 hosts
when S39 measured. Network reads stay on the app's own origin; S20 adds the OpenRouter
origin to connect-src when it lands.

`headers_file` refuses (ValueError) a page that this policy would break, an inline
script, an inline <style> or an on* handler attribute, so the build fails instead of
deploying a page the browser would block.
"""
import base64
import hashlib
from html.parser import HTMLParser

REFERRER_POLICY = "no-referrer"
# Every powerful feature the app does not use, denied to the page and to any frame.
PERMISSIONS_DENIED = (
    "accelerometer", "autoplay", "bluetooth", "camera", "display-capture", "encrypted-media",
    "fullscreen", "geolocation", "gyroscope", "hid", "idle-detection", "magnetometer",
    "microphone", "midi", "payment", "picture-in-picture", "publickey-credentials-get",
    "screen-wake-lock", "serial", "usb", "xr-spatial-tracking", "browsing-topics",
)


class _PageScan(HTMLParser):
    """Collects every style attribute value and every construct the CSP would block."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.styles = set()
        self.problems = []
        self._script_open = False
        self._script_body = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name.lower().startswith("on"):
                self.problems.append(f"inline event handler {name} on <{tag}>")
            if name.lower() == "style":
                self.styles.add(value or "")
            if name.lower() in ("href", "src", "action", "formaction") and (value or "").strip().lower().startswith("javascript:"):
                self.problems.append(f"javascript: url in {name} on <{tag}>")
        if tag == "script":
            if not dict(attrs).get("src"):
                self.problems.append("inline <script>")
        elif tag == "style":
            self.problems.append("inline <style>")

    handle_startendtag = handle_starttag


def scan(html):
    """(style attribute values, problems) for one built page."""
    parser = _PageScan()
    parser.feed(html)
    parser.close()
    return parser.styles, parser.problems


def style_hash(value):
    """The CSP source expression for one exact style attribute value."""
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"


def content_security_policy(style_values=()):
    hashes = sorted({style_hash(v) for v in style_values})
    style_attr = "'unsafe-hashes' " + " ".join(hashes) if hashes else "'none'"
    directives = (
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        f"style-src-attr {style_attr}",
        "img-src 'self' https:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    )
    return "; ".join(directives)


def permissions_policy():
    return ", ".join(f"{feature}=()" for feature in PERMISSIONS_DENIED)


def headers_file(pages):
    """The _headers text for these built pages ({name: html}), one rule for every path."""
    styles = set()
    problems = []
    for name, html in sorted(pages.items()):
        page_styles, page_problems = scan(html)
        styles |= page_styles
        problems += [f"{name}: {p}" for p in page_problems]
    if problems:
        raise ValueError("page would break under the CSP: " + "; ".join(problems))
    lines = [
        "/*",
        f"  Content-Security-Policy: {content_security_policy(styles)}",
        f"  Referrer-Policy: {REFERRER_POLICY}",
        "  X-Content-Type-Options: nosniff",
        f"  Permissions-Policy: {permissions_policy()}",
    ]
    return "\n".join(lines) + "\n"
