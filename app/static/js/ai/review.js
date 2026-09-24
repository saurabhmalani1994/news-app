// S19: the two steps around the gate. submitProposal runs the gate and ledgers every
// rejection; an accepted proposal comes back as a pending review item and changes
// nothing. applyApprovedProposal is what the owner's approval (a later UI slice) calls:
// it re-gates the item against the profile as it is now, then saves through
// ProfileStore, so the edit becomes exactly one new profile version and can be reverted
// like any other. No network, no UI.

import { gateProposal, applyChanges, REASONS } from "./gate.js";

/**
 * Gate a proposal. Rejections are recorded in `ledger`.
 * Returns the gate's verdict unchanged: {decision: "review", review} or
 * {decision: "reject", reason, detail, path}.
 */
export function submitProposal(profile, proposal, { schemas, ledger }) {
  const verdict = gateProposal(profile, proposal, schemas);
  if (verdict.decision === "reject") ledger.record(proposal, verdict);
  return verdict;
}

/**
 * Save an owner-approved review item through `store`. The item is gated again first,
 * against store.current(): if the profile moved since the item was staged, its old
 * values no longer match and it is rejected (stale_old_value) and ledgered rather than
 * applied over the owner's newer edit.
 *
 * Returns {ok: true, profile, version, previous_version} or {ok: false, reason, detail}.
 */
export function applyApprovedProposal(store, item, { schemas, ledger }) {
  const current = store.current();
  const verdict = gateProposal(current, item.proposal, schemas);
  if (verdict.decision === "reject") {
    ledger.record(item.proposal, verdict);
    return { ok: false, reason: verdict.reason, detail: verdict.detail };
  }
  const saved = store.save(applyChanges(current, item.proposal.changes));
  if (!saved.ok) {
    const failure = { decision: "reject", reason: REASONS.INVALID_RESULT, detail: saved.errors.join("; "), path: null };
    ledger.record(item.proposal, failure);
    return { ok: false, reason: failure.reason, detail: failure.detail };
  }
  return {
    ok: true,
    profile: saved.profile,
    version: saved.profile.profile_version,
    previous_version: current.profile_version,
  };
}
