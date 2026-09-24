// S10: the one clock both default-profile.js and store.js use, so "now" always comes
// out in the second-precision shape profile.schema.json's utc_timestamp requires
// (matches contract's utc_timestamp convention). Date#toISOString() includes
// milliseconds, which the schema's pattern does not allow, so it is truncated here
// rather than at every call site.
export function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
