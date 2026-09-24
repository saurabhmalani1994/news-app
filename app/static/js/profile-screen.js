// S10, redesigned in U2: the You page. One document, five views chosen by the URL hash,
// so every view is precached with the page and works offline, and the browser's own Back
// walks between them:
//
//   /profile                 You: interests, standing stories, sources, display, health,
//                            advanced, each a plain row
//   /profile#interest/<id>   one interest: its level in words, then its fine tuning
//   /profile#story/<id>      one standing story: keywords, floor, alarm hours
//   /profile#sources         every source by region, with search and on/off
//   /profile#advanced        the raw JSON editor, version history, diff and revert
//
// S12's why-this links still land: "#topic-<id>" becomes "#interest/<id>" and
// "#raw-json" becomes "#advanced" with the editor in view (replaceState, no extra Back
// step). Every change is one ProfileStore save (one version) with a quiet Undo that
// reverts to the version before it. Nothing here is sent anywhere; the only fetches are
// this app's own schema and source catalog, both precached.
//
// L1: Display carries the lean marker's two switches (on, colored), and the source
// picker shows each outlet's marker after its name, a tap on it opening the lean sheet
// (js/lean.js) with the catalog's cited basis. The sheet module loads on that first tap,
// so a page without its markup can never be taken down by it.
//
// H2: a profile saved by an older build is migrated forward on load (migrate.js, one
// new version, history kept). No lookup can take the page down: the page's own chrome
// is found or made (pageChrome), and every section is built on its own, so a missing
// field shows a calm line in that section only while the rest of the page works.
import { ProfileStore } from "./profile/store.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { migrateProfile } from "./profile/migrate.js";
import { formatDiff } from "./profile/diff.js";
import { showToast, hideToast } from "./toast.js";
import {
  LEVELS, levelOf, levelWord, withTopicLevel, withTopicField, withTopicMuted, boostsForTopic,
  withBoostAmount, withBoostRemoved, withStandingField, summariesMode, withSummaries,
  leanMarkersOn, leanColorOn, withLeanMarkers, withLeanColor, SOURCE_STATES, sourceState, withSourceState, withSourceStates, sourceCounts, groupByRegion,
  matchesQuery, sourceDetail, HEALTH_WORDS, commitEdit,
} from "./profile/you-edits.js";
import { leanHit, leanMarker, leanSheetContent, setBasis } from "./lean.js";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

function formatTimestamp(iso) {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : dateFormat.format(parsed);
}

// Text only (R26): every string goes in through textContent or an attribute, never HTML.
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function showErrors(container, errors) {
  container.textContent = "";
  if (!errors.length) return;
  const list = el("ul");
  for (const message of errors) list.appendChild(el("li", { text: message }));
  container.appendChild(el("p", { text: errors.length === 1 ? "Could not save:" : `Could not save (${errors.length} problems):` }));
  container.appendChild(list);
}

/** H2: the calm line a section shows instead of itself when it cannot be drawn. */
const sectionNotice = (label) => el("section", { class: "settings-section" }, [
  label ? el("h2", { class: "settings-label", text: label }) : null,
  el("p", { class: "settings-hint section-notice", role: "status", text: "This part could not be shown. The rest of the page works, and your profile is unchanged." }),
]);

/** A section; `children` may be a function, so an error while building it stays inside
 * this one section (H2). */
function section(label, children, extra = {}) {
  let nodes;
  try {
    nodes = typeof children === "function" ? children() : children;
  } catch (err) {
    console.warn(`You page: the ${label} section could not be drawn`, err);
    return sectionNotice(label);
  }
  return el("section", { class: "settings-section", ...extra }, [el("h2", { class: "settings-label", text: label }), ...nodes]);
}

/** H2: the page's own chrome, found by id, or made when an older or newer page lacks
 * it, so no lookup here is ever null. */
function pageChrome() {
  let root = document.getElementById("settings-root");
  if (!root) {
    root = el("main", { class: "settings", id: "settings-root" });
    document.body.insertBefore(root, document.querySelector(".bottom-nav"));
  }
  const title = document.getElementById("page-title") || el("h1");
  const back = document.getElementById("masthead-back") || el("a");
  return { root, title, back };
}

const rowText = (label, sub) => el("div", { class: "setting-row-text" }, [
  el("span", { class: "setting-label", text: label }),
  sub ? el("span", { class: "setting-sublabel", text: sub }) : null,
]);

const chevron = () => el("span", { class: "setting-chevron", "aria-hidden": "true", text: "›" });

/** A row that opens another view or page: the whole row is the target. */
function linkRow(href, label, sub, value, extra = {}) {
  return el("a", { class: "setting-row", href, ...extra }, [
    rowText(label, sub),
    el("span", { class: "setting-end" }, [value ? el("span", { class: "setting-value", text: value }) : null, chevron()]),
  ]);
}

/** A row with an on/off switch; the label is the switch's own label, so the row taps it. */
function switchRow(key, label, sub, checked, onToggle) {
  const input = el("input", {
    class: "switch", type: "checkbox", role: "switch", checked, "data-focus-key": key,
    onchange: (e) => onToggle(e.target.checked),
  });
  return el("label", { class: "setting-row setting-row--switch" }, [rowText(label, sub), input]);
}

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`could not load ${path}: ${response.status}`);
  return response.json();
}

function main(schema, catalog) {
  const store = new ProfileStore({ storage: window.localStorage, schema, seedDefault: buildDefaultProfile, migrate: migrateProfile });
  const sources = Array.isArray(catalog?.sources) ? catalog.sources : [];
  const bases = catalog && typeof catalog.lean_basis === "object" && catalog.lean_basis ? catalog.lean_basis : {};
  const { root, title, back } = pageChrome();

  // --- Scroll memory: per view, kept for the tab's session so Back from Health (a
  // separate page) and Back between views both land where the reader left off. ---
  const SCROLL_KEY = "almanac.you.scroll";
  let positions = {};
  try { positions = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || "{}") || {}; } catch { positions = {}; }
  const persist = () => { try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(positions)); } catch {} };
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  let current = { view: "you", key: "you" };
  let previousKey = null;
  let forward = false; // set by a tap on an in-page row: the new view opens at its top
  let sourceQuery = "";
  let focusRaw = false;
  let rendering = false;

  let ticking = false;
  addEventListener("scroll", () => {
    if (ticking || rendering) return;
    ticking = true;
    requestAnimationFrame(() => { if (!rendering) positions[current.key] = scrollY; ticking = false; });
  }, { passive: true });
  addEventListener("pagehide", () => { positions[current.key] = scrollY; persist(); });

  function parseHash() {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
    const old = hash.match(/^topic-(.+)$/);
    if (old) {
      history.replaceState(history.state, "", `#interest/${encodeURIComponent(old[1])}`);
      return { view: "interest", id: old[1], key: `interest/${old[1]}` };
    }
    if (hash === "raw-json") {
      history.replaceState(history.state, "", "#advanced");
      focusRaw = true;
      return { view: "advanced", key: "advanced" };
    }
    const [view, id] = hash.split("/");
    if (view === "interest" && id) return { view, id, key: hash };
    if (view === "story" && id) return { view, id, key: hash };
    if (view === "sources" || view === "advanced") return { view, key: view };
    return { view: "you", key: "you" };
  }

  // --- Committing one edit: one version, a quiet confirmation, Undo reverts. ---
  function commit(edit, message) {
    const result = commitEdit(store, edit);
    if (!result) return;
    if (!result.ok) {
      showToast(`Not saved: ${result.errors[0]}`);
      render({ keepScroll: true });
      return;
    }
    render({ keepScroll: true });
    showToast(message, {
      onAction: () => {
        store.revert(result.before);
        render({ keepScroll: true });
      },
    });
  }

  // --- You ---
  function viewYou(profile) {
    return [
      section("Your interests", () => [el("div", { id: "topics-list" }, Object.entries(profile.topics).map(([id, t]) => {
        const floor = t.enabled !== false && t.floor_slots > 0;
        const value = floor ? `Top ${t.floor_slots}` : levelWord(levelOf(t));
        return linkRow(`#interest/${encodeURIComponent(id)}`, t.label || id, null, value, { "data-topic": id });
      }))]),
      section("Standing stories", () => {
        const stories = (profile.standing_stories || []).map((s) => linkRow(`#story/${encodeURIComponent(s.id)}`, s.label || s.id, null,
          s.enabled ? "On" : "Off"));
        return stories.length ? stories : [el("p", { class: "settings-hint", text: "None followed. Add one in Advanced." })];
      }),
      section("News sources", () => {
        const counts = sourceCounts(profile, sources);
        const sourcesLabel = sources.length ? `${counts.on} of ${counts.total} sources on` : "Choose your sources";
        return [linkRow("#sources", sourcesLabel, "Pick the outlets your pages draw from", null, { id: "sources-row" })];
      }),
      section("Display", () => [switchRow("summaries", "Summaries on every story", "Off shows them on the lead stories only",
        summariesMode(profile) === "all",
        (on) => commit((p) => withSummaries(p, on ? "all" : "top"), on ? "Summaries on every story" : "Summaries on lead stories only")),
      switchRow("lean-markers", "Lean markers", "Five dots after a source name, left to right, for where the outlet leans",
        leanMarkersOn(profile),
        (on) => commit((p) => withLeanMarkers(p, on), on ? "Lean markers on" : "Lean markers off")),
      switchRow("lean-color", "Color the markers", "Blue for left, red for right, grey for center",
        leanColorOn(profile),
        (on) => commit((p) => withLeanColor(p, on), on ? "Markers in color" : "Markers in grey"))]),
      section("Health", [linkRow("/health", "Feed health", "Pool age, the last run, every source's status")]),
      section("Advanced", () => [linkRow("#advanced", "Profile data and versions", `Raw JSON, history and revert. Now v${store.history()[0].version}`)]),
      el("footer", { class: "colophon colophon--settings" }, [
        el("p", { class: "colophon-text", text: "Kept on this device only. Your profile is never sent anywhere." }),
      ]),
    ];
  }

  // --- One interest ---
  const LEVEL_HINTS = {
    more: "Stories in this interest rank above most others.",
    normal: "Stories in this interest get a modest lift.",
    less: "Stories in this interest get only a small lift.",
    off: "No lift at all. Its stories can still appear on their own merits.",
  };

  function numberField({ key, label, sub, value, min, max, step, unit, onCommit }) {
    return el("div", { class: "setting-row" }, [
      rowText(label, sub),
      el("span", { class: "setting-end" }, [
        el("input", {
          class: "setting-half-life", type: "number", inputmode: "numeric", min, max, step, value: String(value),
          "aria-label": label, "data-focus-key": key,
          onchange: (e) => onCommit(e.target.value),
        }),
        unit ? el("span", { class: "setting-unit", text: unit }) : null,
      ]),
    ]);
  }

  function sliderField({ key, label, sub, value, min, max, step, onCommit }) {
    const readout = el("span", { class: "setting-value setting-value--num", text: Number(value).toFixed(2) });
    return el("div", { class: "setting-row setting-row--slider" }, [
      rowText(label, sub),
      readout,
      el("input", {
        class: "setting-slider", type: "range", min, max, step, value: String(value), "aria-label": label,
        "data-focus-key": key,
        oninput: (e) => { readout.textContent = Number(e.target.value).toFixed(2); },
        onchange: (e) => onCommit(e.target.value),
      }),
    ]);
  }

  function viewInterest(profile, id) {
    const topic = profile.topics[id];
    const level = levelOf(topic);
    const levelButtons = el("div", { class: "level-control", role: "radiogroup", "aria-label": `${topic.label} level` },
      LEVELS.map((l) => el("button", {
        class: "level-option", type: "button", role: "radio", "aria-checked": String(l.id === level),
        "data-focus-key": `level-${l.id}`, text: l.word,
        onclick: () => commit((p) => withTopicLevel(p, id, l.id), `${topic.label}: ${l.word}`),
      })));

    const tuning = [
      sliderField({
        key: "affinity", label: "Affinity", value: topic.affinity, min: "0", max: "1", step: "0.05",
        sub: "How much this interest lifts a story's score, from 0 to 1. The level sets it for you.",
        onCommit: (v) => commit((p) => withTopicField(p, id, "affinity", v), `${topic.label} affinity ${Number(v).toFixed(2)}`),
      }),
      numberField({
        key: "half-life", label: "Half-life", value: topic.half_life_hours, min: "1", max: "168", step: "1", unit: "h",
        sub: "Hours for a story here to lose half its freshness. Short for fast news, long for slow reading.",
        onCommit: (v) => commit((p) => withTopicField(p, id, "half_life_hours", v), `${topic.label} half-life ${v}h`),
      }),
    ];
    if (topic.floor_slots !== undefined) {
      tuning.push(numberField({
        key: "floor", label: "Places kept on top", value: topic.floor_slots, min: "0", max: "10", step: "1",
        sub: "Stories from this interest always kept at the top of Today, whatever the level. 0 turns it off.",
        onCommit: (v) => commit((p) => withTopicField(p, id, "floor_slots", v), `${topic.label}: top ${v} kept`),
      }));
    }
    const muted = (profile.mutes?.topics || []).includes(id);
    tuning.push(switchRow("mute", "Hide its stories", "Removes every story tagged with this interest, whatever else it scores.",
      muted, (on) => commit((p) => withTopicMuted(p, id, on), on ? `${topic.label} stories hidden` : `${topic.label} stories shown`)));

    const boosts = boostsForTopic(profile, id);
    const boostRows = boosts.length ? boosts.map((b) => el("div", { class: "boost-block" }, [
      sliderField({
        key: `boost-${b.id}`, label: b.label, value: b.amount, min: "-1", max: "1", step: "0.05",
        sub: "A flat lift, or a drop below 0, for any story in this interest.",
        onCommit: (v) => commit((p) => withBoostAmount(p, b.id, v), `${b.label} ${Number(v).toFixed(2)}`),
      }),
      el("div", { class: "setting-row setting-row--tight" }, [
        el("button", { class: "btn-quiet", type: "button", text: "Remove this boost", "data-focus-key": `remove-${b.id}`,
          onclick: () => commit((p) => withBoostRemoved(p, b.id), `${b.label} removed`) }),
      ]),
    ])) : [el("p", { class: "settings-hint", text: "None. Boost a topic from any story's menu to add one here." })];

    return [
      el("section", { class: "settings-section" }, [
        el("h2", { class: "settings-label", text: "Level" }),
        levelButtons,
        el("p", { class: "settings-hint settings-hint--after", text: LEVEL_HINTS[level] }),
      ]),
      section("Fine tuning", tuning),
      section("Boosts", boostRows),
    ];
  }

  // --- One standing story ---
  function viewStory(profile, id) {
    const story = (profile.standing_stories || []).find((s) => s.id === id);
    const keywords = el("textarea", {
      class: "text-field text-field--area", rows: "3", "aria-label": "Keywords", "data-focus-key": "keywords",
      spellcheck: "false",
      onchange: (e) => commit((p) => withStandingField(p, id, "keywords", e.target.value), `${story.label} keywords saved`),
    });
    keywords.value = (story.keywords || []).join(", ");
    return [
      section("Following", [switchRow("enabled", "Follow this story", "Off stops the floor and the silence alarm for it.",
        story.enabled, (on) => commit((p) => withStandingField(p, id, "enabled", on), on ? `${story.label} on` : `${story.label} off`))]),
      section("Keywords", [
        el("p", { class: "settings-hint", text: "A headline with any of these words or phrases counts as this story. Separate them with commas." }),
        el("div", { class: "setting-row setting-row--stack" }, [keywords]),
      ]),
      section("Floor", [
        numberField({
          key: "floor-slots", label: "Stories kept", value: story.floor_slots, min: "0", max: "3", step: "1",
          sub: "How many of its stories Today always keeps near the top. 0 turns the floor off.",
          onCommit: (v) => commit((p) => withStandingField(p, id, "floor_slots", v), `${story.label}: ${v} kept`),
        }),
        numberField({
          key: "floor-within", label: "Within the top", value: story.floor_within, min: "1", max: "50", step: "1",
          sub: "How far down Today those stories may sit.",
          onCommit: (v) => commit((p) => withStandingField(p, id, "floor_within", v), `${story.label}: within top ${v}`),
        }),
      ]),
      section("Silence alarm", [
        numberField({
          key: "silence", label: "Alarm after", value: story.silence_hours, min: "0", max: "168", step: "1", unit: "h",
          sub: "A notice on Today when nothing new has arrived for this long. 0 turns it off.",
          onCommit: (v) => commit((p) => withStandingField(p, id, "silence_hours", v), `${story.label}: alarm after ${v}h`),
        }),
      ]),
    ];
  }

  // --- Sources ---
  function viewSources(profile) {
    if (!sources.length) {
      return [el("p", { class: "settings-hint settings-hint--top", text: "The source list is not available yet. Open this page once online." })];
    }
    const counts = sourceCounts(profile, sources);
    const search = el("input", {
      class: "text-field search-field", type: "search", placeholder: "Search sources", "aria-label": "Search sources",
      autocomplete: "off", spellcheck: "false", "data-focus-key": "search", enterkeyhint: "search",
    });
    search.value = sourceQuery;
    const empty = el("p", { class: "settings-hint settings-hint--top", text: "No source matches.", hidden: true });

    const groups = groupByRegion(sources).map((group) => {
      const ids = group.sources.map((s) => s.id);
      const allOn = ids.every((sid) => sourceState(profile, sid) === SOURCE_STATES.ON);
      const next = allOn ? SOURCE_STATES.OFF : SOURCE_STATES.ON;
      const head = el("div", { class: "group-head" }, [
        el("h2", { class: "settings-label", text: group.label }),
        el("button", {
          class: "btn-quiet group-action", type: "button", "data-focus-key": `group-${group.bucket}`,
          text: allOn ? "Turn all off" : "Turn all on", "aria-label": `${allOn ? "Turn all off" : "Turn all on"}: ${group.label}`,
          onclick: () => commit((p) => withSourceStates(p, ids, next), `${group.label}: all ${next}`),
        }),
      ]);
      const hits = [];
      const rows = group.sources.map((s) => {
        const detail = [sourceDetail(s), HEALTH_WORDS[s.health] || ""].filter(Boolean).join(" · ");
        const row = switchRow(`source-${s.id}`, s.name, detail, sourceState(profile, s.id) === SOURCE_STATES.ON,
          (on) => commit((p) => withSourceState(p, s.id, on ? SOURCE_STATES.ON : SOURCE_STATES.OFF), `${s.name} ${on ? "on" : "off"}`));
        row.dataset.source = s.id;
        row.dataset.name = s.name;
        if (s.health === "down" || s.health === "failing") row.classList.add("source-row--unwell");
        placeLean(row, s, hits);
        return row;
      });
      // The markers' tap targets sit after the rows (a button inside the switch's own
      // label would be invalid, and between rows it would break their hairlines), each
      // laid over its own row's dots by a per-source anchor name.
      return el("section", { class: "settings-section source-group", "data-bucket": group.bucket }, [head, ...rows, ...hits]);
    });

    function filter() {
      let any = false;
      for (const groupEl of groups) {
        let visible = 0;
        for (const row of groupEl.querySelectorAll("label[data-source]")) {
          const match = matchesQuery(row.dataset.name, sourceQuery);
          row.hidden = !match;
          const hit = groupEl.querySelector(`.lean-hit[data-lean-source="${CSS.escape(row.dataset.source)}"]`);
          if (hit) hit.hidden = !match;
          row.classList.toggle("is-first", match && visible === 0); // no rule under the group head
          if (match) visible++;
        }
        groupEl.hidden = visible === 0;
        any ||= visible > 0;
      }
      empty.hidden = any;
    }
    search.addEventListener("input", () => { sourceQuery = search.value; filter(); });
    filter();

    return [
      el("div", { class: "search-block" }, [
        search,
        el("p", { class: "search-count", text: `${counts.on} of ${counts.total} on. Off removes a source's stories from every page.` }),
      ]),
      empty,
      ...groups,
    ];
  }

  /** L1: the source's lean marker after its name in the picker, and its tap target
   * (collected into `hits`), tied by an anchor name of its own. Nothing for an outlet
   * outside the US scale. The names are set through the CSSOM, never a style
   * attribute, so the page's CSP is unchanged. */
  function placeLean(row, source, hits) {
    const marker = leanMarker(source.lean);
    const hit = marker && leanHit(source.id, source.lean);
    if (!hit) return;
    const anchor = `--lean-${source.id.replace(/[^a-z0-9_-]/gi, "-")}`;
    marker.style.setProperty("anchor-name", anchor);
    hit.style.setProperty("position-anchor", anchor);
    row.querySelector(".setting-label")?.append(marker);
    hits.push(hit);
  }

  /** The lean sheet for a picker source, sheet.js loaded on this first use. */
  async function openLean(id, opener) {
    const source = sources.find((s) => s.id === id);
    const content = source && leanSheetContent({ lean: source.lean, ownership: source.ownership });
    if (!content) return;
    try {
      const { openSheet } = await import("./sheet.js");
      setBasis(content, Object.hasOwn(bases, id) ? bases[id] : "");
      openSheet({ title: source.name, content, opener });
    } catch (err) {
      console.warn("You page: the lean sheet could not open", err);
    }
  }

  // --- Advanced: raw JSON, add an interest, version history ---
  function saveWithUndo(draft, errorsEl, message) {
    const before = store.history()[0].version;
    const result = store.save(draft);
    if (!result.ok) { showErrors(errorsEl, result.errors); return; }
    render({ keepScroll: true });
    showToast(message(result.profile), { onAction: () => { store.revert(before); render({ keepScroll: true }); } });
  }

  function viewAdvanced(profile) {
    const rawErrors = el("div", { class: "form-errors", role: "alert", "aria-live": "polite" });
    const raw = el("textarea", { class: "raw-editor", id: "raw-json", spellcheck: "false", "aria-label": "Raw profile JSON" });
    raw.value = JSON.stringify(profile, null, 2);
    const saveRaw = el("button", {
      class: "btn-row", type: "button", text: "Save raw JSON",
      onclick: () => {
        let parsed;
        try { parsed = JSON.parse(raw.value); } catch (err) { showErrors(rawErrors, [`Invalid JSON: ${err.message}`]); return; }
        saveWithUndo(parsed, rawErrors, (p) => `Saved as v${p.profile_version}`);
      },
    });

    const newId = el("input", { class: "text-field", type: "text", placeholder: "id, e.g. climate", autocomplete: "off", "aria-label": "New interest id" });
    const newLabel = el("input", { class: "text-field", type: "text", placeholder: "Label, e.g. Climate", autocomplete: "off", "aria-label": "New interest label" });
    const addErrors = el("div", { class: "form-errors", role: "alert", "aria-live": "polite" });
    const add = el("button", {
      class: "btn-quiet", type: "button", text: "+ Add an interest",
      onclick: () => {
        const id = newId.value.trim().toLowerCase();
        const label = newLabel.value.trim();
        if (!id || !label) { showErrors(addErrors, ["Give the new interest both an id and a label."]); return; }
        if (profile.topics[id]) { showErrors(addErrors, [`"${id}" is already an interest.`]); return; }
        const draft = store.current();
        draft.topics[id] = { label, affinity: 0.6, half_life_hours: 24, enabled: true };
        saveWithUndo(draft, addErrors, () => `${label} added`);
      },
    });

    const history = store.history();
    const latest = history[0].version;
    const compareFrom = el("select", { "aria-label": "Compare from version" });
    const compareTo = el("select", { "aria-label": "Compare to version" });
    for (const { version } of history) {
      const text = version === latest ? `v${version} (current)` : `v${version}`;
      compareFrom.appendChild(el("option", { value: String(version), text }));
      compareTo.appendChild(el("option", { value: String(version), text }));
    }
    if (history.length >= 2) {
      compareFrom.value = String(history[1].version);
      compareTo.value = String(history[0].version);
    }
    const diffOutput = el("div", { class: "diff-output", id: "diff-output" });
    function renderDiff() {
      diffOutput.textContent = "";
      const changes = store.diff(Number(compareFrom.value), Number(compareTo.value));
      if (!changes.length) {
        diffOutput.appendChild(el("p", { class: "diff-empty", text: "No differences between these versions." }));
        return;
      }
      for (const line of formatDiff(changes)) {
        const kind = line.startsWith("+") ? " diff-line--added" : line.startsWith("-") ? " diff-line--removed" : "";
        diffOutput.appendChild(el("p", { class: `diff-line${kind}`, text: line }));
      }
    }
    compareFrom.addEventListener("change", renderDiff);
    compareTo.addEventListener("change", renderDiff);
    renderDiff();

    const versions = el("div", { id: "version-list" }, history.map(({ version, timestamp }) => {
      const label = el("span", { class: "version-label" }, [document.createTextNode(`v${version}`)]);
      if (version === latest) label.appendChild(el("span", { class: "version-current", text: " · current" }));
      return el("div", { class: "version-row" }, [
        el("div", {}, [label, el("span", { class: "version-time", text: formatTimestamp(timestamp) })]),
        version === latest ? null : el("button", {
          class: "btn-quiet", type: "button", text: "Revert to this",
          onclick: () => saveWithUndo(store.getVersion(version), rawErrors, () => `Reverted to v${version}`),
        }),
      ]);
    }));

    return [
      section("Raw profile", [
        el("p", { class: "settings-hint", text: "Everything, including trust per source, boosts and mutes, as the profile's JSON. Validated the same way on save." }),
        el("div", { class: "setting-row setting-row--stack" }, [raw, rawErrors]),
        saveRaw,
      ]),
      section("Add an interest", [
        el("div", { class: "setting-row setting-row--stack" }, [
          el("div", { class: "add-topic-fields" }, [newId, newLabel]), add, addErrors,
        ]),
      ]),
      section("Version history", [
        el("p", { class: "settings-hint", text: "Every change is kept. Compare any two versions, or revert to one; a revert saves a new version, nothing is lost." }),
        el("div", { class: "setting-row setting-row--stack" }, [
          el("div", { class: "compare-controls" }, [
            el("label", {}, [document.createTextNode("Compare "), compareFrom]),
            el("label", {}, [document.createTextNode("with "), compareTo]),
          ]),
          diffOutput,
        ]),
        versions,
      ]),
    ];
  }

  // --- Routing and rendering ---
  function titleFor(route, profile) {
    if (route.view === "interest") { const t = profile.topics?.[route.id]; return t && (t.label || route.id); }
    if (route.view === "story") { const s = (profile.standing_stories || []).find((x) => x?.id === route.id); return s && (s.label || s.id); }
    if (route.view === "sources") return "News sources";
    if (route.view === "advanced") return "Advanced";
    return "You";
  }

  const VIEWS = { you: viewYou, interest: viewInterest, story: viewStory, sources: viewSources, advanced: viewAdvanced };

  function render({ keepScroll = false } = {}) {
    const profile = store.current();
    let name = titleFor(current, profile);
    if (!name) { current = { view: "you", key: "you" }; name = "You"; }
    const focusKey = document.activeElement?.dataset?.focusKey;
    const y = scrollY;
    rendering = true;
    let nodes;
    try {
      nodes = VIEWS[current.view](profile, current.id);
    } catch (err) {
      console.warn(`You page: the ${current.view} view could not be drawn`, err);
      nodes = [sectionNotice(null)];
    }
    // L1: the owner's lean marker switches, as rank-gate.js applies them on the front page.
    document.documentElement.classList.toggle("lean-off", !leanMarkersOn(profile));
    document.documentElement.classList.toggle("lean-color", leanColorOn(profile));
    root.replaceChildren(...nodes);
    rendering = false;
    root.removeAttribute("aria-busy");
    root.dataset.view = current.view;
    title.textContent = name;
    document.title = `${name} - Almanac`;
    const isYou = current.view === "you";
    back.setAttribute("href", isYou ? "/" : "#");
    back.setAttribute("aria-label", isYou ? "Back to front page" : "Back to You");
    if (keepScroll) {
      scrollTo(0, y);
      const target = focusKey && root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (target) target.focus({ preventScroll: true });
    }
  }

  function place() {
    if (focusRaw) {
      focusRaw = false;
      document.getElementById("raw-json")?.scrollIntoView({ block: "start" });
    } else {
      scrollTo(0, forward ? 0 : positions[current.key] || 0);
    }
    forward = false;
  }

  function route() {
    const next = parseHash();
    if (next.key === current.key && root.childElementCount) return;
    hideToast();
    positions[current.key] = scrollY;
    previousKey = current.key;
    current = next;
    render();
    place();
    persist();
  }

  // A tap on an in-page row is a forward step: the view it opens starts at its top.
  root.addEventListener("click", (e) => {
    if (e.target.closest?.('a[href^="#"]')) forward = true;
    const lean = e.target.closest?.(".lean-hit[data-lean-source]");
    if (lean) {
      e.preventDefault();
      openLean(lean.getAttribute("data-lean-source"), lean);
    }
  });

  // Back from a sub-view: when the You view is the entry behind this one, step the real
  // history back (so this arrow and the system Back agree and restore the same scroll);
  // a deep link straight into a sub-view has nothing behind it, so go to You instead.
  back.addEventListener("click", (e) => {
    if (current.view === "you") return;
    e.preventDefault();
    if (previousKey === "you") history.back();
    else {
      history.pushState(null, "", location.pathname);
      route();
    }
  });

  addEventListener("hashchange", route);
  addEventListener("popstate", route);

  current = parseHash();
  render();
  place();
}

Promise.all([loadJson("profile.schema.json"), loadJson("source-catalog.json").catch(() => null)])
  .then(([schema, catalog]) => main(schema, catalog))
  .catch((err) => {
    console.warn("You page could not load", err);
    const { root } = pageChrome();
    root.removeAttribute("aria-busy");
    root.replaceChildren(el("p", { class: "settings-hint settings-hint--top section-notice", role: "status",
      text: "Your settings could not be shown just now. Your profile is unchanged. Open this page again to retry." }));
  });
