// S10: the versioned profile store. Local only, never sent anywhere (DESIGN section 2,
// 7): every save appends a full snapshot to an append-only history kept under one
// storage key, so past versions replay byte for byte and revert never loses a version.
//
// `storage` is anything shaped like Web Storage (getItem/setItem): the browser passes
// window.localStorage, tests pass the MemoryStorage below. No other browser API is
// touched here, so this module runs unchanged under Node's test runner.

import { validateProfile } from "./validate.js";
import { diffProfiles } from "./diff.js";
import { nowIso } from "./time.js";

export const STORAGE_KEY = "almanac.profile.store.v1";

/** A tiny in-memory stand-in for window.localStorage, for tests and non-browser use. */
export class MemoryStorage {
  constructor() {
    this._data = new Map();
  }

  getItem(key) {
    return this._data.has(key) ? this._data.get(key) : null;
  }

  setItem(key, value) {
    this._data.set(key, String(value));
  }
}

export class ProfileStore {
  /**
   * @param {object} opts
   * @param {{getItem: Function, setItem: Function}} opts.storage
   * @param {object} opts.schema - profile.schema.json, already parsed
   * @param {Function} [opts.seedDefault] - (nowIso) => default profile
   * @param {Function} [opts.now] - () => ISO timestamp string, injectable for tests
   */
  constructor({ storage, schema, seedDefault, now = nowIso }) {
    if (!storage) throw new Error("ProfileStore needs a storage adapter");
    if (!schema) throw new Error("ProfileStore needs profile.schema.json");
    this.storage = storage;
    this.schema = schema;
    this.seedDefault = seedDefault;
    this.now = now;
  }

  _read() {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.history) && data.history.length > 0) return data;
      return null;
    } catch {
      return null;
    }
  }

  _write(data) {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  /** Loads the store, seeding it with the default profile on first run. */
  _ensure() {
    const existing = this._read();
    if (existing) return existing;
    if (!this.seedDefault) throw new Error("no profile saved yet and no seedDefault provided");
    const profile = this.seedDefault(this.now());
    const data = { history: [{ version: profile.profile_version, timestamp: this.now(), profile }] };
    this._write(data);
    return data;
  }

  /** Version numbers newest first, with their timestamp; no profile bodies (cheap to list). */
  history() {
    return this._ensure()
      .history.map(({ version, timestamp }) => ({ version, timestamp }))
      .sort((a, b) => b.version - a.version);
  }

  /** The current (highest-version) profile, deep cloned so callers can edit it freely. */
  current() {
    const data = this._ensure();
    return structuredClone(data.history[data.history.length - 1].profile);
  }

  /** One past version's full profile snapshot. Throws if that version was never saved. */
  getVersion(version) {
    const entry = this._ensure().history.find((h) => h.version === version);
    if (!entry) throw new Error(`no such profile version: ${version}`);
    return structuredClone(entry.profile);
  }

  /**
   * Stamps profile_version and updated_at (never trusted from the caller: a draft
   * round-tripped from current() carries whatever those fields last held, which is not
   * this save's business), validates the result, and on success appends it as a new
   * version. Stamping happens before validation on purpose, so what is checked is
   * exactly what would be persisted. Returns {ok: true, profile} on success or
   * {ok: false, errors} on failure, writing nothing either way but on success.
   */
  save(profile) {
    const data = this._ensure();
    const nextVersion = data.history[data.history.length - 1].version + 1;
    const candidate = {
      ...structuredClone(profile),
      schema_version: 1,
      profile_version: nextVersion,
      updated_at: this.now(),
    };
    const errors = validateProfile(candidate, this.schema);
    if (errors.length) return { ok: false, errors };
    data.history.push({ version: nextVersion, timestamp: candidate.updated_at, profile: candidate });
    this._write(data);
    return { ok: true, profile: candidate };
  }

  /**
   * One-tap revert (DESIGN/brief: version history plus revert): re-saves a past
   * version's content as a new version. History is append only, so nothing is lost and
   * this itself shows up as an ordinary entry in the version list.
   */
  revert(version) {
    return this.save(this.getVersion(version));
  }

  /** A readable diff between any two saved versions, in either order. */
  diff(versionA, versionB) {
    return diffProfiles(this.getVersion(versionA), this.getVersion(versionB));
  }
}
