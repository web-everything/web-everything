import { describe, it, expect, vi } from 'vitest';
import { failedCodeQLCheck } from '../codeql-gate.mjs';
import { ciRedOnHead, fixReadiness, joinedFixDecision, FIX_TIMING_DEFAULTS, fixPushGate, reviewStartGate, earlyStartShadow, REVIEW_TIMING_DEFAULTS } from '../review-timing.mjs';
import { realRequiredFailures, retryOutcome, buildExhaustedRetryComment } from '../../conveyor/exhausted-retry.mjs';
import { handleStaleMergeGate } from '../merge-queue-enqueue.mjs';

const head = 'a'.repeat(40);
// Attempts of one job share the Actions job identity (contract: only a proven identity orders attempts).
const row = (conclusion, extra = {}) => {
  const base = { name: 'test', status: 'completed', conclusion,
    head_sha: head, run_id: 10, run_attempt: 1, id: 1, completedAt: '2026-11-18T02:00:00Z', ...extra };
  return { detailsUrl: `https://github.com/o/r/actions/runs/${base.run_id}/job/5`, ...base };
};
const pr = rows => ({ headRefOid: head, rowsComplete: true, statusCheckRollup: rows });
const retry = { body: buildExhaustedRetryComment({ headSha: head }),
  createdAt: '2026-11-18T01:00:00Z', author: { login: 'web-everything' } };
const cases = [
  ['different workflows/runs retain failure', [row('failure'), row('success', { run_id: 20, id: 2 })], 'fail'],
  ['same run higher attempt succeeds', [row('failure'), row('success', { run_attempt: 2, id: 2 })], 'pass'],
  ['unordered rows retain failure', [row('failure', { run_attempt: undefined }), row('success', { run_attempt: undefined, id: 2 })], 'fail'],
  ['equal attempts retain failure', [row('failure'), row('success', { id: 2 })], 'fail'],
  ['running rerun supersedes failure', [row('failure'), row(null, { status: 'in_progress', run_attempt: 2, id: 2 })], 'pending'],
];

describe.each(cases)('%s', (_label, rows, state) => {
  it('CodeQL returns deterministic failing evidence and leaves running reruns pending', () => {
    const checks = rows.map(r => ({ ...r, name: 'CodeQL' }));
    const result = failedCodeQLCheck(pr(checks));
    expect(result?.conclusion ?? null).toBe(state === 'fail' ? 'failure' : null);
    expect(failedCodeQLCheck(pr([...checks].reverse()))).toEqual(result);
  });
  it('review timing preserves failures and running reruns in both input orders', () => {
    for (const checks of [rows, [...rows].reverse()]) {
      const input = { rosterSource: 'live', headSha: head, checks, requiredChecks: ['test'], rowsComplete: true };
      expect(ciRedOnHead(input)).toBe(state === 'fail');
      expect(fixReadiness(input).ciFailed).toBe(state === 'fail');
      expect(reviewStartGate({ ...input, policy: { ...REVIEW_TIMING_DEFAULTS, startAfter: 'ci-green', startEarly: 'off' } }).allowed).toBe(state === 'pass');
      expect(fixPushGate({ rosterSource: 'live', headSha: head, rowsComplete: true, previousHeadChecks: checks, requiredChecks: ['test'],
        policy: { pushAfterCi: true, pushAfterCiMaxMin: 1 }, firstHeldAt: 0, now: 0 }).action).toBe(state === 'pending' ? 'wait' : 'push');
    }
  });
  it('exhausted retry never recovers across a surviving failure or pending rerun', () => {
    for (const checks of [rows, [...rows].reverse()]) {
      expect(realRequiredFailures(pr(checks), ['test'])).toEqual(state === 'fail' ? ['test'] : []);
      expect(retryOutcome({ comments: [retry], pr: pr(checks), requiredChecks: ['test'] }))
        .toEqual(state === 'fail' ? { state: 'failed', failures: ['test'] } : { state: state === 'pass' ? 'recovered' : 'pending' });
    }
  });
  it('enqueue refresh reads runs only after every other required check passes', async () => {
    for (const checks of [rows, [...rows].reverse()]) {
      const readGateRuns = vi.fn(() => []);
      await handleStaleMergeGate({ c: { decision: 'skip', state: 'BLOCKED', reason: 'merge state BLOCKED' },
        rosterSource: 'live', pr: pr(checks), requiredChecks: ['test', 'merge-gate'], setting: 'on',
        classifyPr: () => ({ decision: 'merge' }), readGateRuns });
      expect(readGateRuns).toHaveBeenCalledTimes(state === 'pass' ? 1 : 0);
    }
  });
});

it('CodeQL pending on incomplete rows is not excused (unseen rows may hold a failure)', () => {
  const pending = row(null, { name: 'CodeQL', status: 'in_progress', run_attempt: 2 });
  expect(failedCodeQLCheck({ ...pr([pending]), rowsComplete: false })).toBeTruthy();
  expect(failedCodeQLCheck(pr([pending]))).toBeNull();
});

it('CodeQL fails closed for missing head, unreadable/incomplete rows and malformed evidence', () => {
  for (const input of [{ statusCheckRollup: [row('success')] }, { ...pr([]), requiredCheckReadError: 'unreadable' },
    { ...pr([row('success', { name: 'CodeQL' })]), rowsComplete: false },
    pr([row('success', { name: 'CodeQL', status: undefined })])]) expect(failedCodeQLCheck(input)).toBeTruthy();
});
it('retry refuses incomplete evidence, missing head and missing roster', async () => {
  for (const input of [{ ...pr([row('success')]), rowsComplete: false }, { ...pr([row('success')]), headRefOid: null }])
    expect(retryOutcome({ comments: [retry], pr: input, requiredChecks: ['test'] })).toEqual({ state: 'pending' });
  expect(retryOutcome({ comments: [retry], pr: pr([row('success')]) })).toEqual({ state: 'pending' });
});
it('enqueue refuses incomplete rollup evidence before reading workflow runs', async () => {
  const readGateRuns = vi.fn();
  await handleStaleMergeGate({ c: { decision: 'skip', state: 'BLOCKED', reason: 'merge state BLOCKED' },
    pr: { ...pr([row('success')]), rowsComplete: false }, requiredChecks: ['test', 'merge-gate'], setting: 'on',
    classifyPr: () => ({ decision: 'merge' }), readGateRuns });
  expect(readGateRuns).not.toHaveBeenCalled();
});
it('timing fails closed without roster/head and fix push has an explicit bounded fallback', () => {
  expect(ciRedOnHead({ headSha: head, checks: [row('success')] })).toBe(true);
  expect(reviewStartGate({ rowsComplete: true, headSha: head, checks: [row('success')], verifyGreen: true,
    policy: { ...REVIEW_TIMING_DEFAULTS, startBeforeCi: true } }).allowed).toBe(false);
  const input = { previousHeadChecks: [row('success')], requiredChecks: ['test'], firstHeldAt: 0,
    policy: { pushAfterCi: true, pushAfterCiMaxMin: 1 } };
  expect(fixPushGate({ ...input, now: 0 }).action).toBe('wait');
  expect(fixPushGate({ ...input, now: 60000 })).toMatchObject({ action: 'push', reason: 'bound' });
});

const joinedGreenInput = {
  rosterSource: 'live', headSha: head, checks: [row('success')], requiredChecks: ['test'],
  findings: [{ createdAt: '2026-11-18T03:00:00Z' }],
};
it('complete green CI plus review findings releases the joined fix immediately', () => {
  const readiness = fixReadiness({ ...joinedGreenInput, rowsComplete: true });
  expect(readiness).toMatchObject({ ciFailed: false, reviewFindings: true, otherPending: false });
  expect(joinedFixDecision({ ...readiness, now: Date.parse('2026-11-18T03:00:01Z'),
    policy: { ...FIX_TIMING_DEFAULTS, joinCiAndReview: true } })).toEqual({ action: 'dispatch', joined: false });
});
it.each([undefined, false])('incomplete green CI plus review findings keeps the joined fix waiting (%s)', rowsComplete => {
  const readiness = fixReadiness({ ...joinedGreenInput, rowsComplete });
  expect(readiness).toMatchObject({ ciFailed: false, reviewFindings: true, otherPending: true });
  expect(joinedFixDecision({ ...readiness, now: Date.parse('2026-11-18T03:00:01Z'),
    policy: { ...FIX_TIMING_DEFAULTS, joinCiAndReview: true } }).action).toBe('wait');
});
