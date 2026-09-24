// S37: hostile body fixtures for the sanitizer, shared by tests/js/sanitize.test.js (the
// real parser, in headless Chrome) and tests/browser/csp_check.mjs (under the CSP).
// Every payload that could run tries to push its name onto window.__pwned, so "executes
// nothing" is a check on that array. `out` is the exact serialized result for base
// BASE; a fixture without `out` is checked by the allowlist invariants only.
// Every on* handler the browser knows is added at run time (see handlerFixtures).

export const BASE = "https://news.example/story/1";
const P = (name) => `window.__pwned.push('${name}')`;

export const HOSTILE = [
  // script in every spelling
  { name: "script tag", html: `<p>a</p><script>${P("script")}</script><p>b</p>`, out: "<p>a</p><p>b</p>" },
  { name: "script mixed case", html: `<p>a</p><ScRiPt>${P("script-case")}</sCrIpT>`, out: "<p>a</p>" },
  { name: "script with src", html: `<script src="https://evil.example/x.js"></script><p>ok</p>`, out: "<p>ok</p>" },
  { name: "script split by angle brackets", html: `<<script>script>${P("split")}<</script>/script><p>ok</p>`, out: "&lt;/script&gt;<p>ok</p>" },
  { name: "script in template", html: `<template><script>${P("template")}</script></template><p>ok</p>`, out: "<p>ok</p>" },
  { name: "script in comment", html: `<!-- <script>${P("comment")}</script> --><p>ok</p>`, out: "<p>ok</p>" },
  { name: "noscript mXSS", html: `<noscript><p title="</noscript><img src=x onerror=${P("noscript")}>"></noscript>`, out: undefined },
  // handlers on kept and unwrapped elements
  { name: "img onerror", html: `<img src=x onerror="${P("img-onerror")}">`, out: '<img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" src="https://news.example/story/x">' },
  { name: "img onerror unquoted, unclosed", html: `<img src="nope:" onerror=${P("unclosed")}//`, out: "" },
  { name: "details ontoggle", html: `<details open ontoggle="${P("toggle")}"><summary>s</summary>t</details>`, out: "st" },
  { name: "body onload", html: `<body onload="${P("body")}"><p>ok</p></body>`, out: "<p>ok</p>" },
  { name: "video source onerror", html: `<video><source onerror="${P("source")}"></video><p>ok</p>`, out: "<p>ok</p>" },
  { name: "every global attribute", html: `<p id="x" class="y" data-x="z" title="t" dir="rtl" lang="en" tabindex="0" hidden contenteditable accesskey="k" autofocus onfocus="${P("autofocus")}">x</p>`, out: "<p>x</p>" },
  // links: schemes in every disguise
  { name: "javascript link", html: `<a href="javascript:${P("js")}">click</a>`, out: "click" },
  { name: "javascript mixed case", html: `<a href="JaVaScRiPt:${P("js-case")}">click</a>`, out: "click" },
  { name: "javascript hex entity", html: `<a href="jav&#x61;script:${P("js-hex")}">click</a>`, out: "click" },
  { name: "javascript decimal entities", html: `<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;${P("js-dec")}">click</a>`, out: "click" },
  { name: "javascript named colon", html: `<a href="javascript&colon;${P("js-colon")}">click</a>`, out: "click" },
  { name: "javascript tab inside", html: `<a href="java&#x09;script:${P("js-tab")}">click</a>`, out: "click" },
  { name: "javascript newline inside", html: `<a href="java&NewLine;script:${P("js-nl")}">click</a>`, out: "click" },
  { name: "javascript leading control", html: `<a href=" &#14; javascript:${P("js-ctl")}">click</a>`, out: "click" },
  { name: "data html link", html: `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>`, out: "click" },
  { name: "data upper case", html: `<a href="DATA:text/html,<script>${P("data")}</script>">click</a>`, out: "click" },
  { name: "vbscript link", html: `<a href="vbscript:msgbox(1)">click</a>`, out: "click" },
  { name: "file link", html: `<a href="file:///etc/passwd">click</a>`, out: "click" },
  { name: "blob link", html: `<a href="blob:https://news.example/0000">click</a>`, out: "click" },
  { name: "link target and rel forced", html: `<a href="https://ok.example/a" target="_self" rel="opener" onclick="${P("click")}">x</a>`, out: '<a href="https://ok.example/a" target="_blank" rel="noopener noreferrer">x</a>' },
  { name: "http link upgraded", html: `<a href="http://ok.example/a?b=1#c">x</a>`, out: '<a href="https://ok.example/a?b=1#c" target="_blank" rel="noopener noreferrer">x</a>' },
  { name: "credentials stripped", html: `<a href="https://user:pass@ok.example/">x</a>`, out: '<a href="https://ok.example/" target="_blank" rel="noopener noreferrer">x</a>' },
  { name: "relative link resolved to the source", html: `<a href="/other">x</a>`, out: '<a href="https://news.example/other" target="_blank" rel="noopener noreferrer">x</a>' },
  // frames, embeds, forms, document-level tags
  { name: "srcdoc iframe", html: `<iframe srcdoc="<script>parent.${P("srcdoc")}</script>"></iframe><p>ok</p>`, out: "<p>ok</p>" },
  { name: "javascript iframe", html: `<iframe src="javascript:parent.${P("iframe")}"></iframe>`, out: "" },
  { name: "object and embed", html: `<object data="javascript:${P("object")}"></object><embed src="javascript:${P("embed")}"><p>ok</p>`, out: "<p>ok</p>" },
  { name: "form", html: `<form action="https://evil.example/"><input name="q" autofocus onfocus="${P("input")}"><button formaction="javascript:${P("button")}">go</button></form><p>ok</p>`, out: "<p>ok</p>" },
  { name: "base, meta refresh, link", html: `<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=javascript:${P("meta")}"><link rel="stylesheet" href="https://evil.example/x.css"><p>ok</p>`, out: "<p>ok</p>" },
  // SVG and MathML
  { name: "svg script", html: `<svg><script>${P("svg-script")}</script></svg><p>ok</p>`, out: "<p>ok</p>" },
  { name: "svg onload", html: `<svg onload="${P("svg-onload")}"><circle r="1"/></svg>`, out: "" },
  { name: "svg animate href", html: `<svg><a><animate attributeName="href" values="javascript:${P("animate")}"/><text y="10">x</text></a></svg>`, out: "" },
  { name: "svg foreignObject", html: `<svg><foreignObject><img src=x onerror="${P("fo")}"></foreignObject></svg>`, out: "" },
  { name: "math xlink", html: `<math><maction actiontype="statusline" xlink:href="javascript:${P("math")}">x</maction></math>`, out: "" },
  { name: "math mtext img", html: `<math><mtext><table><mglyph><style><img src=x onerror="${P("mglyph")}">`, out: undefined },
  // styles
  { name: "style element", html: `<style>p{background:url(javascript:${P("style")})}</style><p>ok</p>`, out: "<p>ok</p>" },
  { name: "style javascript url", html: `<p style="background:url('javascript:${P("style-url")}')">x</p>`, out: "<p>x</p>" },
  { name: "style expression", html: `<p style="width: expression(${P("expression")})">x</p>`, out: "<p>x</p>" },
  { name: "style beacon", html: `<div style="background-image:url(https://evil.example/beacon)">x</div>`, out: "x" },
  // images
  { name: "data image", html: `<img src="data:image/svg+xml,<svg onload=${P("data-img")}>">`, out: "" },
  { name: "http image dropped", html: `<img src="http://img.example/a.jpg">`, out: "" },
  { name: "image keeps safe attributes only", html: `<figure><img src="https://img.example/a.jpg" srcset="javascript:x 1x" width="600" height="400" alt="A &quot;cat&quot;" style="x" usemap="#m"><figcaption>Cap <em>tion</em></figcaption></figure>`,
    out: '<figure><img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="A &quot;cat&quot;" width="600" height="400" src="https://img.example/a.jpg"><figcaption>Cap <em>tion</em></figcaption></figure>' },
  { name: "image bad dimensions", html: `<img src="https://img.example/a.jpg" width="100%" height="9e9">`, out: '<img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" src="https://img.example/a.jpg">' },
  // malformed and nested
  { name: "misnested formatting", html: `<p><a href="https://ok.example/"><b>bold <i>both</b> italic</i></a>`, out: undefined },
  { name: "unclosed everything", html: `<ul><li>one<li>two<blockquote>q`, out: "<ul><li>one</li><li>two<blockquote>q</blockquote></li></ul>" },
  { name: "h1 becomes h2", html: `<h1 onclick="${P("h1")}">Big</h1>`, out: "<h2>Big</h2>" },
  { name: "deep nesting", html: "<div>".repeat(2000) + "deep" + "</div>".repeat(2000), out: "deep" },
];

/** One fixture per on* handler name, on a kept, an unwrapped and a link element. */
export function handlerFixtures(names) {
  return names.map((h) => ({
    name: `handler ${h}`,
    html: `<p ${h}="${P(h)}">p</p><span ${h}="${P(h)}">s</span><a href="https://ok.example/" ${h}="${P(h)}">a</a><img src="https://img.example/a.jpg" ${h}="${P(h)}">`,
    out: '<p>p</p>s<a href="https://ok.example/" target="_blank" rel="noopener noreferrer">a</a><img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" src="https://img.example/a.jpg">',
  }));
}

/** Benign markup a real feed sends; every allowlisted element must survive intact. */
export const BENIGN = {
  name: "benign article",
  html: `<p>The <strong>council</strong> voted <em>7 to 2</em> on Tuesday.</p><h2>What changes</h2><ul><li>Fares <b>fall</b></li><li>Routes <i>grow</i></li></ul><ol><li>First</li></ol><blockquote><p>"We listened," she said.</p></blockquote><p>Read <a href="https://council.example/report">the report</a>.<br>More soon.</p><figure><img src="https://img.example/vote.jpg" alt="The vote" width="1200" height="800"><figcaption>The vote.</figcaption></figure><h3>Next</h3><h4>a</h4><h5>b</h5><h6>c</h6>`,
  out: `<p>The <strong>council</strong> voted <em>7 to 2</em> on Tuesday.</p><h2>What changes</h2><ul><li>Fares <b>fall</b></li><li>Routes <i>grow</i></li></ul><ol><li>First</li></ol><blockquote><p>"We listened," she said.</p></blockquote><p>Read <a href="https://council.example/report" target="_blank" rel="noopener noreferrer">the report</a>.<br>More soon.</p><figure><img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="The vote" width="1200" height="800" src="https://img.example/vote.jpg"><figcaption>The vote.</figcaption></figure><h3>Next</h3><h4>a</h4><h5>b</h5><h6>c</h6>`,
};
