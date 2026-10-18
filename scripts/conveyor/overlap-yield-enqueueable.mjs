/**
 * Pass-local overlap-yield eligibility. Pure: no reads, fetches or verdict mutations.
 * A known held candidate cannot be a yield target; a non-candidate keeps the
 * existing overlap rules. Merge verdicts (including those enqueued this pass)
 * remain targets until buildOverlapRows excludes their merged keys.
 */
import { overlapRowKey } from './land-overlap-yield.mjs';

const ENV_KEY = 'WE_DRAIN_OVERLAP_YIELD_ONLY_TO_ENQUEUEABLE';
const ENABLE_FLAG = '--overlap-yield-only-to-enqueueable';
const DISABLE_FLAG = '--no-overlap-yield-only-to-enqueueable';

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

/** Filter only the Y side. Normalize verdict keys exactly as buildOverlapRows
 * normalizes listing rows: local null repo -> localSlug, numbers scoped by repo.
 * All non-merge verdicts are excluded regardless of their reason vocabulary.
 * Candidate rows and the verdicts themselves remain owned by the existing gates.
 */
export function filterEnqueueableOverlapRows({ openPrRows = [], verdicts = [], localSlug = null, enabled = true } = {}) {
  if (!enabled) return openPrRows;
  const byKey = new Map((Array.isArray(verdicts) ? verdicts : []).map((v) => [overlapRowKey({ repo: v.repo || localSlug, number: v.num }), v]));
  return openPrRows.filter((row) => {
    const verdict = byKey.get(overlapRowKey({ ...row, repo: row.repo || localSlug }));
    return !verdict || verdict.decision === 'merge';
  });
}
