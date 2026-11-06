/** @file scripts/lib/daemon-rebuild/smoke-classify/load-shaped.mjs — the load-shaped classifier: a failed smoke
 * row explained by host load (timeout on the gate's clock, lock contention, external transient noise), plus the
 * same-run load differential's knobs and cached-rejection retry derivation. Additional budget/kill/throttle
 * forms require measured host overload; existing timeout, contention and transient classifications remain.
 */

import { loadavg, cpus } from 'node:os';
import {
  SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV, DEFAULT_ENV_TIMEOUT_MIN_ELAPSED_MS, isEnvTimeoutRow,
  TRANSIENT_FAILURE_PATTERNS, MIN_OWN_CAP_MS,
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
/** Our own shared gh semaphore refusing: another caller's slot, never the tree under test. Anchored on the exact
 *  refusal text, and applied per failure segment (see {@link isGhThrottleOnlyDetail}). */
const GH_THROTTLE_SEGMENT = /^(?:dispatch dry-run failed \(\d+\/\d+\): )?(?:[\w-]+(?: PR #\d+)?: )?gh-throttle: throttled — no gh slot within [\d.]+s(?: \(class=[\w-]+\))?(?: — (?:[\w-]+ (?:\d+ms|[\d.]+s|unknown)(?:, )?)+)?$/;
const TIMINGS = '(?: — (?:[\\w-]+ (?:\\d+ms|[\\d.]+s|unknown)(?:, )?)+)?';
const GH_THROTTLE_TAIL = new RegExp(`^retry next tick${TIMINGS}$`);

/** PURE: the WHOLE detail is gh-throttle refusals (each `; `-joined segment fully anchored, optional "retry next
 *  tick" tail). Any other text — a code failure, a newline — makes it NOT throttle-only. */
function isGhThrottleOnlyDetail(detail) {
  if (/[\r\n]/.test(detail)) return false;
  const segs = detail.split('; ');
  return segs.some((seg) => GH_THROTTLE_SEGMENT.test(seg))
    && segs.every((seg) => GH_THROTTLE_SEGMENT.test(seg) || GH_THROTTLE_TAIL.test(seg));
}

const BUDGET_SKIP_TEXT = 'skipped: rebuild smoke budget exhausted \\(\\d+ms left\\)';
// `<label> failed: ` (every check's own failure template) or `threw: ` (the gate wrapping an unguarded runChild).
const BUDGET_SKIP = new RegExp(`^(?:(?:[^:\\r\\n]+ failed|threw): )?${BUDGET_SKIP_TEXT}$(?![\\s\\S])`);
// reconcile-dry-run aggregates per repo: `reconcile-pass dry-run failed for N/M repo(s): <slug>: <skip>; <slug>: <skip>`.
const RECONCILE_BUDGET_SKIP_HEAD = /^reconcile-pass dry-run failed for \d+\/\d+ repo\(s\): /;
const RECONCILE_BUDGET_SKIP_SEG = new RegExp(`^[^:\\s;]+: ${BUDGET_SKIP_TEXT}$`);

/** PURE: the WHOLE reconcile detail is per-repo budget skips — one real failure among them keeps it code. */
function isReconcileBudgetSkipDetail(detail) {
  if (/[\r\n]/.test(detail) || !RECONCILE_BUDGET_SKIP_HEAD.test(detail)) return false;
  const segs = detail.replace(RECONCILE_BUDGET_SKIP_HEAD, '').split('; ');
  return segs.length > 0 && segs.every((seg) => RECONCILE_BUDGET_SKIP_SEG.test(seg));
}
const CHILD_BUDGET_SKIP = /^child failed: skipped: rebuild smoke budget exhausted \(\d+ms left\)$(?![\s\S])/;
const BOUNDED_KILL = /^[^:\r\n]+ failed: timed out after (\d+)ms \(process group killed\)$(?![\s\S])/;
const EXTENDED_GH_THROTTLE_SEGMENT = new RegExp(GH_THROTTLE_SEGMENT.source.replace(
  'gh-throttle:', '(?:reconcile failed: reconcile read failed \\(exit \\d+\\): )?gh-throttle:',
));

/** Evidence precedence is deliberate: malformed explicit evidence never falls through to the live host. */
export function hostOverloaded(row, env = {}, probe = () => ({ load1: loadavg()[0], cores: cpus().length })) {
  try {
    let evidence;
    if (row?.hostLoad !== undefined) evidence = row.hostLoad;
    else if (env?.WE_SMOKE_HOST_LOAD1 !== undefined || env?.WE_SMOKE_HOST_CORES !== undefined) {
      const number = value => value == null || String(value).trim() === '' ? NaN : Number(value);
      evidence = { load1: number(env.WE_SMOKE_HOST_LOAD1), cores: number(env.WE_SMOKE_HOST_CORES) };
    } else evidence = probe();
    const rawRatio = env?.WE_SMOKE_LOAD_SHAPED_MIN_RATIO;
    const ratio = rawRatio === undefined ? 2 : Number(rawRatio);
    return Number.isFinite(evidence?.load1) && Number.isFinite(evidence?.cores) && evidence.cores >= 1
      && Number.isFinite(ratio) && ratio > 0 && evidence.load1 / evidence.cores >= ratio;
  } catch {
    return false;
  }
}

function isBudgetBootRow(row, detail, minElapsedMs) {
  if (row.name !== 'daemon-entries-boot') return false;
  if (Array.isArray(row.entries)) {
    if (!row.entries.length || row.entries.some(entry => !entry || typeof entry.ok !== 'boolean')) return false;
    const failures = row.entries.filter(entry => !entry.ok);
    // Every recorded attempt must be a budget skip: an earlier real crash must keep the row code-shaped.
    const allSkipped = entry => Array.isArray(entry.attempts) && entry.attempts.length > 0
      && entry.attempts.every(a => a && a.ok === false && CHILD_BUDGET_SKIP.test(a.kind));
    return failures.length > 0 && failures.every(entry => (entry.attempts === undefined
      ? CHILD_BUDGET_SKIP.test(entry.kind) : allSkipped(entry))
      || isEnvTimeoutRow({ name: row.name, ok: false, entries: [entry] }, { minElapsedMs }));
  }
  const [header, ...lines] = detail.split('\n');
  const counts = /^(\d+)\/\1 daemon entries failed to boot:$/.exec(header);
  return !!counts && Number(counts[1]) > 0 && lines.length === Number(counts[1])
    && lines.every(line => /^- [^\r\n]+: child failed: skipped: rebuild smoke budget exhausted \(\d+ms left\)$(?![\s\S])/.test(line));
}

function isExtendedGhThrottleOnlyDetail(detail) {
  const segments = detail.split(/\n?; /);
  return segments.every(segment => !/[\r\n]/.test(segment))
    && segments.some(segment => EXTENDED_GH_THROTTLE_SEGMENT.test(segment))
    && segments.every(segment => EXTENDED_GH_THROTTLE_SEGMENT.test(segment) || GH_THROTTLE_TAIL.test(segment));
}

export function loadDifferentialEnabled(env) {
  return String(env?.[SMOKE_LOAD_DIFFERENTIAL_ENV] ?? '').trim() !== '0';
}

export function envLoadRetryDelayMs(env, attempts) {
  const base = Number(env?.[ENV_LOAD_RETRY_BASE_ENV]) > 0 ? Number(env[ENV_LOAD_RETRY_BASE_ENV]) : DEFAULT_ENV_LOAD_RETRY_BASE_MS;
  const max = Number(env?.[ENV_LOAD_RETRY_MAX_ENV]) > 0 ? Number(env[ENV_LOAD_RETRY_MAX_ENV]) : DEFAULT_ENV_LOAD_RETRY_MAX_MS;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
}

/** Is this failed smoke row load-shaped? New forms need host evidence (the probe can be injected). */
export function isLoadShapedRow(row, env = {}, probe) {
  if (!row || row.ok) return false;
  const minElapsedMs = Number(env?.[SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV]) > 0
    ? Number(env[SMOKE_ENV_TIMEOUT_MIN_ELAPSED_MS_ENV]) : DEFAULT_ENV_TIMEOUT_MIN_ELAPSED_MS;
  if (isEnvTimeoutRow(row, { minElapsedMs })) return true;
  const detail = String(row.detail ?? '');
  if (LOAD_CONTENTION_SIGNATURES.some((re) => re.test(detail))) return true;
  // Our slot refusal is load contention even for code checks such as dispatch-dry-run.
  if (isGhThrottleOnlyDetail(detail)) return true;
  if ((BUDGET_SKIP.test(detail) || isReconcileBudgetSkipDetail(detail) || isBudgetBootRow(row, detail, minElapsedMs)
    || isExtendedGhThrottleOnlyDetail(detail))
    && hostOverloaded(row, env, probe)) return true;
  return row.mayBeTransient !== false && TRANSIENT_FAILURE_PATTERNS.some((re) => re.test(detail));
}

/** Derive a retry without mutating persisted rejection/hold state. */
export function cachedRejectionLoadRetry(state, env, { now = Date.now(), probe } = {}) {
  if (!state?.rejected || Number.isFinite(Date.parse(state.rejected.retryAt || ''))
    || state.rejected.harnessBroken || !Array.isArray(state.held?.details) || !state.held.details.length) return null;
  // Held details are gate-recorded: a bounded kill's elapsed time is at least its own cap.
  const rowOf = detail => {
    const cap = Number(BOUNDED_KILL.exec(String(detail.detail ?? ''))?.[1]);
    return { name: detail.name, ok: false, detail: detail.detail, ...(cap >= MIN_OWN_CAP_MS ? { ms: cap } : {}) };
  };
  if (!state.held.details.every(detail => detail && isLoadShapedRow(rowOf(detail), env, probe))) return null;
  const attempts = (state.rejected.attempts || 0) + 1;
  return { envLoad: true, attempts, retryAt: new Date(now + envLoadRetryDelayMs(env, attempts)).toISOString() };
}

// TODO: Wire cachedRejectionLoadRetry into the still-rejected short-circuit in
// scripts/lib/daemon-rebuild/prepare.mjs (Step 4), after PR #6360 (same region).
