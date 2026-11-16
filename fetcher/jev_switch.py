"""J40: whether Jev is paused. The switch lives in one place,
app/static/js/jev/switch.js (`export const JEV_PAUSED = true;`), read here so the
hourly run, the build and the site always agree. JEV_PAUSED in the environment ("1" or
"0") overrides it, for local runs and tests. An unreadable switch reads as paused: the
safe side is to ask Jev nothing. Standard library only."""
import os
import re
from pathlib import Path

SWITCH = Path(__file__).resolve().parent.parent / "app" / "static" / "js" / "jev" / "switch.js"
_LINE = re.compile(r"^export const JEV_PAUSED = (true|false);$", re.M)


def jev_paused(env=None, path=SWITCH):
    env = os.environ if env is None else env
    override = str(env.get("JEV_PAUSED", "")).strip()
    if override in ("0", "1"):
        return override == "1"
    try:
        match = _LINE.search(Path(path).read_text(encoding="utf-8"))
    except OSError:
        return True
    return True if match is None else match.group(1) == "true"
