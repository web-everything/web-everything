/** Stamped historical 2a0c266d shape. Test data only; never consults host state. */
import { newRunRecord } from '../run-store.mjs';
export const STRANDED_REPO = 'web-everything/web-everything';
export const STRANDED_HEAD = 'a'.repeat(40);
export const STRANDED_AT = '2026-11-26T14:25:02.000Z';
export const DEAD_OWNER = { host: 'fixture-host', namespace: 'pid:[123]', pid: 92472,
  procStart: 'Thu Nov 26 13:00:00 2026' };
export const RECOVERY_OWNER = { ...DEAD_OWNER, pid: 92473, procStart: 'Thu Nov 26 15:00:00 2026' };
export function strandedRecord({ id = '2a0c266d', verdict = 'accept' } = {}) {
  const r = newRunRecord({ id, op: 'review-pr', input: { repo: STRANDED_REPO, pr: 7493 } });
  return { ...r, owner: { ...DEAD_OWNER }, cursor: 12, strandedResumeAttempts: 0,
    pending: { kind: 'effect', step: 'record', stepIndex: 12 },
    verdict: { verdict, summary: 'persisted panel decision', findings: [] },
    findings: {
      read: { repo: STRANDED_REPO, pr: 7493, netBasis: { rev: STRANDED_HEAD } },
      judge: { summary: 'original panel', findings: [] },
      referralVerdict: { verdict, pendingReferrals: [] },
      advise: { applied: true, effects: [] }, confirm: verdict,
    },
    stepTimings: [
      { step: 'read', stepIndex: 0, startedAt: '2026-11-26T13:00:00Z', finishedAt: '2026-11-26T13:01:00Z' },
      { step: 'advise', stepIndex: 8, startedAt: '2026-11-26T14:00:00Z', finishedAt: '2026-11-26T14:01:00Z' },
    ],
    effects: [{ key: `${id}#12#0`, step: 'record', stepIndex: 12, index: 0, type: 'review.label-swap',
      idempotent: false, status: 'pending', attempts: 1, unknownAttempts: 1,
      lastAttemptAt: STRANDED_AT, error: 'loop SIGKILL: outcome unknown',
      payload: { repo: STRANDED_REPO, pr: 7493, to: verdict === 'accept' ? 'accepted' : 'changes',
        actor: 'agent', bodyFile: 'verdict.md', reviewedHead: STRANDED_HEAD,
        addLabel: verdict === 'accept' ? 'review:accepted' : 'review:changes',
        removeLabels: ['review:pending', verdict === 'accept' ? 'review:changes' : 'review:accepted'] } }],
  };
}
export function attemptMarker(run = strandedRecord()) {
  const e = run.effects[0];
  return `<!-- review-attempt: ${run.input.repo}#${run.input.pr}/${run.id}/${e.key}/${e.attempts} -->`;
}
export function appliedComment(run = strandedRecord(), extra = {}) {
  return { id: 'IC_accept', author: { login: 'web-everything' }, createdAt: '2026-11-26T14:27:57Z',
    body: `✅ review — accepted\n<!-- reviewed-sha:${STRANDED_HEAD} -->\n${attemptMarker(run)}`, ...extra };
}
