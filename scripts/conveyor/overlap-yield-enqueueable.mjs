/**
 * Pass-local overlap-yield eligibility. Pure: no reads, fetches or verdict mutations.
 * A known held candidate cannot be a yield target; targets must also be
 * landable now unless that policy is disabled. Merge verdicts (including those enqueued this pass)
 * remain targets until buildOverlapRows excludes their merged keys.
 */
import { overlapRowKey } from './land-overlap-yield.mjs';

const ENV_KEY = 'WE_DRAIN_OVERLAP_YIELD_ONLY_TO_ENQUEUEABLE';
const ENABLE_FLAG = '--overlap-yield-only-to-enqueueable';
const DISABLE_FLAG = '--no-overlap-yield-only-to-enqueueable';
const LANDABLE_ENV_KEY = 'WE_DRAIN_OVERLAP_YIELD_REQUIRES_LANDABLE';
const LANDABLE_ENABLE_FLAG = '--overlap-yield-requires-landable';
const LANDABLE_DISABLE_FLAG = '--no-overlap-yield-requires-landable';

/** drain.overlapYieldOnlyToEnqueueable: CLI > env > default ON.
 * Env accepts 1/0, on/off, true/false. Conflicting flags and invalid env values
 * are usage errors, matching the overlap-yield overrides' handling.
 * Inputs are supplied by the drain, keeping resolution deterministic in tests.
 */
export function resolveOverlapYieldOnlyToEnqueueableSetting({ argv = [], env = {} } = {}) {
  const on = argv.includes(ENABLE_FLAG);
  const off = argv.includes(DISABLE_FLAG);
  if (on && off) throw new Error(`usage: ${ENABLE_FLAG} and ${DISABLE_FLAG} are mutually exclusive`);
  if (on || off) return { value: on, source: 'cli' };
  if (env[ENV_KEY] !== undefined) {
    const raw = String(env[ENV_KEY]).trim().toLowerCase();
    if (['1', 'on', 'true'].includes(raw)) return { value: true, source: 'env' };
    if (['0', 'off', 'false'].includes(raw)) return { value: false, source: 'env' };
    throw new Error(`usage: ${ENV_KEY} must be 1/0, on/off or true/false`);
  }
  return { value: true, source: 'default' };
}

/** The drain emits this once per pass, even when the setting is unchanged. */
export function formatOverlapYieldOnlyToEnqueueableSetting({ value, source }) {
  return `policy · drain.overlapYieldOnlyToEnqueueable=${value ? 'on' : 'off'} (source: ${source})`;
}

/** drain.overlapYieldRequiresLandable: CLI > env > default ON.
 * Env accepts 1/0, on/off, true/false. Conflicting flags and invalid env values
 * are usage errors, matching the overlap-yield overrides' handling.
 * Inputs are supplied by the drain, keeping resolution deterministic in tests.
 */
export function resolveOverlapYieldRequiresLandableSetting({ argv = [], env = {} } = {}) {
  const on = argv.includes(LANDABLE_ENABLE_FLAG);
  const off = argv.includes(LANDABLE_DISABLE_FLAG);
  if (on && off) throw new Error(`usage: ${LANDABLE_ENABLE_FLAG} and ${LANDABLE_DISABLE_FLAG} are mutually exclusive`);
  if (on || off) return { value: on, source: 'cli' };
  if (env[LANDABLE_ENV_KEY] !== undefined) {
    const raw = String(env[LANDABLE_ENV_KEY]).trim().toLowerCase();
    if (['1', 'on', 'true'].includes(raw)) return { value: true, source: 'env' };
    if (['0', 'off', 'false'].includes(raw)) return { value: false, source: 'env' };
    throw new Error(`usage: ${LANDABLE_ENV_KEY} must be 1/0, on/off or true/false`);
  }
  return { value: true, source: 'default' };
}

/** The drain emits this once per pass, even when the setting is unchanged. */
export function formatOverlapYieldRequiresLandableSetting({ value, source }) {
  return `policy · drain.overlapYieldRequiresLandable=${value ? 'on' : 'off'} (source: ${source})`;
}

/** Filter only the Y side. Normalize verdict keys exactly as buildOverlapRows
 * normalizes listing rows: local null repo -> localSlug, numbers scoped by repo.
 * All non-merge verdicts are excluded regardless of their reason vocabulary.
 * Candidate rows and the verdicts themselves remain owned by the existing gates.
 */
export function filterEnqueueableOverlapRows({ openPrRows = [], verdicts = [], localSlug = null, enabled = true, requiresLandable = true } = {}) {
  if (!enabled && !requiresLandable) return openPrRows;
  const byKey = new Map((Array.isArray(verdicts) ? verdicts : []).map((v) => [overlapRowKey({ repo: v.repo || localSlug, number: v.num }), v]));
  return openPrRows.filter((row) => {
    if (requiresLandable) {
      const labels = new Set((Array.isArray(row.labels) ? row.labels : []).map((label) => typeof label === 'string' ? label : label?.name));
      if (!row.requiredCheckGreen || !labels.has('ready-to-merge')
        || ['blocked', 'ci:failed', 'review:changes'].some((label) => labels.has(label))) return false;
    }
    const verdict = byKey.get(overlapRowKey({ ...row, repo: row.repo || localSlug }));
    return !enabled || !verdict || verdict.decision === 'merge';
  });
}

const BLOCKED_ENV_KEY = 'WE_DRAIN_OVERLAP_YIELD_SKIPS_BLOCKED_TARGET';
const BLOCKED_ENABLE_FLAG = '--overlap-yield-skips-blocked-target';
const BLOCKED_DISABLE_FLAG = '--no-overlap-yield-skips-blocked-target';

/** drain.overlapYieldSkipsBlockedTarget: CLI > env > default ON.
 * Env accepts 1/0, on/off, true/false. Conflicting flags and invalid env values are usage errors.
 */
export function resolveOverlapYieldSkipsBlockedTargetSetting({ argv = [], env = {} } = {}) {
  const on = argv.includes(BLOCKED_ENABLE_FLAG);
  const off = argv.includes(BLOCKED_DISABLE_FLAG);
  if (on && off) throw new Error(`usage: ${BLOCKED_ENABLE_FLAG} and ${BLOCKED_DISABLE_FLAG} are mutually exclusive`);
  if (on || off) return { value: on, source: 'cli' };
  if (env[BLOCKED_ENV_KEY] !== undefined) {
    const raw = String(env[BLOCKED_ENV_KEY]).trim().toLowerCase();
    if (['1', 'on', 'true'].includes(raw)) return { value: true, source: 'env' };
    if (['0', 'off', 'false'].includes(raw)) return { value: false, source: 'env' };
    throw new Error(`usage: ${BLOCKED_ENV_KEY} must be 1/0, on/off or true/false`);
  }
  return { value: true, source: 'default' };
}

/** The drain emits this once per pass, even when the setting is unchanged. */
export function formatOverlapYieldSkipsBlockedTargetSetting({ value, source }) {
  return `policy · drain.overlapYieldSkipsBlockedTarget=${value ? 'on' : 'off'} (source: ${source})`;
}

/**
 * A PR may make others yield only while it can itself be enqueued this pass. `compute(openPrRows)` returns an
 * overlap context ({waits, skips, ...}). For every yield target it names, `blockOf(row)` says whether a blocking
 * hold stops that target this pass: `{kind, reason}` = blocked, `null` = not blocked. A throw means "cannot tell":
 * the target is kept (fail closed — today's yield). Blocked targets are dropped from the Y side and the context is
 * recomputed, so a waiter can still yield to the next eligible target. Every waiter keeps all of its own gates.
 * @returns {{ctx:object, skipped:Array<{pr:number, repo:(string|null), kind:string, reason:string, waiters:string[]}>, unknown:Array<{pr:number, repo:(string|null), error:string}>}}
 */
export function planOverlapYieldAroundBlockedTargets({ openPrRows = [], compute, blockOf, enabled = true } = {}) {
  let rows = Array.isArray(openPrRows) ? openPrRows : [];
  let ctx = compute(rows);
  const skipped = [];
  const unknown = [];
  if (!enabled || typeof blockOf !== 'function') return { ctx, skipped, unknown };
  const decided = new Map();
  // Fixed point: every round that does not stop removes at least one row, and rows are finite, so it ends.
  for (;;) {
    const blockedKeys = new Set();
    for (const [waiterKey, w] of (ctx?.waits instanceof Map ? ctx.waits : new Map())) {
      const key = overlapRowKey({ repo: w.repo, number: w.yieldTo });
      if (!decided.has(key)) {
        const row = rows.find((r) => overlapRowKey(r) === key);
        let verdict;
        if (!row) verdict = { unknown: 'target row not found' };
        else {
          try { verdict = { hold: blockOf(row) || null }; }
          catch (e) { verdict = { unknown: String(e?.message || e) }; }
        }
        decided.set(key, verdict);
        if (verdict.unknown) unknown.push({ pr: Number(w.yieldTo), repo: w.repo ?? null, error: verdict.unknown });
        else if (verdict.hold) skipped.push({ pr: Number(w.yieldTo), repo: w.repo ?? null, kind: verdict.hold.kind, reason: verdict.hold.reason, waiters: [] });
      }
      const v = decided.get(key);
      if (v.hold) {
        blockedKeys.add(key);
        const entry = skipped.find((s) => overlapRowKey({ repo: s.repo, number: s.pr }) === key);
        if (entry && !entry.waiters.includes(waiterKey)) entry.waiters.push(waiterKey);
      }
    }
    if (!blockedKeys.size) break;
    rows = rows.filter((r) => !blockedKeys.has(overlapRowKey(r)));
    ctx = compute(rows);
  }
  return { ctx, skipped, unknown };
}

/** The decision line for one skipped target, e.g. `overlap-yield skipped: #5485 blocked (red-team-pending)`. */
export function formatBlockedYieldTargetLine(s) {
  return `overlap-yield skipped: #${s.pr} blocked (${s.kind})${s.waiters?.length ? ` — ${s.waiters.join(', ')} proceed in normal order` : ''}${s.reason ? ` · ${s.reason}` : ''}`;
}
