/**
 * Bounded exponential backoff for dispatch failures (items 95 + 96).
 *
 * A failed prepare/build dispatch used to either hold the card forever (prepare: `retry:false, held:true`) or be
 * re-dispatched every tick with no pause (build). Both now share this schedule: delay = base * 2^(attempt-1),
 * capped at max, and after `maxAttempts` the card stays held until an operator re-arms it.
 * Settings (env, all optional): WE_DISPATCH_RETRY_BASE_MS (5 min), WE_DISPATCH_RETRY_MAX_MS (60 min),
 * WE_DISPATCH_RETRY_MAX_ATTEMPTS (6).
 */
export const BACKOFF_DEFAULTS = Object.freeze({ baseMs: 5 * 60_000, maxMs: 60 * 60_000, maxAttempts: 6 });

export function readBackoffSettings(env = process.env) {
  const pos = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
  return {
    baseMs: pos(env.WE_DISPATCH_RETRY_BASE_MS, BACKOFF_DEFAULTS.baseMs),
    maxMs: pos(env.WE_DISPATCH_RETRY_MAX_MS, BACKOFF_DEFAULTS.maxMs),
    maxAttempts: pos(env.WE_DISPATCH_RETRY_MAX_ATTEMPTS, BACKOFF_DEFAULTS.maxAttempts),
  };
}

/** Delay before retry after the `attempt`-th failure (1-based). */
export function backoffDelayMs(attempt, settings = BACKOFF_DEFAULTS) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(settings.maxMs, settings.baseMs * 2 ** Math.min(n - 1, 30));
}

/** `{retryAfter, exhausted}` for a card that has now failed `attempts` times. */
export function backoffVerdict({ attempts, now = Date.now(), settings = BACKOFF_DEFAULTS }) {
  if (attempts >= settings.maxAttempts) return { retryAfter: null, exhausted: true };
  return { retryAfter: new Date(now + backoffDelayMs(attempts, settings)).toISOString(), exhausted: false };
}

/** Reason codes: why a dispatch failed, in a form a card/status page can group on. `null` = not a known transient. */
const RULES = [
  ['launch-not-confirmed', /dispatch launch not confirmed|launch not confirmed/i],
  ['checkout-behind-origin', /dispatching checkout is \d+ commit|managed clone is \d+ commit|checkout-behind-origin/i],
  ['launch-spawn-failed', /launch-spawn-failed/i],
  ['launch-died', /launch-died/i],
  ['dispatch-command-failed', /^Command failed\b/i],
];
export const BACKOFF_REASON_CODES = Object.freeze(RULES.map(([code]) => code));
/**
 * builder-starved (2026-10-07) — reason codes that describe the DISPATCHING CLONE, not the card: every card the
 * daemon tried in that window was refused the same way. Charging them to the card is wrong twice over: the card
 * burns its backoff budget on a condition it cannot cause (4701 went to `exhausted` on seven stale-clone refusals
 * overnight), and the daemon keeps re-picking it, so it is dispatched again and again while the clone lags. A
 * clone-wide failure is never charged to the card and never holds it; the clone's own self-sync clears the cause.
 */
export const CLONE_WIDE_REASON_CODES = Object.freeze(['checkout-behind-origin']);
export const isCloneWideReasonCode = (code) => CLONE_WIDE_REASON_CODES.includes(code);
export function reasonCodeOf(text) {
  const s = String(text ?? '');
  for (const [code, re] of RULES) if (re.test(s)) return code;
  return null;
}

/** The one place that reads a reason code off failure evidence. Classification, the persisted `reasonCode` and the
 * re-arm all call this, so they can never disagree when evidence carries both `reason` and `error` text. */
export function evidenceReasonCode(evidence) {
  // `reason` is the daemon's own account of the failure; `error` is raw agent/child output that may merely QUOTE a
  // known failure's text. `error` is only consulted when there is no `reason` at all.
  return reasonCodeOf(evidence?.reason ?? evidence?.error);
}
