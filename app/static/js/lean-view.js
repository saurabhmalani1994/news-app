// L1: opens the lean sheet (S24's bottom sheet) from any control that names a source
// with data-lean-source: a story row's .lean-hit button over its dots, and the reader's
// byline marker. What the page already embeds (#rank-input: names, leans, ownership)
// fills the sheet at once; the cited basis comes from source-catalog.json (U2's catalog,
// precached by the service worker, app/source_catalog.py lean_basis), fetched on the
// first open and kept, so the page itself carries no copy of it. Every string is set as
// text (R26, js/lean.js).
import { openSheet } from "./sheet.js";
import { leanSheetContent, setBasis } from "./lean.js";

let input = null;
let bases = null;

function pageInput() {
  if (!input) {
    try {
      input = JSON.parse(document.getElementById("rank-input").content.textContent);
    } catch {
      input = {};
    }
  }
  return input;
}

/** The catalog's {source_id: lean_basis}, fetched once (same origin, the fetch
 * default); {} when it cannot be read, tried again on the next open. */
function leanBases() {
  if (!bases) {
    bases = fetch("source-catalog.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => (data && typeof data.lean_basis === "object" && data.lean_basis) || {})
      .catch(() => {
        bases = null;
        return {};
      });
  }
  return bases;
}

document.addEventListener("click", (event) => {
  const control = event.target.closest?.("[data-lean-source]");
  if (!control) return;
  event.preventDefault();
  const id = control.getAttribute("data-lean-source");
  const data = pageInput();
  const content = leanSheetContent({ lean: data.leans?.[id], ownership: data.ownership?.[id] });
  if (!content) return;
  openSheet({ title: data.names?.[id] || id, content, opener: control });
  leanBases().then((map) => setBasis(content, Object.hasOwn(map, id) ? map[id] : ""));
});
