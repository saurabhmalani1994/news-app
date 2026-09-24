// S33: the Live tab (R21, R22). An event goes live in the cloud (S32, fetcher/events.py);
// the device only applies the owner's own pin and block overrides (DESIGN-v1.1 section
// 6: "the device only applies the owner's pins and blocks"), reachable from the Live
// panel header through the S24 sheet.
//
// Both live in profile.live_overrides, owner only: ai/gate.js's RESERVED_SEGMENT refuses
// every path under it, so no AI proposal can ever touch which event is live.
//
// pinned_event_id keeps one event live even past its own hype ranking or hold state, as
// long as the fetcher still emits it this run (a dissolved event, gone from the pool
// entirely, has nothing left to pin, and pinning falls back to whatever is naturally
// live). blocked_event_ids and blocked_labels keep an event off the tab for good: by id,
// so the same running story never returns once blocked, and by label (case-insensitive,
// trimmed), so a later, differently-clustered event under the same name is caught too. A
// block always wins over a pin.
export const LIVE_OVERRIDES_DEFAULTS = Object.freeze({
  pinned_event_id: null,
  blocked_event_ids: [],
  blocked_labels: [],
});

/** The profile's live_overrides, defaulted so every caller can read it without an
 * absent-field check (mirrors how passes.js reads profile.passes). */
export function overridesOf(profile) {
  const o = (profile && profile.live_overrides) || {};
  return {
    pinned_event_id: o.pinned_event_id ?? null,
    blocked_event_ids: o.blocked_event_ids || [],
    blocked_labels: o.blocked_labels || [],
  };
}

const normLabel = (s) => (s || "").trim().toLowerCase();

/** True when an event is blocked by its own id or by its label. */
export function isBlocked(event, overrides) {
  return overrides.blocked_event_ids.includes(event.id)
    || overrides.blocked_labels.some((l) => normLabel(l) === normLabel(event.label));
}

/**
 * The one event to show live right now, or null when the tab is absent. Blocked
 * events are dropped first, so a block always wins even over a pin. The pinned event
 * shows next, if present and not blocked, whatever its own live/hold_state say (a
 * pin from a past run whose event has since dissolved falls through). Otherwise the
 * event the pool itself marked live (at most one, R22's LIVE_SLOTS).
 */
export function currentLiveEvent(events, profile) {
  const overrides = overridesOf(profile);
  const eligible = (events || []).filter((e) => !isBlocked(e, overrides));
  if (overrides.pinned_event_id) {
    const pinned = eligible.find((e) => e.id === overrides.pinned_event_id);
    if (pinned) return pinned;
  }
  return eligible.find((e) => e.live) || null;
}

/** Pin: keep this event live regardless of its own live/hold_state, until unpinned or
 * it leaves the pool entirely. Pinning an already-blocked event does nothing (a block
 * always wins, so the pin would be silently overruled); pinning the same event twice
 * is also a no-op. Both return null, the same "nothing to do" convention
 * actions/mute-boost.js uses, so the caller never writes a no-op profile version. */
export function withEventPinned(profile, event) {
  const overrides = overridesOf(profile);
  if (!event || overrides.pinned_event_id === event.id || isBlocked(event, overrides)) return null;
  return { ...profile, live_overrides: { ...overrides, pinned_event_id: event.id } };
}

export function withEventUnpinned(profile) {
  const overrides = overridesOf(profile);
  if (!overrides.pinned_event_id) return null;
  return { ...profile, live_overrides: { ...overrides, pinned_event_id: null } };
}

/** Block: this event never goes live again, by id and by label, and clears a pin on
 * it (a blocked event pinned makes no sense). null when both are already blocked. */
export function withEventBlocked(profile, event) {
  if (!event) return null;
  const overrides = overridesOf(profile);
  const byId = overrides.blocked_event_ids.includes(event.id);
  const byLabel = overrides.blocked_labels.some((l) => normLabel(l) === normLabel(event.label));
  if (byId && byLabel) return null;
  return {
    ...profile,
    live_overrides: {
      pinned_event_id: overrides.pinned_event_id === event.id ? null : overrides.pinned_event_id,
      blocked_event_ids: byId ? overrides.blocked_event_ids : [...overrides.blocked_event_ids, event.id],
      blocked_labels: byLabel ? overrides.blocked_labels : [...overrides.blocked_labels, event.label],
    },
  };
}
