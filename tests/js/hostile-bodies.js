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
  // H5: each rule again in mixed case and entity-encoded spellings.
  { name: "handler attribute mixed case", html: `<P OnClIcK="${P("p-case")}">x</P><IMG SRC="https://img.example/a.jpg" ONERROR="${P("img-case")}"><A HREF="https://ok.example/" oNmOuSeOvEr="${P("a-case")}">a</A>`,
    out: '<p>x</p><img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" src="https://img.example/a.jpg"><a href="https://ok.example/" target="_blank" rel="noopener noreferrer">a</a>' },
  { name: "handler value entity-encoded", html: `<img src="https://img.example/a.jpg" onerror="&#119;&#x69;ndow.__pwned.push('ent')"><p onclick="&quot;${P("ent-q")}">x</p>`,
    out: '<img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" src="https://img.example/a.jpg"><p>x</p>' },
  { name: "style mixed case", html: `<P STYLE="background:url(https://evil.example/b)">x</P><B sTyLe="color:red">y</B>`, out: "<p>x</p><b>y</b>" },
  { name: "srcset and picture", html: `<img SRCSET="https://evil.example/x.jpg 2x" src="https://img.example/a.jpg"><picture><source srcset="javascript:x 1x"><img srcset="data:image/png;base64,AA== 1x" src="https://img.example/b.jpg"></picture>`,
    out: '<img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" src="https://img.example/a.jpg"><img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" src="https://img.example/b.jpg">' },
  { name: "formaction on kept and dropped elements", html: `<p formaction="javascript:${P("fa-p")}">x</p><a href="https://ok.example/" FORMACTION="javascript:${P("fa-a")}">a</a><BUTTON FORMACTION="javascript:${P("fa-b")}">go</BUTTON><input type="image" formaction="javascript:${P("fa-i")}">`,
    out: '<p>x</p><a href="https://ok.example/" target="_blank" rel="noopener noreferrer">a</a>' },
  { name: "vbscript mixed case and entities", html: `<a href="VbScRiPt:msgbox(1)">a</a><a href="&#118;bscript:msgbox(1)">b</a><a href="vb&#x09;script:msgbox(1)">c</a>`, out: "abc" },
  { name: "data link entity-encoded", html: `<a href="&#100;&#x61;ta:text/html,x">a</a><a href="D&#65;TA:text/html,x">b</a><a href=" data:text/html,x">c</a>`, out: "abc" },
  { name: "javascript image src in every spelling", html: `<img src="javascript:${P("img-js")}"><img src="JaVaScRiPt:${P("img-js-case")}"><img src="&#106;avascript:${P("img-js-ent")}"><img src="java&#x09;script:x"><p>ok</p>`, out: "<p>ok</p>" },
  { name: "data and vbscript image src", html: `<img src="DaTa:image/png;base64,AA=="><img src="&#100;ata:image/svg+xml,x"><img src="vbscript:x"><IMG SRC="VBSCRIPT:x"><p>ok</p>`, out: "<p>ok</p>" },
  { name: "svg mixed case", html: `<SVG ONLOAD="${P("svg-case")}"><CIRCLE r="1"/></SVG><SvG><ScRiPt>${P("svg-script-case")}</ScRiPt></SvG><p>ok</p>`, out: "<p>ok</p>" },
  { name: "svg links and images", html: `<svg><a xlink:href="javascript:${P("svg-xlink")}"><text>x</text></a><image href="javascript:${P("svg-image")}"/><use href="data:image/svg+xml,x#a"/></svg><p>ok</p>`, out: "<p>ok</p>" },
  { name: "svg breakout", html: `<p>a<svg><p>b</p><img src="https://img.example/a.jpg" onerror="${P("svg-breakout")}"></svg></p>`, out: undefined },
  { name: "mathml mixed case and href", html: `<MATH><MI xlink:href="javascript:${P("mi")}">x</MI></MATH><math href="javascript:${P("math-href")}"><mtext>y</mtext></math><p>ok</p>`, out: "<p>ok</p>" },
  { name: "template mixed case", html: `<TEMPLATE><img src="https://img.example/a.jpg" onerror="${P("tpl-case")}"><p>t</p></TEMPLATE><p>ok</p>`, out: "<p>ok</p>" },
  { name: "noscript with kept markup", html: `<NOSCRIPT><p>hidden</p><img src="https://img.example/a.jpg"></NOSCRIPT><p>ok</p>`, out: "<p>ok</p>" },
  { name: "iframe mixed case", html: `<IFRAME SRC="https://evil.example/"><p>x</p></IFRAME><IfRaMe SrCdOc="<script>parent.${P("iframe-case")}</script>"></IfRaMe><p>ok</p>`, out: "<p>ok</p>" },
  { name: "object and embed mixed case", html: `<OBJECT DATA="https://evil.example/x.swf"><p>fallback</p><EMBED SRC="https://evil.example/x.swf"></OBJECT><EmBeD src="data:text/html,x"><p>ok</p>`, out: "<p>ok</p>" },
  { name: "form mixed case keeps nothing inside", html: `<FORM ACTION="https://evil.example/"><p>inside</p><a href="https://ok.example/">a</a></FORM><p>ok</p>`, out: "<p>ok</p>" },
  { name: "meta mixed case", html: `<META HTTP-EQUIV="refresh" CONTENT="0;url=javascript:${P("meta-case")}"><MeTa charset="utf-7"><p>ok</p>`, out: "<p>ok</p>" },
  { name: "entity-encoded markup stays text", html: `<p>&lt;script&gt;x&lt;/script&gt; &lt;b&gt;y&lt;/b&gt;</p>`, out: "<p>&lt;script&gt;x&lt;/script&gt; &lt;b&gt;y&lt;/b&gt;</p>" },
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
