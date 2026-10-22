/** Read-only priority projection of the fix dispatcher's existing episode store. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveLimitStatePath } from '../lib/pr-limit-state-path.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { mintSessionSlug } from './session-slug.mjs';
import { isUnderTest } from '../lib/under-test.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';

export function isSendBackFix(entry) {
  return Boolean(entry?.operatorSendBack) || entry?.labels?.some(label =>
    ['review:changes', 'red-team:blocked'].includes(typeof label === 'string' ? label : label?.name)) === true;
}

export function resolveFixWaitingPrioritySettings({ env = process.env, file = readSettings(), platform } = {}) {
  return cascadePolicy('fixWaiting', file.fixWaiting, { env, platform,
    standard: { waitingFreshMs: 360000, dispatchedFreshMs: 86400000 },
    valid: {
      waitingFreshMs: v => Number.isFinite(v) && v > 0 && v <= 900000,
      dispatchedFreshMs: v => Number.isFinite(v) && v > 0 && v <= 86400000,
    },
    envValues: {
      waitingFreshMs: env.WE_FIX_WAITING_FRESH_MS === undefined ? undefined : Number(env.WE_FIX_WAITING_FRESH_MS),
      dispatchedFreshMs: env.WE_FIX_WAITING_DISPATCHED_FRESH_MS === undefined ? undefined : Number(env.WE_FIX_WAITING_DISPATCHED_FRESH_MS),
    },
  });
}

/** Missing, corrupt, future-dated or expired records confer no priority. No network or writes. */
export function readSendBackFixPriority({ env = process.env, nowMs = Date.now(), paths,
  setting = resolveFixWaitingPrioritySettings({ env }), waitingOnly = true } = {}) {
  // Existing suites must not consume the operator's live store; fixtures opt in with a private path.
  if ((isUnderTest() || isUnderTest(env)) && !paths && !env.WE_PR_LIMIT_STATE_FILE) return [];
  const dir = dirname(resolveLimitStatePath(env));
  try { paths ??= readdirSync(dir).filter(n => /^fix-waiting-.+\.json$/.test(n)).map(n => join(dir, n)); }
  catch { return []; }
  const rows = [];
  for (const path of paths) {
    try {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      for (const [key, row] of Object.entries(state)) {
        if (row?.sendBack !== true || (waitingOnly && row.waiting !== true)) continue;
        const leaf = row.waiting === true ? 'waitingFreshMs' : 'dispatchedFreshMs';
        const age = nowMs - row.updatedAt;
        if (!Number.isFinite(row.updatedAt) || age < 0 || age > setting.value[leaf]) continue;
        const split = key.lastIndexOf('#'); const repo = key.slice(0, split); const pr = key.slice(split + 1);
        const repoKey = repoKeyForSlug(repo);
        if (!repoKey || !/^\d+$/.test(pr)) continue;
        rows.push({ repo, pr: Number(pr), session: mintSessionSlug({ kind: 'fix', id: pr, repo: repoKey }),
          updatedAt: row.updatedAt, freshness: `${leaf}=${setting.value[leaf]} (source: ${setting.sources[leaf]})` });
      }
    } catch { /* observation failure never changes a resource guard */ }
  }
  return rows.sort((a, b) => a.updatedAt - b.updatedAt || a.pr - b.pr);
}

/** Only adds a refusal AFTER the existing gate admits. Fix and ci-heal never yield. */
export function yieldToWaitingSendBack(result, { kind, env = process.env, nowMs = Date.now(),
  readWaiting = readSendBackFixPriority } = {}) {
  if (result?.admit !== true || !['build', 'graduation', 'graduate'].includes(kind)) return result;
  const waiting = readWaiting({ env, nowMs, waitingOnly: true })[0];
  return waiting ? { ...result, admit: false, kind: 'send-back-priority',
    why: `yielding to waiting send-back fix #${waiting.pr} (${waiting.repo}; ${waiting.freshness})` } : result;
}
