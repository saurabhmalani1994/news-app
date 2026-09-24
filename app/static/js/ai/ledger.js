// S19: the rejection ledger. Every proposal the gate rejects is recorded here with its
// named reason (DESIGN-v1.1 section 5: "every rejection is counted"). It lives on the
// device in the same storage as the profile (ProfileStore's STORAGE_KEY sits next to
// LEDGER_KEY), never leaves it, and never touches the network.
//
// The entry list is capped at LEDGER_CAP, oldest dropped first, so a model stuck in a
// loop cannot fill local storage. The totals are never trimmed: `total` and `by_reason`
// count every rejection since the ledger began, including entries already evicted.
//
// Entries keep only the proposal id, target paths, reason and a short detail. The
// rationale and values are not stored: they are model output shaped by untrusted feed
// text, and the reason is what the owner needs to see.

import { nowIso } from "../profile/time.js";

export const LEDGER_KEY = "almanac.ai.rejections.v1";
export const LEDGER_CAP = 200;

const MAX_ID = 64;
const MAX_PATHS_KEPT = 20;
const MAX_PATH = 200;
const MAX_DETAIL = 300;

function emptyLedger() {
  return { total: 0, by_reason: {}, entries: [] };
}

function clip(value, max) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

export class RejectionLedger {
  /**
   * @param {object} opts
   * @param {{getItem: Function, setItem: Function}} opts.storage - same adapter as ProfileStore
   * @param {Function} [opts.now] - () => ISO timestamp, injectable for tests
   * @param {number} [opts.cap] - entries kept, default LEDGER_CAP
   */
  constructor({ storage, now = nowIso, cap = LEDGER_CAP }) {
    if (!storage) throw new Error("RejectionLedger needs a storage adapter");
    this.storage = storage;
    this.now = now;
    this.cap = cap;
  }

  _read() {
    const raw = this.storage.getItem(LEDGER_KEY);
    if (!raw) return emptyLedger();
    try {
      const data = JSON.parse(raw);
      if (data && Number.isInteger(data.total) && Array.isArray(data.entries) && data.by_reason) return data;
    } catch {
      // A corrupt ledger starts over rather than blocking the gate.
    }
    return emptyLedger();
  }

  /** Records one rejected proposal. `verdict` is the gate's reject result. */
  record(proposal, verdict) {
    const data = this._read();
    const changes = proposal && Array.isArray(proposal.changes) ? proposal.changes : [];
    const entry = {
      at: this.now(),
      proposal_id: clip(proposal && proposal.id, MAX_ID),
      reason: verdict.reason,
      path: clip(verdict.path, MAX_PATH),
      detail: clip(verdict.detail, MAX_DETAIL),
      paths: changes.slice(0, MAX_PATHS_KEPT).map((c) => clip(c && c.path, MAX_PATH)),
    };
    data.entries.push(entry);
    if (data.entries.length > this.cap) data.entries.splice(0, data.entries.length - this.cap);
    data.total += 1;
    data.by_reason[verdict.reason] = (data.by_reason[verdict.reason] || 0) + 1;
    this.storage.setItem(LEDGER_KEY, JSON.stringify(data));
    return entry;
  }

  /** Kept entries, newest first. */
  entries() {
    return this._read().entries.slice().reverse();
  }

  /** Lifetime counts, including entries the cap has already evicted. */
  totals() {
    const { total, by_reason } = this._read();
    return { total, by_reason: { ...by_reason } };
  }
}
