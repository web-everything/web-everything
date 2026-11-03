/** @file scripts/lib/daemon-rebuild/smoke-classify/infra-degraded.mjs — R508 part 2: classify each failed smoke step as
 * `infra` (timeouts, gh 5xx, gh-throttle no-slot, lane-acquire timeouts) or `code` (the default). A smoke whose ONLY
 * failures are infra, while every code-path step actually passed, is retried after a backoff and, on repeated infra-only
 * failure, adopted with a `smoke-infra-degraded` event. Any code failure (or an unproven/skipped code step) still blocks.
 * WHY: the rebuild smoke's reconcile dry-run hit the same GitHub 504 the pending fix cures, so the fix could never be adopted.
 */

/** Infra signatures; anything else stays `code`. */
export const INFRA_PATTERNS = Object.freeze([
  /\btimed out\b/i, /\btimeout\b/i, /\bETIMEDOUT\b/, /\bHTTP\s*5\d\d\b/i,
  /gh-throttle/i, /no slot/i, /lane[- ]acquire[^\n]{0,60}(?:timed out|timeout)/i,
]);
/** Repeated infra-only failures before the build is adopted as degraded (env WE_SMOKE_INFRA_DEGRADED_ATTEMPTS). */
export const DEFAULT_INFRA_DEGRADED_ATTEMPTS = 3;

/** Same backoff as smoke.mjs#rejectRetryDelayMs (re-stated: importing smoke.mjs from here would close an import cycle). */
function backoffMs(env, attempts) {
  const base = Number(env?.WE_DAEMON_REJECT_RETRY_BASE_MS) || 5 * 60_000;
  const max = Number(env?.WE_DAEMON_REJECT_RETRY_MAX_MS) || 60 * 60_000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
}

/** PURE. A step is infra only if it is a check that runs `gh`/host machinery (`mayBeTransient`) AND its detail matches. */
export function classifySmokeStep(row) {
  if (!row || row.ok) return 'code';
  if (row.mayBeTransient !== true) return 'code';
  return INFRA_PATTERNS.some((p) => p.test(String(row.detail ?? ''))) ? 'infra' : 'code';
}

/** PURE. True only when there is at least one failure, every failure is infra, and every code-path step
 *  (`mayBeTransient === false`) ran and passed (not skipped). */
export function infraOnlyFailure(smokeResult) {
  const rows = smokeResult?.smoke?.results || [];
  const failed = rows.filter((r) => !r.ok);
  if (!failed.length || !failed.every((r) => classifySmokeStep(r) === 'infra')) return false;
  return rows.filter((r) => r.mayBeTransient === false).every((r) => r.ok && !r.skipReason);
}

/** PURE. block (code failure) | retry (infra-only, backoff) | adopt (repeated infra-only). `next` is the counter to store. */
export function infraDegradedDecision({ smokeResult, prior, inputsKey, nowMs, env = process.env }) {
  if (!infraOnlyFailure(smokeResult)) return { action: 'block', next: null };
  const need = Number(env?.WE_SMOKE_INFRA_DEGRADED_ATTEMPTS) > 0 ? Number(env.WE_SMOKE_INFRA_DEGRADED_ATTEMPTS) : DEFAULT_INFRA_DEGRADED_ATTEMPTS;
  const failed = (smokeResult.smoke.results || []).filter((r) => !r.ok).map((r) => r.name);
  const same = prior && prior.inputsKey === inputsKey;
  const attempts = same ? prior.attempts : 0;
  if (same && Number.isFinite(prior.retryAt) && nowMs < prior.retryAt) return { action: 'retry', next: { inputsKey, attempts, retryAt: prior.retryAt }, failed };
  const n = attempts + 1;
  if (n >= need) return { action: 'adopt', attempts: n, failed, next: null };
  return { action: 'retry', next: { inputsKey, attempts: n, retryAt: nowMs + backoffMs(env, n) }, failed };
}
