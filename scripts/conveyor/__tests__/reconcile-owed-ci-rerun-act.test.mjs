import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { planReconcile } from '../reconcile-core.mjs';
import { enrichPrsWithMainRedFacts, resolveOwedCiRerunSettings, defaultReadJobAttempt } from '../reconcile-pass.mjs';

const repo = 'web-everything/web-everything';
const head = 'ab9985630d90019a07b94e946bc75f8de7a6161f';
const at = '2026-10-14T06:06:58Z';
const green = { red: false, sha: '123456789abcdef', at: '2026-10-14T07:00:00Z' };
const windows = [{ start: '2026-10-14T06:00:00Z', end: green.at }];
const check = (name = 'test', run = 123, job = 456) => ({ name, status: 'COMPLETED', conclusion: 'FAILURE',
  completedAt: at, detailsUrl: `https://github.com/${repo}/actions/runs/${run}/job/${job}` });
const evidence = { eligible: true, repo, pr: 5195, head, signature: 'signature', variant: 'owed-ci-rerun',
  jobs: [{ repo, head, run: 123, job: 456, attempt: 1 }], infraCancelled: true };
const fixture = (over = {}) => ({ number: 5195, state: 'OPEN', headRefName: 'lane/card', headRefOid: head,
  labels: [], mergeStateStatus: 'BLOCKED', comments: [], statusCheckRollup: [check()],
  requiredCheckCompletedAt: at, requiredCheckName: 'test', aheadByOnMain: 33,
  mainGreenNow: green, owedCiRerunRetry: evidence, timeoutRetryBudget: { confirmed: 0, rejected: 0 }, ...over });
const plan = (over = {}, setting = { rerun: 'on', maxRerunsPerHead: 1 }) => planReconcile({
  prs: [fixture(over)], agents: [], requiredChecks: ['test'], now: Date.parse('2026-10-14T08:00:00Z'),
  mainRedWindows: windows, owedCiRerun: setting });

describe('owed CI rerun action', () => {
  it('dispatches the existing executor once main is green, without a heal budget', () => {
    const out = plan();
    expect(out.dispatch).toEqual([expect.objectContaining({ kind: 'ci-timeout-rerun', variant: 'owed-ci-rerun',
      timeoutRetry: expect.objectContaining({ infraCancelled: true, cap: 1 }) })]);
    expect(out.refusals.some(r => r.kind === 'owed-ci-rerun')).toBe(false);
  });
  it('holds a pending request', () => {
    const out = plan({ timeoutRetryBudget: { confirmed: 0, rejected: 0, pending: true } });
    expect(out.dispatch).toEqual([]);
    expect(out.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-timeout-rerun-in-flight' }));
  });
  it.each([{ confirmed: 1, rejected: 0 }, { confirmed: 0, rejected: 1 }])('heals after the budget is spent: %j', budget => {
    const out = plan({ timeoutRetryBudget: budget });
    expect(out.dispatch.some(r => r.kind === 'ci-timeout-rerun')).toBe(false);
    expect(out.notes).toContainEqual(expect.objectContaining({ kind: 'owed-ci-rerun-spent', attempts: 1, cap: 1 }));
    expect(out.dispatch.some(r => r.kind === 'ci-heal')).toBe(true);
    expect(out.refusals.some(r => r.kind === 'owed-ci-rerun')).toBe(false);
  });
  it('scales the head budget by deduplicated run targets', () => {
    const out = plan({ owedCiRerunRetry: { ...evidence, jobs: [...evidence.jobs, { ...evidence.jobs[0], run: 124, job: 459 }] } },
      { rerun: 'on', maxRerunsPerHead: 2 });
    expect(out.dispatch[0].timeoutRetry.cap).toBe(4);
  });
  it.each([false, true])('folds the review prerequisite into the rerun decision (pending=%s)', pending => {
    const out = plan({ labels: [{ name: 'review:pending' }], timeoutRetryBudget: { confirmed: 0, rejected: 0, pending } });
    const row = pending ? out.refusals[0] : out.dispatch.find(r => r.kind === 'ci-timeout-rerun');
    expect(row.reviewRefusal).toBeDefined();
    expect(out.refusals.filter(r => r.kind === 'owed-ci-rerun')).toEqual([]);
    expect(out.dispatch.filter(r => r.kind === 'review')).toEqual([]);
  });
  it('waits for main to go green', () => {
    const out = plan({ mainGreenNow: { red: true } });
    expect(out.dispatch).toEqual([]);
    expect(out.refusals[0]).toMatchObject({ kind: 'owed-ci-rerun', why: expect.stringMatching(/waiting for main to go green$/) });
  });
  it('respects the off switch', () => {
    expect(plan({}, { rerun: 'off', maxRerunsPerHead: 1 }).refusals[0].kind).toBe('owed-ci-rerun');
  });
  it.each([{ timeoutRetryBudget: undefined }, { owedCiRerunRetry: { ...evidence, head: 'old' } },
    { owedCiRerunRetry: { ...evidence, pr: 99 } }, { owedCiRerunRetry: { eligible: false } }])('fails closed on missing or stale evidence: %j', over => {
    expect(plan(over).refusals[0].kind).toBe('owed-ci-rerun');
  });
});

const enrich = (pr, over = {}) => enrichPrsWithMainRedFacts([pr], { repo, requiredChecks: ['test', 'lint', 'build'],
  readMainRuns: () => [{ status: 'completed', conclusion: 'success', updatedAt: green.at, headSha: green.sha }],
  readAheadBy: () => 33, readMainLatestCheckRuns: () => [], readMainFixedSignatureFacts: () => null,
  readJobAttempt: () => 2, readBudget: () => ({ confirmed: 0, rejected: 0 }), ...over }).prs[0];

describe('owed CI rerun evidence', () => {
  it('uses latest required entries, dedupes runs, and reads one attempt per target', () => {
    const readJobAttempt = vi.fn(() => 2);
    const readBudget = vi.fn(() => ({ confirmed: 0, rejected: 0 }));
    const out = enrich(fixture({ timeoutRetryBudget: undefined, statusCheckRollup: [
      { ...check('test', 99, 98), completedAt: '2026-10-14T05:00:00Z' }, check(),
      check('lint', 123, 457), check('build', 100, 458), check('optional', 500, 501),
    ] }), { readJobAttempt, readBudget });
    expect(out.mainGreenNow).toEqual(green);
    expect(out.owedCiRerunRetry).toEqual({ ...evidence, signature: createHash('sha256')
      .update(JSON.stringify(['owed-ci-rerun', head, [100, 123].sort()])).digest('hex'),
      jobs: [{ repo, head, run: 123, job: 456, attempt: 2 }, { repo, head, run: 100, job: 458, attempt: 2 }] });
    expect(readJobAttempt.mock.calls).toEqual([[{ repo, job: 456 }], [{ repo, job: 458 }]]);
    expect(readBudget).toHaveBeenCalledWith({ repo, pr: 5195, head });
    expect(out.timeoutRetryBudget).toEqual({ confirmed: 0, rejected: 0 });
  });
  it.each(['bad-url', 'reader-throw'])('fails closed: %s', failure => {
    const out = enrich(fixture({ statusCheckRollup: [{ ...check(), ...(failure === 'bad-url' ? { detailsUrl: 'bad' } : {}) }] }),
      { readJobAttempt: () => { throw new Error('read failed'); } });
    expect(out.owedCiRerunRetry).toMatchObject({ eligible: false, reason: expect.any(String) });
  });
  it('keeps an existing budget without rereading it', () => {
    const readBudget = vi.fn();
    expect(enrich(fixture(), { readBudget }).timeoutRetryBudget).toEqual({ confirmed: 0, rejected: 0 });
    expect(readBudget).not.toHaveBeenCalled();
  });
  it('does not read jobs or budgets when main is red', () => {
    const readJobAttempt = vi.fn(), readBudget = vi.fn();
    const out = enrich(fixture({ owedCiRerunRetry: undefined }), { readJobAttempt, readBudget,
      readMainRuns: () => [{ status: 'completed', conclusion: 'failure', updatedAt: green.at }] });
    expect(out.mainGreenNow.red).toBe(true);
    expect(out.owedCiRerunRetry).toBeUndefined();
    expect(readJobAttempt).not.toHaveBeenCalled();
    expect(readBudget).not.toHaveBeenCalled();
  });
});

it('resolves owed rerun settings with the fix policy cascade and source', () => {
  const read = () => JSON.stringify({ fix: { owedCiRerun: { rerun: 'on', maxRerunsPerHead: 3 } } });
  expect(resolveOwedCiRerunSettings({ env: {}, read: () => '{}' })).toEqual({ value: { rerun: 'on', maxRerunsPerHead: 1 }, source: 'standard' });
  expect(resolveOwedCiRerunSettings({ env: {}, read })).toEqual({ value: { rerun: 'on', maxRerunsPerHead: 3 }, source: 'settings' });
  expect(resolveOwedCiRerunSettings({ env: { WE_FIX_OWED_CI_RERUN: 'off' }, read })).toEqual({ value: { rerun: 'off', maxRerunsPerHead: 3 }, source: 'env' });
});

it('reads the live job attempt through the throttled reader interface', () => {
  const exec = vi.fn(() => JSON.stringify({ run_attempt: 3 }));
  expect(defaultReadJobAttempt({ repo, job: 456, exec })).toBe(3);
  expect(exec).toHaveBeenCalledWith('gh', ['api', `repos/${repo}/actions/jobs/456`], expect.objectContaining({ encoding: 'utf8' }));
});
