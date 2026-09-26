// T2: the page's #rank-input is written in a compact form (app/page_input.py
// encode_input: a string table, cut deks as references to the full one, objects as
// columns). decodeInput gives back exactly the object the build made, by the same rules
// as app/page_input.py decode_input; every module reads the input through pageInput(),
// so none of them sees the compact form. offline.js, a classic script that cannot
// import, carries a byte-for-byte copy of decodeInput (ES5, for that reason), which
// tests/js/page-input.test.js diffs against this one.

/** The object encode_input was given; input without a table is returned as is. */
export function decodeInput(raw) {
  if (!raw || !Array.isArray(raw["~s"])) return raw;
  var table = raw["~s"];
  function string(text) {
    if (text.charCodeAt(0) !== 126) return text;
    if (text.charCodeAt(1) === 126) return text.slice(1);
    var caret = text.indexOf("^");
    if (caret < 0) return table[parseInt(text.slice(1), 36)];
    return table[parseInt(text.slice(1, caret), 36)].slice(0, parseInt(text.slice(caret + 1), 36)) + "\u2026";
  }
  function rows(keys, body) {
    var names = keys.map(string);
    return body.map(function (row) {
      var obj = {};
      for (var i = 0; i < names.length; i++) if (row[i] !== "~-") obj[names[i]] = value(row[i]);
      return obj;
    });
  }
  function value(v) {
    if (typeof v === "string") return string(v);
    if (Array.isArray(v)) return v.map(value);
    if (!v || typeof v !== "object") return v;
    var obj = {};
    if (v["~o"]) {
      var values = v["~k"] ? rows(v["~k"], v["~r"]) : v["~v"].map(value);
      v["~o"].forEach(function (k, i) { obj[string(k)] = values[i]; });
      return obj;
    }
    if (v["~k"]) return rows(v["~k"], v["~r"]);
    Object.keys(v).forEach(function (k) { obj[k] = value(v[k]); });
    return obj;
  }
  return value(raw.v);
}

/** The page's own #rank-input, decoded: a fresh object on every call, as each reader's
 * own JSON.parse gave it before T2. null when the page has none. */
export function pageInput(doc = document) {
  const template = doc.getElementById("rank-input");
  if (!template) return null;
  return decodeInput(JSON.parse(template.content.textContent));
}
