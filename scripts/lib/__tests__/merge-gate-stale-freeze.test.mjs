import { describe, it, expect, vi } from 'vitest';
import { excusePrMergeGateHolds, readLatestMainCi, readMergeGateVerdict } from '../merge-gate-hold-class.mjs';
import { planReconcile } from '../../conveyor/reconcile-core.mjs';
import { GATE_IDS } from '../merge-gate-inventory.mjs';
import { realRequiredFailures } from '../../conveyor/exhausted-retry.mjs';

const head = 'a'.repeat(40);
const completed_at = '2026-11-18T10:00:00Z';
const green = { status: 'completed', conclusion: 'success', completed_at: '2026-11-18T11:00:00Z' };
const row = { name: 'merge-gate', status: 'completed', conclusion: 'failure', id: 123 };
const hold = { id: 'red-main-freeze', status: 'hold', reason: `main is RED (freeze: main CI red since ${head})` };
const verdict = { num: 7266, head_sha: head, ok: false, completed_at, run_id: 42, run_attempt: 1, evaluatorOnlyFailure: true, results: [hold] };
const pr = { number: 7266, state: 'OPEN', headRefOid: head, headRefName: 'lane/freeze', mergeStateStatus: 'CLEAN',
  rowsComplete: true, rowsHead: head,
  labels: [{ name: 'review:pending' }], comments: [], statusCheckRollup: [row] };
const classify = (v = {}, main = green, check = row) => excusePrMergeGateHolds([{ ...pr, statusCheckRollup: [check] }], {
  repo: 'owner/repo', mergeGateSetting: 'on', readMergeGateVerdict: () => ({ ...verdict, ...v }), readMainCi: () => main, readFreeze: () => ({ frozen: false }),
})[0];

describe('automatic stale main freeze', () => {
  it.each([
    ['wrong head', { head: 'b'.repeat(40) }],
    ['wrong PR', { pr: 7267 }],
  ])('does not dispatch a rerun for an annotation bound to the %s', (_name, changes) => {
    const annotated = classify();
    Object.assign(annotated.statusCheckRollup[0].mergeGateStaleFreeze, changes);
    const plan = planReconcile({ prs: [annotated], agents: [], requiredChecks: ['merge-gate'] });
    expect(plan.dispatch.map(r => r.kind)).not.toContain('ci-timeout-rerun');
    expect(annotated.statusCheckRollup[0].conclusion).toBe('failure');
  });
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
    ['incomplete rows', { rowsComplete: false }],
    ['missing completeness', { rowsComplete: undefined }],
    ['wrong row head', { rowsHead: 'b'.repeat(40) }],
    ['missing row head', { rowsHead: undefined }],
  ])('keeps review blocked for %s despite the stale-freeze annotation', (_name, evidence) => {
    const annotated = { ...classify(), ...evidence };
    const plan = planReconcile({ prs: [annotated], agents: [], requiredChecks: ['merge-gate'], reviewTiming: { startAfter: 'ci-green' } });
    expect(plan.dispatch.map(r => r.kind)).toEqual(['ci-timeout-rerun']);
    expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'review-ci',
      ci: expect.objectContaining({ allowed: false, reason: 'rows-incomplete', unknown: true }) }));
    expect(annotated.statusCheckRollup[0].conclusion).toBe('failure');
  });
  it.each([
    ['red main', {}, { ...green, conclusion: 'failure' }],
    ['pending main', {}, { ...green, status: 'in_progress' }],
    ['unreadable main', {}, { error: 'offline' }],
    ['missing main', {}, undefined],
    ['old green', {}, { ...green, completed_at }],
    ['unreadable completion', { completed_at: null }, green],
    ['extra fail-closed row', { results: [hold, { id: 'codeql', status: 'fail-closed', reason: 'unknown' }] }, green],
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
    excusePrMergeGateHolds([pr, pr], { repo: 'owner/repo', mergeGateSetting: 'on', readMainCi, readFreeze: () => ({ frozen: false }), readMergeGateVerdict: () => verdict });
    expect(readMainCi).toHaveBeenCalledTimes(1);
  });
  it('fails closed on a throwing main reader', () => {
    expect(excusePrMergeGateHolds([pr], { repo: 'owner/repo', mergeGateSetting: 'on',
      readMergeGateVerdict: () => verdict, readMainCi: () => { throw Error('offline'); } })).toEqual([pr]);
  });
  it('refuses a fail-closed automatic freeze row', () => {
    expect(classify({ results: [{ ...hold, status: 'fail-closed' }] }).statusCheckRollup).toEqual([row]);
  });
});

describe('latest main CI reader', () => {
  it.each([[], null, [{ status: 'in_progress', conclusion: null }]])('refuses unreadable or incomplete latest evidence %j', runs => {
    expect(readLatestMainCi({ repo: 'owner/repo', runGh: () => JSON.stringify({ workflow_runs: runs }) })).toHaveProperty('error');
  });
  it('reads the latest run without filtering out pending or red runs, through the throttle', () => {
    const runGh = vi.fn(() => JSON.stringify({ workflow_runs: [{ head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', updated_at: green.completed_at }] }));
    expect(readLatestMainCi({ repo: 'owner/repo', runGh })).toEqual(green);
    expect(runGh.mock.calls[0][0]).toEqual(['api', 'repos/owner/repo/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=10']);
    expect(runGh.mock.calls[0][1].throttle).toBeDefined();
  });
});

describe('stale freeze closed paths', () => {
  it.each([undefined, { error: 'offline' }, { frozen: true }, {}])('refuses unreadable or current shared manual freeze %j', freeze => {
    expect(excusePrMergeGateHolds([pr], { repo: 'owner/repo', mergeGateSetting: 'on',
      readMergeGateVerdict: () => verdict, readMainCi: () => green, readFreeze: () => freeze })).toEqual([pr]);
  });
  it('refuses a throwing shared freeze reader', () => {
    expect(excusePrMergeGateHolds([pr], { mergeGateSetting: 'on', readMergeGateVerdict: () => verdict,
      readMainCi: () => green, readFreeze: () => { throw Error('offline'); } })).toEqual([pr]);
  });
  it.each([false, undefined])('requires proved sole evaluator failure %j', evaluatorOnlyFailure => {
    expect(classify({ evaluatorOnlyFailure }).statusCheckRollup).toEqual([row]);
  });
  it.each([
    ['already landed', { alreadyLandedInMain: { carrierPr: 99 } }, 'already-landed'],
    ['withdrawn draft', { isDraft: true, labels: ['review-status:draft-withdrawn'] }, 'draft'],
  ])('%s refuses before rerun dispatch', (_name, changes, kind) => {
    const plan = planReconcile({ prs: [{ ...classify(), ...changes }], agents: [], requiredChecks: ['merge-gate'] });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ kind })]));
  });
});

describe('main push run history', () => {
  const run = { head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', updated_at: green.completed_at };
  it.each([
    ['fork PR named main', [{ ...run, event: 'pull_request' }]],
    ['older run still running', [run, { ...run, status: 'in_progress', conclusion: null }]],
    ['older run queued for rerun', [run, { ...run, status: 'queued', conclusion: null }]],
    ['latest failed', [{ ...run, conclusion: 'failure' }, run]],
    ['malformed older run', [run, null]],
    ['oversized response', Array(11).fill(run)],
  ])('refuses %s', (_name, workflow_runs) => {
    expect(readLatestMainCi({ repo: 'owner/repo', runGh: () => JSON.stringify({ workflow_runs }) })).toHaveProperty('error');
  });
  it('accepts green latest push with older completed failure', () => {
    expect(readLatestMainCi({ repo: 'owner/repo', runGh: () => JSON.stringify({ workflow_runs: [run, { ...run, conclusion: 'failure' }] }) })).toEqual(green);
  });
});

describe('stale freeze job evidence', () => {
  const step = { name: "Evaluate the drain's merge gates", status: 'completed', conclusion: 'failure' };
  const job = { head_sha: head, completed_at, run_id: 42, run_attempt: 1,
    name: 'merge-gate', status: 'completed', conclusion: 'failure', steps: [step] };
  const log = ['#7266: HOLD', ...GATE_IDS.map(id => id === hold.id
    ? `  hold  ${id}  ${hold.reason}` : `  pass  ${id}  ok`), 'merge-gate: HOLD — held'].join('\n');
  const probe = changes => {
    const v = readMergeGateVerdict({ repo: 'owner/repo', jobId: 123, prNumber: 7266, cache: new Map(),
      runGh: args => args.at(-1).endsWith('/logs') ? log : JSON.stringify({ ...job, ...changes }) });
    return classify(v).statusCheckRollup[0];
  };
  it('annotates the sole failed evaluator in the completed merge-gate job', () => {
    expect(probe({})).toHaveProperty('mergeGateStaleFreeze');
  });
  it.each([
    { name: 'test' }, { status: 'in_progress' }, { conclusion: 'success' }, { steps: undefined },
    { steps: [step, { ...step, name: 'Upload artifact' }] },
    { steps: [{ ...step, name: 'Upload artifact' }] },
    { steps: [step, { ...step, conclusion: 'success' }] },
    { steps: [step, { name: 'Cleanup', status: 'in_progress', conclusion: null }] },
  ])('refuses job/step evidence %j', changes => { expect(probe(changes)).toEqual(row); });
});
