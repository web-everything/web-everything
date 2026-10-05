/** @file scripts/lib/daemon-rebuild/smoke-classify/load-shaped.mjs — the load-shaped classifier: a failed smoke
 * row explained by host load (timeout on the gate's clock, lock contention, external transient noise), plus the
 * same-run load differential's knobs. Split out of daemon-rebuild.mjs (move-only).
 */

import {
  SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV, DEFAULT_ENV_TIMEOUT_MIN_ELAPSED_MS, isEnvTimeoutRow,
  TRANSIENT_FAILURE_PATTERNS,
} from '../../daemon-live-smoke.mjs';

// ── LOAD-shaped smoke failures: blamed on an overlay only through a same-run differential (live 2026-10-04) ──
// wev-control, 16:02Z and 16:26Z: candidate A (main + PR #3903) failed `lane-acquire-release` with lane-pool's own
// "(lock contention)" refusal and `dispatch-dry-run` with "timed out after 45000ms". Plain main, smoked minutes
// later once the contention had cleared, passed — so the healthy overlay was dropped, twice. Plain main fails the
// same checks under the same load. A failure whose every row is load-shaped (ran out of time on the gate's own
// clock, another caller's lock, or external transient noise) is therefore NOT evidence against an overlay by
// itself: after plain main passes, A is smoked AGAIN in the same run. A passes ⇒ adopt A (overlay kept). A
// reproduces a CODE-shaped failure on a check it failed before ⇒ genuine, drop as before. Anything else ⇒
// environment (`smoke-env-load`): never drop, retry A with backoff. No laundering: an env-load verdict never
// ADOPTS A — only a clean A pass does.

/** Knob: `0` turns the load differential off (back to one plain-main comparison). Default on. */
export const SMOKE_LOAD_DIFFERENTIAL_ENV = 'WE_DAEMON_SMOKE_LOAD_DIFFERENTIAL';
/** Knobs: backoff before an env-load-held candidate is re-smoked — base * 2^(attempts-1), capped. */
export const ENV_LOAD_RETRY_BASE_ENV = 'WE_DAEMON_ENV_LOAD_RETRY_BASE_MS';
export const ENV_LOAD_RETRY_MAX_ENV = 'WE_DAEMON_ENV_LOAD_RETRY_MAX_MS';
export const DEFAULT_ENV_LOAD_RETRY_BASE_MS = 5 * 60_000;
export const DEFAULT_ENV_LOAD_RETRY_MAX_MS = 60 * 60_000;
/** Another caller's lane-pool lock, never the tree under test. */
export const LOAD_CONTENTION_SIGNATURES = Object.freeze([
  /\(lock contention\)/,
  /gave up waiting for the shared acquirability-scan lock/,
]);

export function loadDifferentialEnabled(env) {
  return String(env?.[SMOKE_LOAD_DIFFERENTIAL_ENV] ?? '').trim() !== '0';
}

export function envLoadRetryDelayMs(env, attempts) {
  const base = Number(env?.[ENV_LOAD_RETRY_BASE_ENV]) > 0 ? Number(env[ENV_LOAD_RETRY_BASE_ENV]) : DEFAULT_ENV_LOAD_RETRY_BASE_MS;
  const max = Number(env?.[ENV_LOAD_RETRY_MAX_ENV]) > 0 ? Number(env[ENV_LOAD_RETRY_MAX_ENV]) : DEFAULT_ENV_LOAD_RETRY_MAX_MS;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
}

/** PURE: is this failed smoke row explained by host load (time-out on the gate's clock, lock contention, or
 *  external transient noise from a check allowed to be transient)? */
export function isLoadShapedRow(row, env = {}) {
  if (!row || row.ok) return false;
  const minElapsedMs = Number(env?.[SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV]) > 0
    ? Number(env[SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV]) : DEFAULT_ENV_TIMEOUT_MIN_ELAPSED_MS;
  if (isEnvTimeoutRow(row, { minElapsedMs })) return true;
  const detail = String(row.detail ?? '');
  if (LOAD_CONTENTION_SIGNATURES.some((re) => re.test(detail))) return true;
  return row.mayBeTransient !== false && TRANSIENT_FAILURE_PATTERNS.some((re) => re.test(detail));
}
