// R2 tool, run by hand (needs Chrome): measures the dek face's advance widths and the
// dek box, and prints app/dek_widths.py, which app/dek.py's width-aware fit reads:
//   node tests/browser/dek_widths.mjs <built dist dir> > app/dek_widths.py
// Rerun it whenever the dek font, its size or the page's gutters change.
// Headless Chrome at 360x780 CSS px, DPR 3: the narrowest content width of any Today
// dek (a row without a photo keeps a 40px column for the overflow glyph, style.css;
// a row's tier and photo can change on the device re-rank, so every dek is fitted to
// the narrowest), then each character's width in em from a canvas set to the dek's own
// computed font, after document.fonts.ready. Single-glyph widths ignore kerning and
// ligatures, which only ever narrow a line, so the fit stays on the safe side.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launch, parseHeaders, serve, sleep } from "./cdp.mjs";

const dist = resolve(process.argv[2] || "dist");
const site = await serve(dist, parseHeaders(readFileSync(join(dist, "_headers"), "utf-8")));
const chrome = await launch("r2-dek-widths");
const { send, evaluate } = chrome;
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
await send("Page.navigate", { url: `${site.origin}/index.html` });
await sleep(2500);
const m = await evaluate(`document.fonts.ready.then(() => {
  const deks = [...document.querySelectorAll("#section-today li.story .dek")].filter((d) => d.getClientRects().length);
  const d = deks[0];
  const cs = getComputedStyle(d);
  const size = parseFloat(cs.fontSize);
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
  const chars = [];
  for (let c = 0x20; c <= 0x7e; c++) chars.push(c);
  for (let c = 0xa0; c <= 0x17f; c++) chars.push(c);
  for (const c of "\\u2018\\u2019\\u201c\\u201d\\u2013\\u2014\\u2026\\u2022\\u00b7\\u20ac\\u2032\\u2033") chars.push(c.codePointAt(0));
  const widths = {};
  for (const c of chars) widths[c] = Math.round(ctx.measureText(String.fromCodePoint(c)).width / size * 1000) / 1000;
  const content = (x) => { const c = getComputedStyle(x); return x.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight); };
  return { box: [...new Set(deks.map(content))].sort((a, b) => a - b), size, family: cs.fontFamily, lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing, loaded: document.fonts.check(cs.fontSize + " Newsreader"), widths };
})`);
chrome.close();
site.close();
if (!m.box.length || !m.loaded || m.letterSpacing !== "normal") {
  console.error(`deks disagree or the face is not loaded: ${JSON.stringify({ box: m.box, loaded: m.loaded, ls: m.letterSpacing })}`);
  process.exit(1);
}
const rows = Object.entries(m.widths).map(([c, w]) => `    0x${Number(c).toString(16).padStart(4, "0")}: ${w},`);
const lines = [];
for (let i = 0; i < rows.length; i += 4) lines.push(rows.slice(i, i + 4).map((r) => r.trim()).join(" "));
process.stdout.write(`"""R2: the dek face's advance widths, in em, and the dek box, measured in headless Chrome
at 360 CSS px by tests/browser/dek_widths.mjs (generated; rerun it when the dek font,
its size or the gutters change). ${m.family.split(",")[0]} at ${m.size}px, line height ${m.lineHeight}.
Dek content widths on the page: ${m.box.join(", ")} px; DEK_BOX_PX is the narrowest.
"""

DEK_BOX_PX = ${m.box[0]}
DEK_FONT_PX = ${m.size}
WIDTHS = {
${lines.map((l) => "    " + l).join("\n")}
}
`);
