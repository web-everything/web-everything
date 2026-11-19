/**
 * Shared retry timing and caps. No recovery IO or admission policy: the watchdog
 * uses these through branch-sync and must remain independent of driver decisions.
 */

/** Backoff base: the wait after the FIRST failure before the first retry (30s). */
export const DEFAULT_BASE_MS = 30_000;
/** Backoff multiplier per attempt (doubling). */
export const DEFAULT_FACTOR = 2;
/** Backoff ceiling: no single wait exceeds 30 min however many attempts have failed. */
export const DEFAULT_CAP_MS = 30 * 60_000;
/** Attempt cap: after this many FAILED open attempts, stop auto-retrying and SURFACE to the operator. */
export const DEFAULT_MAX_ATTEMPTS = 6;
/** Refusal cap: after this many consecutive refusals (~1h at the interval above), SURFACE to the operator. Its
 *  own budget, separate from {@link DEFAULT_MAX_ATTEMPTS} — see {@link markRefusedAttempt}. */
export const DEFAULT_MAX_REFUSALS = 12;

/** ms since epoch for an ISO string (or a number passed through), NaN-safe → 0. */
export function toMs(iso) {
  if (iso == null) return 0;
  if (typeof iso === 'number') return Number.isFinite(iso) ? iso : 0;
  const t = Date.parse(String(iso));
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The backoff wait (ms) BEFORE the retry that follows a given failed attempt. `attempt` is 1-based (1 = the
 * initial failed open): wait = min(cap, base · factor^(attempt-1)). Deterministic (no jitter) so the retry
 * schedule is unit-testable; the conveyor tick's own cadence supplies the real-world spread.
 * @param {number} attempt  the 1-based number of the attempt that just failed
 * @returns {number} ms to wait before the next retry
 */
export function backoffMs(attempt, { baseMs = DEFAULT_BASE_MS, factor = DEFAULT_FACTOR, capMs = DEFAULT_CAP_MS } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const raw = baseMs * Math.pow(factor, n - 1);
  return Math.min(capMs, Math.max(0, raw));
}

/**
 * The retry decision for ONE entry, given the clock. Pure state machine:
 *   • `attempt >= maxAttempts` → **surface** — the attempt cap is hit; STOP auto-retrying and hand to the
 *     operator (never loop a doomed resume forever).
 *   • `refusals >= maxRefusals` → **surface** — a guard kept refusing the resume; same hand-off, own budget.
 *   • `now >= nextRetryAt`     → **retry** — the backoff has elapsed; attempt a resume-open this pass.
 *   • otherwise                → **wait**  — still backing off; `waitMs` is how long remains.
 * @param {{attempt?:number, refusals?:number, nextRetryAt?:string}} entry
 * @param {{now?:number, maxAttempts?:number, maxRefusals?:number}} o
 * @returns {{action:'surface'|'retry'|'wait', reason?:string, waitMs?:number}}
 */
export function retryDecision(entry, { now = Date.now(), maxAttempts = DEFAULT_MAX_ATTEMPTS, maxRefusals = DEFAULT_MAX_REFUSALS } = {}) {
  const attempt = Math.max(1, Math.floor(Number(entry?.attempt) || 1));
  if (attempt >= maxAttempts) return { action: 'surface', reason: 'attempt-cap' };
  if (Math.floor(Number(entry?.refusals) || 0) >= maxRefusals) return { action: 'surface', reason: 'refusal-cap' };
  const nowMs = toMs(now) || Number(now) || Date.now();
  const dueMs = toMs(entry?.nextRetryAt);
  if (nowMs >= dueMs) return { action: 'retry' };
  return { action: 'wait', waitMs: dueMs - nowMs };
}

