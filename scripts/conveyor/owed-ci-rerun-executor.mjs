/** Fast mechanical executor: no fixer slots or fix-pass budget. */
import { dispatchTimeoutRetry } from '../operations/ci-heal-pr-dispatch.mjs';
import { gitRun } from '../lib/main-staleness.mjs';
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

/** Reads origin/main with a hardened git environment; { fresh:true, sha } only when the fetched sha verifies. */
export function probeOriginMain(root = REPO_ROOT, run = gitRun) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[k];
  const opts = { cwd: root, env };
  if (run(['fetch', 'origin', 'main', '--quiet'], opts).status !== 0) return { offline: true };
  const rev = run(['rev-parse', '--verify', 'origin/main^{commit}'], opts);
  const sha = rev.status === 0 ? rev.stdout.trim() : '';
  return /^[0-9a-f]{40}$/.test(sha) ? { fresh: true, sha } : { offline: true };
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
    // The rerun is a stateless API request (no file in the PR or the clone is written), so the daemon's own clone
    // being N commits behind must not refuse it (2026-11-21 live). It only needs origin/main to be readable
    // (fail-closed when offline); the head is re-observed by dispatchRetry just before the POST.
    const probe = checkStaleness ?? probeOriginMain;
    try {
      if (owed.length) {
        const st = probe(root);
        if (!st || st.offline) throw new Error('main freshness unknown (offline); owed rerun deferred');
      }
    } catch (error) {
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
