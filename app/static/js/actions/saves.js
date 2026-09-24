// S24: Save, a snapshot for S26's Saved screen: id, title, source, url, image, time
// saved and whether the reader can open it offline (has_body), never the full body
// (S25's reader cache already owns that, keyed the same way). `store` is
// {get(id), put(record), delete(id)}, actions/store.js in the browser.
//
// S26: `article_id` is the id the reader opens (app/build.py body_id, S25's data-body):
// the story's own id for an unclustered story, the cluster's lead article otherwise
// (actions/context.js storyAttributes already computes this into `attributes.article_id`
// for every save call site). The pool that would answer "which article fronted this
// story" rotates out after 72h, long before a save does, so it has to be kept here at
// save time, not looked up later. Falls back to `id` itself, correct for the common
// unclustered case even when a caller forgot to pass it.

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
    article_id: attributes.article_id || id,
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
