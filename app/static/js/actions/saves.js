// S24: Save, a snapshot for S26's Saved screen: id, title, source, url, image, time
// saved and whether the reader can open it offline (has_body), never the full body
// (S25's reader cache already owns that, keyed the same way). `store` is
// {get(id), put(record), delete(id)}, actions/store.js in the browser.

export function buildSaveSnapshot(id, attributes, now) {
  const time = typeof now === "function" ? now() : now;
  return {
    id,
    title: attributes.title || "",
    source: attributes.source_name || attributes.source || "",
    url: attributes.url || "",
    image: attributes.image || null,
    time,
    has_body: Boolean(attributes.has_body),
  };
}

/** Toggles the save: already saved removes it, otherwise adds it. Returns
 * {action: "added" | "removed", record, previous}. */
export async function toggleSave(store, id, attributes, now) {
  const previous = (await store.get(id)) || null;
  if (previous) {
    await store.delete(id);
    return { action: "removed", record: null, previous };
  }
  const record = buildSaveSnapshot(id, attributes, now);
  await store.put(record);
  return { action: "added", record, previous: null };
}

/** Reverts one toggleSave call. */
export async function undoSave(store, id, action, previous) {
  if (action === "added") await store.delete(id);
  else if (previous) await store.put(previous);
}
