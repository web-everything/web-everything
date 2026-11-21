import { describe, it, expect, vi } from 'vitest';
import { excusePrMergeGateHolds, readLatestMainCi } from '../merge-gate-hold-class.mjs';
import { planReconcile } from '../../conveyor/reconcile-core.mjs';
import { realRequiredFailures } from '../../conveyor/exhausted-retry.mjs';

const head = 'a'.repeat(40);
const completed_at = '2026-11-18T10:00:00Z';
const green = { status: 'completed', conclusion: 'success', completed_at: '2026-11-18T11:00:00Z' };
const row = { name: 'merge-gate', status: 'completed', conclusion: 'failure', id: 123 };
const hold = { id: 'red-main-freeze', status: 'hold', reason: `main is RED (freeze: main CI red since ${head})` };
const verdict = { num: 7266, head_sha: head, ok: false, completed_at, run_id: 42, run_attempt: 1, results: [hold] };
const pr = { number: 7266, state: 'OPEN', headRefOid: head, headRefName: 'lane/freeze', mergeStateStatus: 'CLEAN',
  labels: [{ name: 'review:pending' }], comments: [], statusCheckRollup: [row] };
const classify = (v = {}, main = green, check = row) => excusePrMergeGateHolds([{ ...pr, statusCheckRollup: [check] }], {
  repo: 'owner/repo', mergeGateSetting: 'on', readMergeGateVerdict: () => ({ ...verdict, ...v }), readMainCi: () => main,
})[0];

describe('automatic stale main freeze', () => {
  it('routes to a rerun and review, never ci-heal or a synthetic success', () => {
    const annotated = classify();
    expect(annotated.statusCheckRollup[0]).toMatchObject({ conclusion: 'failure',
      mergeGateReviewHold: { holds: ['red-main-freeze'] }, mergeGateStaleFreeze: { run: 42, head } });
    expect(realRequiredFailures(annotated, ['merge-gate'])).toEqual([]);
    const plan = planReconcile({ prs: [annotated], agents: [], requiredChecks: ['merge-gate'], reviewTiming: { startAfter: 'ci-green' } });
    expect(plan.dispatch.map(r => r.kind)).toContain('ci-timeout-rerun');
    expect(plan.dispatch.map(r => r.kind)).toContain('review');
    expect(plan.dispatch.map(r => r.kind)).not.toContain('ci-heal');
  });
  it.each([
    ['red main', {}, { ...green, conclusion: 'failure' }],
    ['pending main', {}, { ...green, status: 'in_progress' }],
    ['unreadable main', {}, { error: 'offline' }],
    ['missing main', {}, undefined],
    ['old green', {}, { ...green, completed_at }],
    ['unreadable completion', { completed_at: null }, green],
    ['extra hold', { results: [hold, { id: 'codeql', status: 'hold', reason: 'red' }] }, green],
    ['manual freeze', { results: [{ ...hold, reason: 'main is RED (freeze: manual freeze: stop)' }] }, green],
    ['unknown freeze origin', { results: [{ ...hold, reason: 'main is RED (freeze: unknown)' }] }, green],
    ['wrong head', { head_sha: 'b'.repeat(40) }, green],
    ['unreadable run', { run_id: null }, green],
    ['unreadable verdict', { error: 'offline' }, green],
  ])('refuses %s', (_name, v, main) => {
    // Explicit undefined must remain unreadable rather than selecting the fixture default.
    const annotated = classify(v, main ?? { error: 'absent' });
    expect(annotated.statusCheckRollup).toEqual([row]);
    expect(realRequiredFailures(annotated, ['merge-gate'])).toEqual(['merge-gate']);
  });
  it('only annotates the merge-gate check and shares one fresh main read per pass', () => {
    expect(classify({}, green, { ...row, name: 'test' }).statusCheckRollup[0]).not.toHaveProperty('mergeGateReviewHold');
    const readMainCi = vi.fn(() => green);
    excusePrMergeGateHolds([pr, pr], { repo: 'owner/repo', mergeGateSetting: 'on', readMainCi, readMergeGateVerdict: () => verdict });
    expect(readMainCi).toHaveBeenCalledTimes(1);
  });
  it('fails closed on a throwing main reader', () => {
    expect(excusePrMergeGateHolds([pr], { repo: 'owner/repo', mergeGateSetting: 'on',
      readMergeGateVerdict: () => verdict, readMainCi: () => { throw Error('offline'); } })).toEqual([pr]);
  });
  it('accepts fail-closed automatic freeze rows using the same fresh proof', () => {
    expect(classify({ results: [{ ...hold, status: 'fail-closed' }] }).statusCheckRollup[0]).toHaveProperty('mergeGateStaleFreeze');
  });
});

describe('latest main CI reader', () => {
  it.each([[], null, [{ status: 'in_progress', conclusion: null }]])('refuses unreadable or incomplete latest evidence %j', runs => {
    expect(readLatestMainCi({ repo: 'owner/repo', runGh: () => JSON.stringify({ workflow_runs: runs }) })).toHaveProperty('error');
  });
  it('reads the latest run without filtering out pending or red runs, through the throttle', () => {
    const runGh = vi.fn(() => JSON.stringify({ workflow_runs: [{ head_branch: 'main', status: 'completed', conclusion: 'success', updated_at: green.completed_at }] }));
    expect(readLatestMainCi({ repo: 'owner/repo', runGh })).toEqual(green);
    expect(runGh.mock.calls[0][0]).toEqual(['api', 'repos/owner/repo/actions/workflows/ci.yml/runs?branch=main&per_page=1']);
    expect(runGh.mock.calls[0][1].throttle).toBeDefined();
  });
});
