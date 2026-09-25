"""H3 proof, without a browser: the service worker is one classic script, so Chrome
fetches it with the Cloudflare Access cookie. A module worker's script is fetched with
credentials "omit"; behind Access every install and update of it met a login redirect,
and the owner's phone kept a pre-Access worker that had every article photo refused
(tests/browser/h3_photos_check.mjs shows it in Chrome).
"""
import re
import subprocess
from pathlib import Path

import pytest

from app import build
from app.serviceworker import inline_routes

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "fixtures" / "golden_pool.json"
JS = ROOT / "app" / "static" / "js"


@pytest.fixture(scope="module")
def dist(tmp_path_factory):
    out = tmp_path_factory.mktemp("h3")
    assert build.main(["--pool", str(GOLDEN), "--out", str(out)]) == 0
    return out


def test_sw_js_runs_as_a_classic_script_with_no_import_or_export(dist):
    sw = (dist / "sw.js").read_text(encoding="utf-8")
    assert not re.search(r"^\s*(?:import|export)\b", sw, re.M)
    assert "importScripts" not in sw  # one file: nothing else is fetched to start it
    # vm.Script parses exactly as a classic script does (a module keyword is a SyntaxError).
    check = "new (require('vm').Script)(require('fs').readFileSync(process.argv[1], 'utf8'))"
    node = subprocess.run(["node", "-e", check, str(dist / "sw.js")], capture_output=True, text=True)
    assert node.returncode == 0, node.stderr


def test_sw_js_carries_the_tested_routing_module_word_for_word_less_export(dist):
    sw = (dist / "sw.js").read_text(encoding="utf-8")
    module = (JS / "sw-routes.js").read_text(encoding="utf-8")
    assert "export function strategyFor" in module  # the Node test still imports it
    assert re.sub(r"^export ", "", module, flags=re.M).rstrip("\n") in sw
    assert sw.index("function strategyFor(") < sw.index('addEventListener("fetch"')


def test_inline_routes_refuses_a_routing_module_that_needs_an_import(tmp_path):
    (tmp_path / "js").mkdir()
    (tmp_path / "js" / "sw-routes.js").write_text('import { x } from "./x.js";\nexport const y = x;\n', encoding="utf-8")
    with pytest.raises(ValueError):
        inline_routes(tmp_path)


def test_the_page_registers_a_classic_worker_that_skips_the_http_cache():
    text = (JS / "sw-register.js").read_text(encoding="utf-8")
    calls = re.findall(r"\.register\(([^)]*)\)", text)
    assert calls == ['"/sw.js", { updateViaCache: "none" }']
    assert 'type: "module"' not in text


def test_photos_that_failed_under_the_old_worker_are_asked_for_again_on_takeover():
    text = (JS / "sw-register.js").read_text(encoding="utf-8")
    assert 'addEventListener("controllerchange"' in text
    assert "img.complete && img.naturalWidth === 0" in text
