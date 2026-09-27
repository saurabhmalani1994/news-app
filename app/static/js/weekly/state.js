// S29: what the owner decided in this week's review, kept on the device next to the
// profile (the same Web Storage adapter ProfileStore takes, so Node tests pass a
// MemoryStorage). One small record for the current ISO week only: a new week starts
// empty, so last week's Skip never hides this week's evidence.
//
//   decided   {path: "accepted" | "skipped" | "undone"}: a path decided this week is
//             not proposed again this week, whatever the evidence, so an accepted step
//             cannot be followed by a second step on the same path (the runaway loop
//             research section 6 warns about) and an undone one does not come back.
//   accepted  [{path, label, old_value, new_value, proposal_id, version}] for Undo.
//
// Undo writes the old values back as one new profile version, only for paths whose
// value is still exactly what the review set: an owner edit made since wins.

import { readPath, parsePath, applyChanges } from "../ai/gate.js";

export const WEEKLY_KEY = "almanac.weekly.v1";

function empty(week) {
  return { week, decided: {}, accepted: [] };
}

export function readWeekly(storage, week) {
  try {
    const data = JSON.parse(storage.getItem(WEEKLY_KEY) || "null");
    if (data && data.week === week && data.decided && typeof data.decided === "object" && Array.isArray(data.accepted)) return data;
  } catch {
    // A corrupt record starts the week over; it only ever holds decisions, never weights.
  }
  return empty(week);
}

function write(storage, data) {
  storage.setItem(WEEKLY_KEY, JSON.stringify(data));
}

export function markSkipped(storage, week, path) {
  const data = readWeekly(storage, week);
  data.decided[path] = "skipped";
  write(storage, data);
  return data;
}

export function markAccepted(storage, week, item, version) {
  const data = readWeekly(storage, week);
  data.decided[item.path] = "accepted";
  data.accepted.push({ path: item.path, label: item.name || item.path, old_value: item.old_value, new_value: item.new_value, proposal_id: item.id, version });
  write(storage, data);
  return data;
}

/** The profile draft that undoes this week's accepted changes, and the paths it
 * restores; a path the owner has since changed by hand is left alone. Null draft when
 * nothing is left to undo. Pure. */
export function undoDraft(profile, accepted) {
  const changes = [];
  for (const a of accepted) {
    if (readPath(profile, parsePath(a.path)) === a.new_value) changes.push({ path: a.path, new_value: a.old_value });
  }
  return { draft: changes.length ? applyChanges(profile, changes) : null, paths: changes.map((c) => c.path) };
}

/** After an undo: the accepted list empties, and its paths stay decided ("undone") for
 * the rest of the week. */
export function markUndone(storage, week) {
  const data = readWeekly(storage, week);
  for (const a of data.accepted) data.decided[a.path] = "undone";
  data.accepted = [];
  write(storage, data);
  return data;
}
