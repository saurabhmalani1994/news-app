// S10: a readable diff between two profile versions.
//
// Plain-object fields (topics keyed by id, trust keyed by source id) diff key by key.
// The boosts array diffs by its own id field, since order is not meaningful. The two
// mute lists diff as sets, since order is not meaningful there either. Everything else
// is a scalar compare. The result is a flat list of changes, each with a dotted path
// so the UI can render one line per change without knowing the profile's shape.

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarEqual(a, b) {
  return a === b;
}

function diffScalar(path, before, after, changes) {
  if (!scalarEqual(before, after)) changes.push({ path, kind: "changed", before, after });
}

function diffKeyedObject(path, before, after, changes) {
  const beforeKeys = new Set(Object.keys(before || {}));
  const afterKeys = new Set(Object.keys(after || {}));
  for (const key of new Set([...beforeKeys, ...afterKeys])) {
    const childPath = `${path}.${key}`;
    if (!beforeKeys.has(key)) changes.push({ path: childPath, kind: "added", before: undefined, after: after[key] });
    else if (!afterKeys.has(key)) changes.push({ path: childPath, kind: "removed", before: before[key], after: undefined });
    else diffAny(childPath, before[key], after[key], changes);
  }
}

function diffStringSet(path, before, after, changes) {
  const beforeSet = new Set(before || []);
  const afterSet = new Set(after || []);
  for (const value of afterSet) {
    if (!beforeSet.has(value)) changes.push({ path, kind: "added", before: undefined, after: value });
  }
  for (const value of beforeSet) {
    if (!afterSet.has(value)) changes.push({ path, kind: "removed", before: value, after: undefined });
  }
}

function diffById(path, before, after, changes) {
  const beforeById = new Map((before || []).map((item) => [item.id, item]));
  const afterById = new Map((after || []).map((item) => [item.id, item]));
  for (const [id, item] of afterById) {
    if (!beforeById.has(id)) changes.push({ path: `${path}[${id}]`, kind: "added", before: undefined, after: item });
  }
  for (const [id, item] of beforeById) {
    if (!afterById.has(id)) changes.push({ path: `${path}[${id}]`, kind: "removed", before: item, after: undefined });
  }
  for (const [id, afterItem] of afterById) {
    const beforeItem = beforeById.get(id);
    if (beforeItem) diffKeyedObject(`${path}[${id}]`, beforeItem, afterItem, changes);
  }
}

function diffAny(path, before, after, changes) {
  if (isPlainObject(before) && isPlainObject(after)) {
    diffKeyedObject(path, before, after, changes);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.every((v) => typeof v === "string") && after.every((v) => typeof v === "string")) {
      diffStringSet(path, before, after, changes);
      return;
    }
    if (before.every((v) => isPlainObject(v) && "id" in v) && after.every((v) => isPlainObject(v) && "id" in v)) {
      diffById(path, before, after, changes);
      return;
    }
  }
  diffScalar(path, before, after, changes);
}

/**
 * The profile's own bookkeeping fields (profile_version, updated_at) are excluded by
 * default: they always change between two saved versions and would drown out the
 * changes the owner actually made. Pass `includeMeta: true` to see them too.
 */
export function diffProfiles(before, after, { includeMeta = false } = {}) {
  const changes = [];
  const skip = includeMeta ? new Set() : new Set(["profile_version", "updated_at", "schema_version"]);
  const beforeKeys = Object.keys(before || {}).filter((k) => !skip.has(k));
  const afterKeys = Object.keys(after || {}).filter((k) => !skip.has(k));
  for (const key of new Set([...beforeKeys, ...afterKeys])) {
    diffAny(`$.${key}`, before ? before[key] : undefined, after ? after[key] : undefined, changes);
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function formatValue(value) {
  if (value === undefined) return "(none)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** One readable line per change, e.g. "topics.singapore.affinity: 0.8 -> 0.9". */
export function formatDiff(changes) {
  return changes.map((change) => {
    const path = change.path.replace(/^\$\./, "");
    if (change.kind === "added") return `+ ${path}: ${formatValue(change.after)}`;
    if (change.kind === "removed") return `- ${path}: ${formatValue(change.before)}`;
    return `${path}: ${formatValue(change.before)} -> ${formatValue(change.after)}`;
  });
}
