// J1: the phone's one call to Jev, through its own site's /api/jev (functions/api/jev.js).
// Same origin, the Access cookie rides along, no key on the device. The answers are
// cleaned again here against the questions that were asked (js/jev/contract.js), so the
// page never trusts the network more than the function does.

import { normalizeAnswers } from "./contract.js";

export const TIMEOUT_MS = 12_000;

/** Why a call failed, in words the page can show as they are. */
export const FAILURES = Object.freeze({
  offline: "You're offline. Jev needs a connection.",
  not_set_up: "Jev isn't set up on this site yet.",
  signed_out: "Your sign-in has expired. Reload the page to sign in again.",
  no_answer: "Jev didn't answer. Try again in a moment.",
});

export class JevError extends Error {
  constructor(kind) {
    super(FAILURES[kind] || FAILURES.no_answer);
    this.kind = kind;
  }
}

/** {answers, missing, model} for `questions` about `state`, or throws a JevError. */
export async function askJev(state, questions, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, online = globalThis.navigator?.onLine } = {}) {
  if (online === false) throw new JevError("offline");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl("/api/jev", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, state, questions }),
      signal: controller.signal,
    });
  } catch {
    throw new JevError("no_answer");
  } finally {
    clearTimeout(timer);
  }
  // Access answers a lapsed session with a redirect to its login page.
  if (response.redirected || response.status === 401 || response.status === 403) throw new JevError("signed_out");
  if (response.status === 503) throw new JevError("not_set_up");
  if (!response.ok) throw new JevError("no_answer");
  let data;
  try {
    data = await response.json();
  } catch {
    throw new JevError("signed_out");
  }
  const { answers, missing } = normalizeAnswers(questions, data);
  return { answers, missing, model: typeof data?.model === "string" ? data.model : "" };
}
