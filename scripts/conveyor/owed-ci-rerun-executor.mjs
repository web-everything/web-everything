/** Fast mechanical executor: no fixer slots or fix-pass budget. */
import { dispatchTimeoutRetry } from '../operations/ci-heal-pr-dispatch.mjs';
import { assertMainNotStale } from '../lib/main-staleness.mjs';
import { REPO_ROOT } from '../operations/dispatch-lane-io.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';

export function resolveOwedRerunMax(env = process.env) {
  const raw = Number(env.WE_OWED_RERUN_MAX_PER_PASS);
  return cascadePolicy('owedCiRerun', undefined, {
    env, standard: { maxPerPass: 10 },
    envValues: { maxPerPass: Number.isFinite(raw) && env.WE_OWED_RERUN_MAX_PER_PASS?.trim()
      ? Math.max(1, Math.min(25, Math.floor(raw))) : undefined },
    valid: { maxPerPass: v => Number.isInteger(v) && v >= 1 && v <= 25 },
  }).value.maxPerPass;
}

export async function executeOwedCiReruns({ rows = [], repo, dispatchRetry = dispatchTimeoutRetry,
  max = resolveOwedRerunMax(), log = () => {}, root = REPO_ROOT, checkStaleness,
} = {}) {
  const result = { requested: [], refused: [], skippedOverCap: 0 };
  const safeLog = line => { try { log(line); } catch { /* diagnostics only */ } };
  try {
    const cap = Number.isFinite(max) ? Math.max(1, Math.min(25, Math.floor(max))) : 10;
    const owed = rows.filter(row => row?.kind === 'ci-timeout-rerun')
      .sort((a, b) => Number(a.prNumber) - Number(b.prNumber));
    result.skippedOverCap = Math.max(0, owed.length - cap);
    if (result.skippedOverCap) safeLog(`owed-ci-rerun: ${result.skippedOverCap} over cap ${cap}; still owed next review tick`);
    try { if (owed.length) assertMainNotStale(root, checkStaleness); }
    catch (error) {
      result.refused = owed.map(row => ({ pr: row.prNumber, reason: String(error?.message ?? error) }));
      result.skippedOverCap = 0;
      return result;
    }
    for (const row of owed.slice(0, cap)) {
      const pr = row.prNumber;
      try {
        const out = await dispatchRetry(row.timeoutRetry, { repo });
        if (out?.status === 'requested') result.requested.push(pr);
        else result.refused.push({ pr, reason: out?.reason ?? out?.why ?? 'unknown timeout retry result' });
      } catch (error) { result.refused.push({ pr, reason: String(error?.message ?? error) }); }
    }
  } catch (error) { safeLog(`owed-ci-rerun: execution failed: ${String(error?.message ?? error)}`); }
  return result;
}
