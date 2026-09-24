// S10: wires the Profile screen to the versioned local store. Browser only (uses
// localStorage, fetch and the DOM); the pure logic it calls (validate, diff, store,
// default-profile) is the part covered by the Node tests in tests/js. Nothing here
// makes a network call except the same-origin fetch of this app's own schema file: the
// profile itself is never sent anywhere.
import { ProfileStore } from "./profile/store.js";
import { buildDefaultProfile } from "./profile/default-profile.js";
import { formatDiff } from "./profile/diff.js";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

function formatTimestamp(iso) {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : dateFormat.format(parsed);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function clearErrors(container) {
  container.textContent = "";
}

function showErrors(container, errors) {
  clearErrors(container);
  if (!errors.length) return;
  const list = el("ul");
  for (const message of errors) list.appendChild(el("li", { text: message }));
  container.appendChild(el("p", { text: errors.length === 1 ? "Could not save:" : `Could not save (${errors.length} problems):` }));
  container.appendChild(list);
}

async function loadSchema() {
  const response = await fetch("profile.schema.json");
  if (!response.ok) throw new Error(`could not load profile.schema.json: ${response.status}`);
  return response.json();
}

function main(schema) {
  const store = new ProfileStore({
    storage: window.localStorage,
    schema,
    seedDefault: buildDefaultProfile,
  });

  const root = document.getElementById("settings-root");
  const topicsList = document.getElementById("topics-list");
  const newTopicId = document.getElementById("new-topic-id");
  const newTopicLabel = document.getElementById("new-topic-label");
  const formErrors = document.getElementById("form-errors");
  const formNote = document.getElementById("form-note");
  const rawJson = document.getElementById("raw-json");
  const rawErrors = document.getElementById("raw-errors");
  const compareFrom = document.getElementById("compare-from");
  const compareTo = document.getElementById("compare-to");
  const diffOutput = document.getElementById("diff-output");
  const versionList = document.getElementById("version-list");

  // The working copy the form edits. Replaced with a fresh clone of the saved profile
  // after every successful save or revert, so the form never drifts from what is
  // actually on disk. The raw JSON editor is a separate path (see saveRaw below): it
  // reads and writes the store directly and does not go through this draft.
  let draft = store.current();

  function renderTopicRow(id, setting) {
    const affinityPct = Math.round(setting.affinity * 100);
    const header = el("div", { class: "setting-row" }, [
      el("div", { class: "setting-row-text" }, [
        el("span", { class: "setting-label", text: setting.label }),
        el("span", { class: "setting-sublabel", text: id }),
      ]),
      el("input", {
        class: "setting-control", type: "checkbox",
        ...(setting.enabled ? { checked: "checked" } : {}),
        "aria-label": `${setting.label} enabled`,
        onchange: (e) => { draft.topics[id].enabled = e.target.checked; },
      }),
    ]);

    const affinitySub = el("span", { class: "setting-sublabel", text: `Affinity ${affinityPct}%` });
    const affinityRow = el("div", { class: "setting-row" }, [
      el("div", { class: "setting-row-text" }, [
        el("span", { class: "setting-label", text: "Affinity" }),
        affinitySub,
      ]),
      el("input", {
        class: "setting-control", type: "range", min: "0", max: "1", step: "0.05",
        value: String(setting.affinity), "aria-label": `${setting.label} affinity`,
        oninput: (e) => {
          const value = Number(e.target.value);
          draft.topics[id].affinity = value;
          affinitySub.textContent = `Affinity ${Math.round(value * 100)}%`;
        },
      }),
    ]);

    const halfLifeRow = el("div", { class: "setting-row" }, [
      el("div", { class: "setting-row-text" }, [
        el("span", { class: "setting-label", text: "Half-life" }),
        el("span", { class: "setting-sublabel", text: "Hours until this topic's recency score halves" }),
      ]),
      el("input", {
        class: "setting-half-life", type: "number", min: "1", max: "168", step: "1",
        value: String(setting.half_life_hours), "aria-label": `${setting.label} half-life in hours`,
        onchange: (e) => { draft.topics[id].half_life_hours = Number(e.target.value); },
      }),
    ]);

    return el("div", { class: "setting-group", id: `topic-${id}` }, [header, affinityRow, halfLifeRow]);
  }

  function renderTopics() {
    topicsList.textContent = "";
    for (const [id, setting] of Object.entries(draft.topics)) {
      topicsList.appendChild(renderTopicRow(id, setting));
    }
  }

  // S12's why-this sheet links here as "profile.html#topic-<id>" or "#raw-json": the
  // field that drove a story's largest term. Topic rows exist only after this fetch
  // resolves, so the browser's own fragment scroll (which only fires once, at load)
  // never reaches them; this runs it by hand, once, after the first render.
  function scrollToHash() {
    const target = location.hash && document.getElementById(location.hash.slice(1));
    if (!target) return;
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  }

  function renderVersions() {
    const history = store.history(); // newest first
    const latest = history[0]?.version;

    versionList.textContent = "";
    for (const { version, timestamp } of history) {
      const label = el("span", { class: "version-label" }, [
        document.createTextNode(`v${version}`),
      ]);
      if (version === latest) label.appendChild(el("span", { class: "version-current", text: " · current" }));
      const row = el("div", { class: "version-row" }, [
        el("div", {}, [label, el("span", { class: "version-time", text: formatTimestamp(timestamp) })]),
      ]);
      if (version !== latest) {
        row.appendChild(el("button", {
          class: "btn-quiet", type: "button", text: "Revert to this",
          onclick: () => {
            store.revert(version);
            formNote.textContent = `Reverted: saved as v${store.history()[0].version}.`;
            refreshAfterSave();
          },
        }));
      }
      versionList.appendChild(row);
    }

    for (const select of [compareFrom, compareTo]) select.textContent = "";
    for (const { version } of history) {
      const optionText = version === latest ? `v${version} (current)` : `v${version}`;
      compareFrom.appendChild(el("option", { value: String(version), text: optionText }));
      compareTo.appendChild(el("option", { value: String(version), text: optionText }));
    }
    if (history.length >= 2) {
      compareFrom.value = String(history[1].version);
      compareTo.value = String(history[0].version);
    }
    renderDiff();
  }

  function renderDiff() {
    const fromVersion = Number(compareFrom.value);
    const toVersion = Number(compareTo.value);
    diffOutput.textContent = "";
    if (!fromVersion || !toVersion) return;
    const changes = store.diff(fromVersion, toVersion);
    if (!changes.length) {
      diffOutput.appendChild(el("p", { class: "diff-empty", text: "No differences between these versions." }));
      return;
    }
    for (const line of formatDiff(changes)) {
      const kindClass = line.startsWith("+") ? " diff-line--added" : line.startsWith("-") ? " diff-line--removed" : "";
      diffOutput.appendChild(el("p", { class: `diff-line${kindClass}`, text: line }));
    }
  }

  function renderRaw() {
    rawJson.value = JSON.stringify(store.current(), null, 2);
    clearErrors(rawErrors);
  }

  function renderAll() {
    draft = store.current();
    renderTopics();
    renderRaw();
    renderVersions();
    root.removeAttribute("aria-busy");
  }

  function refreshAfterSave() {
    clearErrors(formErrors);
    renderAll();
  }

  document.getElementById("add-topic-btn").addEventListener("click", () => {
    const id = newTopicId.value.trim().toLowerCase();
    const label = newTopicLabel.value.trim();
    clearErrors(formErrors);
    if (!id || !label) {
      showErrors(formErrors, ["Give the new interest both an id and a label."]);
      return;
    }
    if (draft.topics[id]) {
      showErrors(formErrors, [`"${id}" is already an interest.`]);
      return;
    }
    draft.topics[id] = { label, affinity: 0.5, half_life_hours: 24, enabled: true };
    newTopicId.value = "";
    newTopicLabel.value = "";
    renderTopics();
    formNote.textContent = `"${label}" added below. Save changes to keep it.`;
  });

  document.getElementById("save-form-btn").addEventListener("click", () => {
    const result = store.save(draft);
    if (!result.ok) {
      showErrors(formErrors, result.errors);
      return;
    }
    formNote.textContent = `Saved as v${result.profile.profile_version}.`;
    refreshAfterSave();
  });

  document.getElementById("save-raw-btn").addEventListener("click", () => {
    let parsed;
    try {
      parsed = JSON.parse(rawJson.value);
    } catch (err) {
      showErrors(rawErrors, [`Invalid JSON: ${err.message}`]);
      return;
    }
    const result = store.save(parsed);
    if (!result.ok) {
      showErrors(rawErrors, result.errors);
      return;
    }
    formNote.textContent = `Saved as v${result.profile.profile_version}.`;
    refreshAfterSave();
  });

  compareFrom.addEventListener("change", renderDiff);
  compareTo.addEventListener("change", renderDiff);

  renderAll();
  scrollToHash();
}

loadSchema()
  .then(main)
  .catch((err) => {
    const root = document.getElementById("settings-root");
    root.removeAttribute("aria-busy");
    root.textContent = "";
    root.appendChild(el("p", { class: "form-errors", text: `Could not load the profile screen: ${err.message}` }));
  });
