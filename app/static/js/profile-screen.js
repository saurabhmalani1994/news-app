// S10, redesigned in U2: the You page. One document, five views chosen by the URL hash,
// so every view is precached with the page and works offline, and the browser's own Back
// walks between them:
//
//   /profile                 You: interests, standing stories, sources, display, health,
//                            advanced, each a plain row
//   /profile#interest/<id>   one interest: its level in words, then its fine tuning
//   /profile#story/<id>      one standing story: keywords, floor, alarm hours
//   /profile#sources         sources collapsed into about eight groups, with search
//   /profile#sources/<id>    one group's own sources, search and on/off
//   /profile#advanced        the raw JSON editor, version history, diff and revert
//
// S12's why-this links still land: "#topic-<id>" becomes "#interest/<id>" and
// "#raw-json" becomes "#advanced" with the editor in view (replaceState, no extra Back
// step). Every change is one ProfileStore save (one version) with a quiet Undo that
// reverts to the version before it. The only fetches are this app's own schema and
// source catalog, both precached, and (W1) the interests sync's PUT below.
//
// L1: Display carries the lean marker's two switches (on, colored), and the source
// picker shows each outlet's marker after its name, a tap on it opening the lean sheet
// (js/lean.js) with the catalog's cited basis. The sheet module loads on that first tap,
// so a page without its markup can never be taken down by it.
//
// H2: a profile saved by an older build is migrated forward on load (migrate.js, one
// new version, history kept). No lookup can take the page down: the page's own chrome
// is found or made (pageChrome), and every section is found or made too, so a missing
// field shows a calm line in that section only while the rest of the page works.
//
// U4: the You list's own way to add or remove an interest, since U2 left the list
// display-only. "Add interest" is the list's last row, opening the same reusable sheet
// (sheet.js) as the lean picker, its search field and grouped catalog built from
// you-edits.js's INTEREST_CATALOG (the ids the pipeline can actually match). "Remove
// interest" sits at the bottom of the per-interest page, no confirmation: it commits,
// steps back to the list (a stale hash into a deleted interest is never left behind),
// and a quiet Undo restores the exact version before it, same as every other edit here.
//
// U5: the sources page nested. The owner, on his phone: "the you page now got way too
// big again... specifically the news sources page" (97 sources, every one drawn at
// once). #sources now draws one collapsed row per group (you-edits.js's groupSources,
// about eight of them) with its own "N of M on" count and a chevron; opening one is a
// forward step to its own sub-view (#sources/<id>), the same one-level-deeper pattern
// #interest/<id> already uses, so the masthead Back and the system Back both land on
// the list they came from (backTarget below). Typing in the list's own search field
// shows every matching source flat, from any group, in place of the collapsed rows;
// clearing it restores the list. Nothing about a source row itself changed: same
// switch, same lean marker and tap target, same one-version toggle.
//
// W1 (R50): the add sheet also follows a phrase, the owner's own free text: the search
// field doubles as the phrase field, and a "Follow a phrase" row above the catalog takes
// what is typed. A phrase interest lists in quotes and has a page like a topic's (level,
// fine tuning, Remove with Undo), without the tag-only mute and boosts. Standing stories
// gain an "Add standing story" row (a name and keywords, js/standing-form.js) and a
// "Remove standing story" action with Undo. Every save also schedules the interests
// sync (js/interests-sync.js), which sends the phrase and standing-story searches, and
// only those, to this site's own /api/interests for the hourly run.
import { ProfileStore } from "./profile/store.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { migrateProfile } from "./profile/migrate.js";
import { formatDiff } from "./profile/diff.js";
import { showToast, hideToast } from "./toast.js";
import {
  LEVELS, levelOf, levelWord, withTopicLevel, withTopicField, withTopicMuted, boostsForTopic,
  withBoostAmount, withBoostRemoved, withStandingField, summariesMode, withSummaries,
  leanMarkersOn, leanColorOn, withLeanMarkers, withLeanColor, SOURCE_STATES, sourceState, withSourceState, withSourceStates, sourceCounts, groupSources,
  matchesQuery, searchSources, sourceDetail, HEALTH_WORDS, commitEdit,
  availableInterests, withTopicAdded, withTopicRemoved,
  isPhraseTopic, phraseStatus, withPhraseAdded, standingStatus, withStandingAdded, withStandingRemoved,
} from "./profile/you-edits.js";
import { leanHit, leanMarker, leanSheetContent, setBasis } from "./lean.js";
import { PHRASE_MAX, QUERIES_MAX } from "./phrase.js";
import { scheduleSync, startSync } from "./interests-sync.js";
import { standingForm, standingMessage } from "./standing-form.js";

/** W1: a phrase interest's name as the page shows it, in quotes. */
const phraseName = (phrase) => `“${phrase}”`;
const topicName = (id, t) => (isPhraseTopic(t) ? phraseName(t.phrase) : t.label || id);

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
  const store = new ProfileStore({
    storage: window.localStorage, schema, seedDefault: buildDefaultProfile, migrate: migrateProfile,
    onSave: () => scheduleSync(),
  });
  startSync();
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
    if (view === "sources" && id) return { view: "sourceGroup", id, key: hash };
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

  // --- U4: add an interest, from a bottom sheet opened off the list's own last row.
  // sheet.js loads on that first tap only (the same lazy import openLean already uses),
  // so a page without the sheet's markup can never be taken down by it. ---
  function addInterestRow() {
    return el("button", {
      class: "setting-row", type: "button", id: "add-interest-row", "data-focus-key": "add-interest",
      onclick: (e) => openAddInterest(e.currentTarget),
    }, [rowText("Add interest"), chevron()]);
  }

  /** The sheet body: one field that both searches the catalog and takes a phrase (W1),
   * the "Follow a phrase" row under it, then the catalog entries not already an
   * interest, grouped the same way the source picker groups by region. The phrase row
   * says what a tap would do with what is typed, or why it cannot. */
  function addInterestContent(profile) {
    const available = availableInterests(profile);
    const search = el("input", {
      class: "text-field search-field", type: "search", placeholder: "Search, or type a phrase to follow",
      "aria-label": "Search interests or type a phrase", autocomplete: "off", spellcheck: "false", enterkeyhint: "go",
      maxlength: String(PHRASE_MAX + 20),
    });
    const phraseRow = el("button", { class: "setting-row", type: "button", id: "follow-phrase-row", "data-focus-key": "follow-phrase" },
      [rowText("Follow a phrase", "Type any word or phrase above")]);
    const [phraseLabel, phraseSub] = phraseRow.querySelectorAll(".setting-label, .setting-sublabel");
    const PHRASE_SUBS = {
      ok: "Headlines and summaries with these words, in this order, and the hourly search",
      long: `Too long: ${PHRASE_MAX} characters at most`,
      duplicate: "Already one of your interests",
      full: `You follow ${QUERIES_MAX} phrases and standing stories, the most the hourly search takes`,
    };
    const empty = el("p", { class: "settings-hint settings-hint--top", text: "No interest matches.", hidden: true });
    const byGroup = new Map();
    for (const entry of available) {
      if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
      byGroup.get(entry.group).push(entry);
    }
    const groups = [...byGroup.entries()].map(([label, entries]) => {
      const rows = entries.map((entry) => {
        const row = el("button", { class: "setting-row", type: "button", "data-focus-key": `add-${entry.id}` }, [rowText(entry.label)]);
        row.dataset.id = entry.id;
        row.dataset.name = entry.label;
        return row;
      });
      return { section: el("div", { class: "settings-section" }, [el("h2", { class: "settings-label", text: label }), ...rows]), rows };
    });
    function filter() {
      const query = search.value;
      const status = phraseStatus(store.current(), query);
      phraseRow.dataset.state = status.ok ? "ok" : status.reason;
      phraseRow.setAttribute("aria-disabled", String(!status.ok && status.reason !== "empty"));
      phraseLabel.textContent = status.phrase ? `Follow ${phraseName(status.phrase)}` : "Follow a phrase";
      phraseSub.textContent = PHRASE_SUBS[status.ok ? "ok" : status.reason] || "Type any word or phrase above";
      let any = false;
      for (const g of groups) {
        let visible = 0;
        for (const row of g.rows) {
          const match = matchesQuery(row.dataset.name, query);
          row.hidden = !match;
          if (match) visible++;
        }
        g.section.hidden = visible === 0;
        any ||= visible > 0;
      }
      empty.hidden = any || !groups.length || Boolean(status.phrase);
    }
    search.addEventListener("input", filter);
    // Enter adds the catalog entry typed out in full, else follows the phrase.
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const typed = search.value.trim().toLowerCase();
      const exact = groups.flatMap((g) => g.rows).find((r) => r.dataset.name.toLowerCase() === typed);
      if (exact) addInterestChosen(exact.dataset.id, exact.dataset.name);
      else if (phraseRow.dataset.state === "ok") addPhraseChosen(search.value);
    });
    phraseRow.addEventListener("click", () => {
      if (phraseRow.dataset.state === "ok") addPhraseChosen(search.value);
      else if (phraseRow.dataset.state === "empty") search.focus();
    });
    filter();
    const catalog = groups.length ? groups.map((g) => g.section)
      : [el("p", { class: "settings-hint settings-hint--top", text: "Every topic this app tags is already on your list." })];
    const wrap = el("div", {}, [
      el("div", { class: "search-block" }, [search]),
      el("div", { class: "settings-section" }, [el("h2", { class: "settings-label", text: "Phrase" }), phraseRow]),
      empty, ...catalog,
    ]);
    wrap.addEventListener("click", (e) => {
      const row = e.target.closest("button[data-id]");
      if (row) addInterestChosen(row.dataset.id, row.dataset.name);
    });
    return wrap;
  }

  /** One commit from a sheet: close it, redraw, and a quiet toast with Undo. */
  async function commitFromSheet(edit, message) {
    const result = commitEdit(store, edit);
    // Already loaded by the sheet's own opener to get here; a dynamic re-import just
    // reads the module cache, no second fetch.
    const { closeSheet } = await import("./sheet.js");
    closeSheet();
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

  function addInterestChosen(id, label) {
    return commitFromSheet((p) => withTopicAdded(p, id), `${label} added`);
  }

  function addPhraseChosen(text) {
    const status = phraseStatus(store.current(), text);
    if (!status.ok) return null;
    return commitFromSheet((p) => withPhraseAdded(p, text), `Following ${phraseName(status.phrase)}`);
  }

  async function openAddInterest(opener) {
    try {
      const { openSheet } = await import("./sheet.js");
      openSheet({ title: "Add interest", content: addInterestContent(store.current()), opener });
    } catch (err) {
      console.warn("You page: the add-interest sheet could not open", err);
    }
  }

  // --- W1: add a standing story, from the same sheet, a name and its keywords. ---
  function addStandingRow() {
    return el("button", {
      class: "setting-row", type: "button", id: "add-standing-row", "data-focus-key": "add-standing",
      onclick: (e) => openAddStanding(e.currentTarget),
    }, [rowText("Add standing story"), chevron()]);
  }

  async function openAddStanding(opener) {
    try {
      const { openSheet, closeSheet } = await import("./sheet.js");
      const content = standingForm({
        submitText: "Add",
        onSubmit: (label, keywords) => {
          const status = standingStatus(store.current(), { label, keywords });
          if (!status.ok) return standingMessage(status.reason);
          const result = commitEdit(store, (p) => withStandingAdded(p, { label, keywords }));
          if (!result?.ok) return result ? `Not saved: ${result.errors[0]}` : standingMessage("name");
          closeSheet();
          render({ keepScroll: true });
          showToast(`Following ${status.label}`, {
            onAction: () => {
              store.revert(result.before);
              render({ keepScroll: true });
            },
          });
          return null;
        },
      });
      openSheet({ title: "Add standing story", content, opener });
    } catch (err) {
      console.warn("You page: the add-standing-story sheet could not open", err);
    }
  }

  // --- You ---
  function viewYou(profile) {
    return [
      section("Your interests", () => [el("div", { id: "topics-list" }, [
        ...Object.entries(profile.topics).map(([id, t]) => {
          const floor = t.enabled !== false && t.floor_slots > 0;
          const value = floor ? `Top ${t.floor_slots}` : levelWord(levelOf(t));
          return linkRow(`#interest/${encodeURIComponent(id)}`, topicName(id, t), null, value, { "data-topic": id });
        }),
        addInterestRow(),
      ])]),
      section("Standing stories", () => {
        const stories = (profile.standing_stories || []).map((s) => linkRow(`#story/${encodeURIComponent(s.id)}`, s.label || s.id, null,
          s.enabled ? "On" : "Off", { "data-story": s.id }));
        return [
          stories.length ? null : el("p", { class: "settings-hint", text: "None followed. A standing story keeps a subject on Today and says when it goes quiet." }),
          el("div", { id: "standing-list" }, [...stories, addStandingRow()]),
        ];
      }),
      section("News sources", () => {
        const counts = sourceCounts(profile, sources);
        const sourcesLabel = sources.length ? `${counts.on} of ${counts.total} sources on` : "Choose your sources";
        return [linkRow("#sources", sourcesLabel, "Pick the outlets your pages draw from", null, { id: "sources-row" })];
      }),
      section("Display", () => [switchRow("summaries", "Summaries on every story", "Off shows them on the lead stories only",
        summariesMode(profile) === "all",
        (on) => commit((p) => withSummaries(p, on ? "all" : "top"), on ? "Summaries on every story" : "Summaries on lead stories only")),
      switchRow("lean-markers", "Lean markers", "Five dots for a US outlet's lean, a country code for others",
        leanMarkersOn(profile),
        (on) => commit((p) => withLeanMarkers(p, on), on ? "Lean markers on" : "Lean markers off")),
      switchRow("lean-color", "Color the markers", "Blue for left, red for right, grey for center",
        leanColorOn(profile),
        (on) => commit((p) => withLeanColor(p, on), on ? "Markers in color" : "Markers in grey"))]),
      section("Health", [linkRow("/health", "Feed health", "Pool age, the last run, every source's status")]),
      section("Advanced", () => [linkRow("#advanced", "Profile data and versions", `Raw JSON, history and revert. Now v${store.history()[0].version}`)]),
      el("footer", { class: "colophon colophon--settings" }, [
        el("p", { class: "colophon-text", text: "Kept on this device. Only the searches for your phrases and standing stories leave it, to this site's own server, for the hourly run." }),
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
    const phrase = isPhraseTopic(topic);
    const name = topicName(id, topic);
    const levelButtons = el("div", { class: "level-control", role: "radiogroup", "aria-label": `${name} level` },
      LEVELS.map((l) => el("button", {
        class: "level-option", type: "button", role: "radio", "aria-checked": String(l.id === level),
        "data-focus-key": `level-${l.id}`, text: l.word,
        onclick: () => commit((p) => withTopicLevel(p, id, l.id), `${name}: ${l.word}`),
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
    const levelSection = el("section", { class: "settings-section" }, [
      el("h2", { class: "settings-label", text: "Level" }),
      levelButtons,
      el("p", { class: "settings-hint settings-hint--after", text: LEVEL_HINTS[level] }),
    ]);
    const remove = el("button", { class: "btn-row", type: "button", text: "Remove interest", "data-focus-key": "remove-interest",
      onclick: () => removeInterest(id, name) });
    // W1: a phrase matches by its words, never by a pool tag, so the tag-only mute and
    // topic boosts do not apply; what it matches, and that it is searched, is said here.
    if (phrase) {
      return [
        levelSection,
        section("Phrase", [
          el("p", { class: "settings-hint", id: "phrase-how", text: `Lifts a story whose headline or summary holds ${name}: the whole words, in this order, in any case, singular or plural.` }),
          el("p", { class: "settings-hint", text: topic.enabled === false
            ? "The hourly search skips it while it is off."
            : "The hourly search also looks for it on Google News, so stories the app has not fetched yet can arrive." }),
        ]),
        section("Fine tuning", tuning),
        remove,
      ];
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

    return [levelSection, section("Fine tuning", tuning), section("Boosts", boostRows), remove];
  }

  // U4: no confirmation dialog (the ask is explicit about that): commit the removal,
  // then step back to the list the same way the masthead arrow would, so a stale hash
  // into an interest that no longer exists is never left in the address bar or the
  // history stack. A plain replaceState, not history.back(): popstate for a real Back
  // fires asynchronously, which would race the toast this shows right after (route()'s
  // own hideToast() could hide it before the owner ever sees it); replaceState never
  // fires popstate at all, so there is nothing to race.
  function removeInterest(id, label) {
    removeAndReturn((p) => withTopicRemoved(p, id), `Removed ${label}.`);
  }

  // W1: the same for a standing story, from its own page.
  function removeStanding(id, label) {
    removeAndReturn((p) => withStandingRemoved(p, id), `Removed ${label}.`);
  }

  function removeAndReturn(edit, message) {
    const result = commitEdit(store, edit);
    if (!result) return;
    if (!result.ok) {
      showToast(`Not saved: ${result.errors[0]}`);
      render({ keepScroll: true });
      return;
    }
    hideToast();
    previousKey = current.key;
    current = { view: "you", key: "you" };
    history.replaceState(null, "", location.pathname);
    render();
    place();
    persist();
    showToast(message, {
      onAction: () => {
        store.revert(result.before);
        render({ keepScroll: true });
      },
    });
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
      el("button", { class: "btn-row", type: "button", text: "Remove standing story", "data-focus-key": "remove-story",
        onclick: () => removeStanding(id, story.label || id) }),
    ];
  }

  // --- Sources: a collapsed list of groups, each opening to its own sub-view, with a
  // search field that shows matches flat (from every group) while it holds text (U5).
  /** One source row: its switch, health line and lean marker (`hits` collects the
   * marker's own tap target, appended after every row in the section so a hit sitting
   * between two rows never breaks their hairline, same reasoning as before U5). */
  function sourceRow(profile, s, hits) {
    const detail = [sourceDetail(s), HEALTH_WORDS[s.health] || ""].filter(Boolean).join(" · ");
    const row = switchRow(`source-${s.id}`, s.name, detail, sourceState(profile, s.id) === SOURCE_STATES.ON,
      (on) => commit((p) => withSourceState(p, s.id, on ? SOURCE_STATES.ON : SOURCE_STATES.OFF), `${s.name} ${on ? "on" : "off"}`));
    row.dataset.source = s.id;
    row.dataset.name = s.name;
    if (s.health === "down" || s.health === "failing") row.classList.add("source-row--unwell");
    placeLean(row, s, hits);
    return row;
  }

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

    const groups = groupSources(sources);
    const groupList = el("section", { class: "settings-section", id: "source-group-list" },
      groups.map((group) => {
        const gc = sourceCounts(profile, group.sources);
        return linkRow(`#sources/${encodeURIComponent(group.id)}`, group.label, null, `${gc.on} of ${gc.total} on`, { "data-group": group.id });
      }));
    const results = el("section", { class: "settings-section", id: "source-search-results" });

    function renderResults() {
      const matches = searchSources(sources, sourceQuery);
      const hits = [];
      const rows = matches.map((s) => sourceRow(profile, s, hits));
      results.replaceChildren(...rows, ...hits);
      results.hidden = rows.length === 0; // no stray empty divider under "No source matches."
      empty.hidden = rows.length > 0;
    }
    function update() {
      const searching = sourceQuery.trim().length > 0;
      groupList.hidden = searching;
      if (searching) renderResults();
      else { results.hidden = true; empty.hidden = true; }
    }
    search.addEventListener("input", () => { sourceQuery = search.value; update(); });
    update();

    return [
      el("div", { class: "search-block" }, [
        search,
        el("p", { class: "search-count", text: `${counts.on} of ${counts.total} on. Off removes a source's stories from every page.` }),
      ]),
      empty,
      groupList,
      results,
    ];
  }

  /** One group's own sources: its "turn all on or off" and every one of its rows, same
   * shape the flat list used to show for every source at once. */
  function viewSourceGroup(profile, groupId) {
    const group = groupSources(sources).find((g) => g.id === groupId);
    if (!group) {
      return [el("p", { class: "settings-hint settings-hint--top", text: "That group is no longer available." })];
    }
    const ids = group.sources.map((s) => s.id);
    const gc = sourceCounts(profile, group.sources);
    const allOn = gc.on === gc.total;
    const next = allOn ? SOURCE_STATES.OFF : SOURCE_STATES.ON;
    const head = el("div", { class: "group-head" }, [
      el("p", { class: "settings-hint group-head-count", text: `${gc.on} of ${gc.total} on` }),
      el("button", {
        class: "btn-quiet group-action", type: "button", "data-focus-key": "group-all",
        text: allOn ? "Turn all off" : "Turn all on", "aria-label": `${allOn ? "Turn all off" : "Turn all on"}: ${group.label}`,
        onclick: () => commit((p) => withSourceStates(p, ids, next), `${group.label}: all ${next}`),
      }),
    ]);
    const hits = [];
    const rows = group.sources.map((s) => sourceRow(profile, s, hits));
    return [el("section", { class: "settings-section source-group", "data-bucket": group.id }, [head, ...rows, ...hits])];
  }

  /** L1: the source's lean marker after its name in the picker, and its tap target
   * (collected into `hits`), tied by an anchor name of its own. U3: an outlet outside
   * the US scale shows its country code. The names are set through the CSSOM, never a
   * style attribute, so the page's CSP is unchanged. */
  function placeLean(row, source, hits) {
    const marker = leanMarker(source.lean, { country: source.country });
    const hit = marker && leanHit(source.id, source.lean, document, source.country);
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
    const content = source && leanSheetContent({ lean: source.lean, country: source.country, ownership: source.ownership });
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
    if (route.view === "interest") { const t = profile.topics?.[route.id]; return t && topicName(route.id, t); }
    if (route.view === "story") { const s = (profile.standing_stories || []).find((x) => x?.id === route.id); return s && (s.label || s.id); }
    if (route.view === "sourceGroup") { const g = groupSources(sources).find((x) => x.id === route.id); return g && g.label; }
    if (route.view === "sources") return "News sources";
    if (route.view === "advanced") return "Advanced";
    return "You";
  }

  // U5: a sub-view's own parent, for the masthead Back arrow. Every view but a source
  // group steps out to You, same as before; a source group steps out to the sources
  // list it was opened from.
  const backTarget = (view) => (view === "sourceGroup" ? "sources" : "you");

  const VIEWS = { you: viewYou, interest: viewInterest, story: viewStory, sources: viewSources, sourceGroup: viewSourceGroup, advanced: viewAdvanced };

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
    const parent = backTarget(current.view);
    back.setAttribute("href", isYou ? "/" : parent === "sources" ? "#sources" : "#");
    back.setAttribute("aria-label", isYou ? "Back to front page" : parent === "sources" ? "Back to sources" : "Back to You");
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

  // Back from a sub-view: when its own parent is the entry behind this one, step the
  // real history back (so this arrow and the system Back agree and restore the same
  // scroll); a deep link straight into a sub-view has nothing behind it, so land on the
  // parent instead (You for most views, the sources list for one of its groups, U5).
  back.addEventListener("click", (e) => {
    if (current.view === "you") return;
    e.preventDefault();
    const parent = backTarget(current.view);
    if (previousKey === parent) history.back();
    else if (parent === "sources") {
      history.pushState(null, "", "#sources");
      route();
    } else {
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
