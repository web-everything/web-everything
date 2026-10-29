import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { resolveStaleCiRerunSetting } from '../reconcile-pass.mjs';

const repo = 'web-everything/web-everything';
const head = 'ab9985630d90019a07b94e946bc75f8de7a6161f';
const green = { red: false, sha: '123456789abcdef', at: '2026-10-14T07:00:00Z' };
const check = (over = {}) => ({ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-14T16:00:00Z',
  detailsUrl: `https://github.com/${repo}/actions/runs/123/job/456`, ...over });
const evidence = { eligible: true, repo, pr: 5273, head, signature: 's', variant: 'owed-ci-rerun',
  jobs: [{ repo, head, run: 123, job: 456, attempt: 1 }], infraCancelled: true };
const fixture = (over = {}) => ({ number: 5273, state: 'OPEN', isDraft: true, headRefName: 'lane/x', headRefOid: head, labels: [],
  mergeStateStatus: 'BLOCKED', comments: [], statusCheckRollup: [check()], requiredCheckCompletedAt: '2026-10-14T16:00:00Z',
  requiredCheckName: 'test', aheadByOnMain: 0, mainGreenNow: green, owedCiRerunRetry: evidence,
  timeoutRetry: { eligible: false, reason: 'timeout-evidence:incomplete-failure-inventory' },
  timeoutRetryBudget: { confirmed: 0, rejected: 0 }, ...over });
const plan = (over = {}, staleCiRerun = 'once-per-head') => planReconcile({
  prs: [fixture(over)], agents: [], requiredChecks: ['test'], now: Date.parse('2026-10-14T17:00:00Z'), mainRedWindows: [], staleCiRerun });

describe('fix.staleCiRerun', () => {
  it('re-runs the failed jobs once for a stale red check on a green main, draft included, without a heal', () => {
    const out = plan();
    expect(out.dispatch).toEqual([expect.objectContaining({ kind: 'ci-timeout-rerun', variant: 'stale-ci-rerun',
      timeoutRetry: expect.objectContaining({ cap: 1 }) })]);
    expect(out.dispatch.some(r => r.kind === 'ci-heal')).toBe(false);
    expect(out.refusals.some(r => r.kind === 'timeout-retry-ineligible')).toBe(false);
  });
  it('off keeps the old path: ineligible refusal, then ci-heal', () => {
    const out = plan({}, 'off');
    expect(out.dispatch.some(r => r.kind === 'ci-timeout-rerun')).toBe(false);
    expect(out.refusals).toContainEqual(expect.objectContaining({ kind: 'timeout-retry-ineligible' }));
    expect(out.dispatch.some(r => r.kind === 'ci-heal')).toBe(true);
  });
  it.each([{ confirmed: 1, rejected: 0 }, { confirmed: 0, rejected: 1 }])('falls through to ci-heal once the head budget is spent: %j', budget => {
    const out = plan({ timeoutRetryBudget: budget });
    expect(out.dispatch.some(r => r.kind === 'ci-timeout-rerun')).toBe(false);
    expect(out.dispatch.some(r => r.kind === 'ci-heal')).toBe(true);
  });
  it('never authorizes on an unknown budget, a red main or a still-running check', () => {
    for (const over of [{ timeoutRetryBudget: undefined }, { mainGreenNow: { red: true } },
      { statusCheckRollup: [check(), { name: 'smoke', status: 'IN_PROGRESS', conclusion: '' }] }]) {
      expect(plan(over).dispatch.some(r => r.kind === 'ci-timeout-rerun')).toBe(false);
    }
  });
  // A live check defers the re-run; it must hold (no heal budget spent), and re-plan once the run completes.
  it.each([
    ['IN_PROGRESS check', { statusCheckRollup: [check(), { name: 'smoke', status: 'IN_PROGRESS', conclusion: '' }] }],
    ['pending commit status', { statusCheckRollup: [check(), { __typename: 'StatusContext', context: 'ext', state: 'PENDING' }] }],
    ['CheckRun without a status', { statusCheckRollup: [check(), { __typename: 'CheckRun', name: 'smoke' }] }],
    ['incomplete rollup (refused or truncated read)', { rollupIncomplete: true }],
  ])('holds instead of healing while a check is live: %s', (_label, over) => {
    const out = plan(over);
    expect(out.dispatch).toEqual([]);
    expect(out.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-timeout-rerun-in-flight', why: expect.stringMatching(/still running/) }));
  });
  it('a completed commit status is not live', () => {
    const out = plan({ statusCheckRollup: [check(), { __typename: 'StatusContext', context: 'ext', state: 'SUCCESS' }] });
    expect(out.dispatch).toEqual([expect.objectContaining({ kind: 'ci-timeout-rerun', variant: 'stale-ci-rerun' })]);
  });
  it('a spent budget still heals even while a check is live', () => {
    const out = plan({ timeoutRetryBudget: { confirmed: 1, rejected: 0 }, rollupIncomplete: true });
    expect(out.dispatch.some(r => r.kind === 'ci-heal')).toBe(true);
  });
  it('holds a request already in flight', () => {
    const out = plan({ timeoutRetryBudget: { confirmed: 0, rejected: 0, pending: true } });
    expect(out.dispatch.some(r => r.kind === 'ci-timeout-rerun')).toBe(false);
  });
});

describe('resolveStaleCiRerunSetting cascade', () => {
  const read = json => () => json;
  const r = (json, env = {}) => resolveStaleCiRerunSetting({ env, read: read(json) });
  it('standard, settings file, env, in that order of precedence', () => {
    expect(r('{}')).toEqual({ value: 'once-per-head', source: 'standard' });
    expect(r('{"fix":{"staleCiRerun":"off"}}')).toEqual({ value: 'off', source: 'settings' });
    expect(r('{"fix":{"staleCiRerun":"off"}}', { WE_FIX_STALE_CI_RERUN: 'once-per-head' })).toEqual({ value: 'once-per-head', source: 'env' });
  });
  it('fails closed to off on an invalid value', () => {
    expect(r('{"fix":{"staleCiRerun":"always"}}')).toEqual({ value: 'off', source: 'settings-invalid' });
    expect(r('not json')).toEqual({ value: 'off', source: 'settings-invalid' });
    expect(r('{}', { WE_FIX_STALE_CI_RERUN: 'x' })).toEqual({ value: 'off', source: 'env' });
  });
});

describe('incomplete failure inventory recovery', () => {
  it.each(['once-per-head', 'off'])('dispatches exactly one capped recovery rerun without a heal when staleCiRerun is %s', setting => {
    const out = plan({}, setting);
    expect(out.dispatch).toEqual([expect.objectContaining({
      kind: 'ci-timeout-rerun', variant: 'incomplete-inventory-rerun',
      timeoutRetry: expect.objectContaining({ cap: 1 }),
    })]);
    expect(out.dispatch.some(row => row.kind === 'ci-heal')).toBe(false);
  });

  it.each(['once-per-head', 'off'])('dispatches a partial-inventory heal without a blocking refusal when no rerun evidence is owed (%s)', setting => {
    const out = plan({ owedCiRerunRetry: undefined }, setting);
    expect.soft(out.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', partialFailureInventory: true })]);
    expect.soft(out.refusals.some(row => row.kind === 'ci-heal-blocking')).toBe(false);
    expect.soft(out.dispatch.some(row => row.kind === 'ci-timeout-rerun')).toBe(false);
  });

  it.each([
    ['once-per-head', { confirmed: 1, rejected: 0 }],
    ['once-per-head', { confirmed: 0, rejected: 1 }],
    ['off', { confirmed: 1, rejected: 0 }],
    ['off', { confirmed: 0, rejected: 1 }],
  ])('never reruns or heals after the head budget is spent and surfaces starvation in both sinks (%s, %j)', (setting, budget) => {
    const out = plan({ timeoutRetryBudget: budget }, setting);
    expect.soft(out.dispatch.some(row => row.kind === 'ci-timeout-rerun')).toBe(false);
    expect.soft(out.dispatch.some(row => row.kind === 'ci-heal')).toBe(false);
    expect.soft(out.refusals).toContainEqual(expect.objectContaining({
      kind: 'starved-capacity-alert', prNumber: 5273,
      why: expect.stringMatching(/PR #5273.*incomplete failure inventory/i),
    }));
    expect.soft(out.notes).toContainEqual(expect.objectContaining({
      kind: 'starved-capacity-alert', prNumber: 5273,
      text: expect.stringMatching(/PR #5273.*incomplete failure inventory/i),
    }));
  });

  it.each(['once-per-head', 'off'])('fails closed on an unknown head budget even with eligible owed rerun evidence (%s)', setting => {
    const out = plan({ timeoutRetryBudget: undefined }, setting);
    expect(out.dispatch.some(row => row.kind === 'ci-timeout-rerun')).toBe(false);
  });
});
