import { describe, expect, it, vi } from 'vitest';
import { foldReviewRefusalInto, planReconcile } from '../../conveyor/reconcile-core.mjs';
import { readPlannerRow, readPlannerRows } from '../red-team-planner-row.mjs';
import { planRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { createRedTeamDispatchQueue, runWithRedTeamQueue } from '../red-team-dispatch-queue.mjs';

// Shapes from review-red-team-on-skip.test.mjs, red-team-dispatch-queue.test.mjs and
// reconcile-core.test.mjs (foldReviewRefusalInto and the annotated held-gate fixtures).
const repo = 'web-everything/web-everything', pr = 5762, head = 'a'.repeat(40);
const check = (name, conclusion = 'failure', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
const rawPr = (statusCheckRollup = []) => ({ number: pr, headRefOid: head, rowsHead: head, rowsComplete: true, comments: [], reviews: [], statusCheckRollup });
const refusal = (kind, extra = {}) => ({ kind, prNumber: pr, headSha: head, ...extra });
const scopeBloat = { stale: true, why: 'stale base carries unrelated changes' };
function folded(kind) {
  const row = refusal('ci-heal-escalated', { outcome: 'not-a-ci-break' });
  foldReviewRefusalInto(row, { phase: 'ci-red', labels: ['review:pending'] }, 'ciHealNotCiBreak')(kind, {
    phase: 'ci-red', ciHealNotCiBreak: true, ...(kind === 'scope-bloat' ? { scopeBloat } : { why: 'held' }),
  });
  return row;
}
const cases = [
  ['already-reviewed-head', refusal('already-reviewed-head'), [{ prNumber: pr, action: 'dispatch', mode: 'fresh' }]],
  ['review-ci', refusal('review-ci', { ci: { allowed: false, reason: 'required-checks-not-successful' } }), []],
  ['ci-heal-escalated', refusal('ci-heal-escalated', { outcome: 'needs-human' }), []],
  ['scope-bloat', refusal('scope-bloat', { scopeBloat }), []],
  ['folded reviewRefusal', folded('already-reviewed-head'), []],
  ['folded scope-bloat', folded('scope-bloat'), []],
  ['referral hold', refusal('review-referrals-pending', { referralHold: { why: 'waiting for referral' } }), []],
  ['absent row', null, []],
];
const options = rows => ({ repo, refusals: rows, rawPrs: [rawPr()],
  readEvidence: vi.fn(() => ({ loopPayload: { verdict: { verdict: 'accept' },
    findings: { read: { netBasis: { rev: head } } } }, recorded: false })),
  readStatus: () => null, headNeverReviewed: () => false, readReviewRuns: () => [],
  readSeal: null, env: {}, now: 2_000_000, setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map() });
const decisions = rows => rows.map(({ prNumber, action, mode }) => ({ prNumber, action, ...(mode ? { mode } : {}) }));

describe('readPlannerRow', () => {
  it('fails closed with absent=true when no reconciliation refusal exists, even if a raw PR or saved row exists', () => {
    expect(readPlannerRow()).toEqual({ absent: true });
    expect(readPlannerRow({ pr, plan: { refusals: 'unavailable' } })).toEqual({ absent: true });
    const saved = readPlannerRow({ pr, refusals: [refusal('scope-bloat')] });
    expect(readPlannerRow({ repo, pr, rawPrs: [rawPr()], plan: { refusals: [], plannerRows: [saved] } }))
      .toEqual({ absent: true });
    expect(readPlannerRow({ pr: pr + 1, refusals: [refusal('scope-bloat')] })).toEqual({ absent: true });
  });

  it.each(cases.filter(([, row]) => row))('preserves all %s metadata without flattening the folded refusal', (_, row) => {
    const result = readPlannerRow({ repo, pr: String(pr), plan: { refusals: [row] } });
    expect(result.absent).toBe(false);
    expect(result.refusal).toBe(row);
    expect(result.reviewOwnedChecks.ci.allowed).toBe(false);
    if (row.reviewRefusal) expect(result.refusal.reviewRefusal).toBe(row.reviewRefusal);
  });

  it('keeps the folded scope-bloat and its parent escalation distinct, after the real fold strips population fields', () => {
    const row = readPlannerRow({ pr, refusals: [folded('scope-bloat')] });
    expect(row.refusal).toMatchObject({ kind: 'ci-heal-escalated', outcome: 'not-a-ci-break',
      reviewRefusal: { kind: 'scope-bloat', scopeBloat } });
    expect(row.refusal.reviewRefusal).toEqual({ kind: 'scope-bloat', scopeBloat });
  });

  const classify = (checks, extra = {}) => readPlannerRow({ pr, refusals: [refusal('review-ci')],
    rawPrs: [rawPr(checks)], requiredChecks: ['test'], rosterSource: 'live', ...extra });

  it.each([
    ['pass', [check('test', 'success')], 'pass', [], []],
    ['missing status', [{ name: 'test', conclusion: 'success' }], 'unknown', [], ['test']],
    ['foreign-head failure', [check('test', 'failure', { head_sha: 'b'.repeat(40) })], 'unknown', [], ['test']],
    ['held review-gate', [check('review-gate')], 'held', ['review-gate'], []],
    ['merge-gate without a bound hold', [check('merge-gate', 'failure', {
      mergeGateReviewHold: { holds: ['review-gate'], jobId: 1 },
    })], 'fail', [], ['merge-gate']],
    ['rerun in flight', [check('test', 'success', { run_id: 1, run_attempt: 1 }),
      check('test', null, { run_id: 1, run_attempt: 2, status: 'in_progress' })], 'pending', [], ['test']],
  ])('mirrors the contract for %s', (_, checks, state, reviewOwned, nonReviewOwned) => {
    const result = classify(checks, { requiredChecks: [checks[0].name] });
    expect(result.checkEvidence.state).toBe(state);
    expect(result.checkEvidence.perName[checks[0].name].state).toBe(state);
    expect(result.reviewOwnedChecks).toMatchObject({
      ci: { allowed: state === 'pass' }, required: state === 'pass' ? [] : [checks[0].name],
      nonRequired: [], reviewOwned, nonReviewOwned,
      gatesOnlyRed: ['pass', 'held'].includes(state), onlyRed: ['pass', 'held'].includes(state),
    });
    if (state === 'pending') expect(result.checkEvidence.perName.test.rerunInFlight).toBe(true);
  });

  it.each([head, 'b'.repeat(40)])('rejects optional non-review red on any head for red-only eligibility: %s', failedHead => {
    for (const reviewHeld of [false, true]) {
      const checks = [check('test', 'success', { head_sha: head }),
        check('optional', 'failure', { head_sha: failedHead })];
      const requiredChecks = ['test'];
      if (reviewHeld) {
        checks.push(check('review-gate', 'failure', { head_sha: head }));
        requiredChecks.push('review-gate');
      }
      const result = classify(checks, { requiredChecks });
      expect(result.checkEvidence.state).toBe(reviewHeld ? 'held' : 'pass');
      expect(result.reviewOwnedChecks).toMatchObject({ ci: { allowed: !reviewHeld },
        reviewOwned: reviewHeld ? ['review-gate'] : [], nonRequired: ['optional'],
        nonReviewOwned: [], gatesOnlyRed: true, onlyRed: false });
    }
  });

  it('uses the refusal head rather than accepting checks fetched for a moved PR head', () => {
    const result = classify([check('test', 'success')], {
      rawPrs: [{ ...rawPr([check('test', 'success')]), headRefOid: 'b'.repeat(40), rowsHead: 'b'.repeat(40) }],
    });
    expect(result.checkEvidence.state).toBe('unknown');
    expect(result.reviewOwnedChecks).toMatchObject({ ci: { allowed: false, headSha: head }, onlyRed: false });
  });

  it.each([
    ['stale snapshot head', { rawPrs: [{ ...rawPr([check('test', 'success')]), rowsHead: 'b'.repeat(40) }] }],
    ['missing snapshot head', { rawPrs: [{ ...rawPr([check('test', 'success')]), rowsHead: undefined }] }],
    ['null snapshot head', { rawPrs: [{ ...rawPr([check('test', 'success')]), rowsHead: null }] }],
    ['unstated roster source', { rosterSource: undefined }],
    ['declared roster', { rosterSource: 'declared' }],
    ['unstated completeness', { rawPrs: [{ ...rawPr([check('test', 'success')]), rowsComplete: undefined }] }],
  ])('fails closed with %s', (_, extra) => {
    const result = classify([check('test', 'success')], extra);
    expect(result.checkEvidence.state).toBe('unknown');
    expect(result.reviewOwnedChecks).toMatchObject({ ci: { allowed: false }, onlyRed: false });
  });

  it.each(['plannerOptions', 'plannerRequiredChecks'])('reads the roster provenance from %s', location => {
    const plan = location === 'plannerOptions'
      ? { plannerOptions: { requiredChecks: ['test'], rosterSource: 'cache' } }
      : { plannerRequiredChecks: ['test'], plannerRequiredChecksSource: 'live' };
    expect(classify([check('test', 'success')], { plan, requiredChecks: undefined, rosterSource: undefined })
      .reviewOwnedChecks.ci.allowed).toBe(true);
  });

  it('passes bound hold annotations on the plan to the contract', () => {
    const result = classify([check('merge-gate', 'failure', {
      detailsUrl: 'https://github.com/o/r/actions/runs/1/job/1',
    })], { requiredChecks: ['merge-gate'], plan: {
      holds: [{ jobId: 1, headSha: head, holdIds: ['review-acceptance'] }],
    } });
    expect(result.checkEvidence.state).toBe('held');
    expect(result.reviewOwnedChecks).toMatchObject({ reviewOwned: ['merge-gate'], nonReviewOwned: [], onlyRed: true });
  });

  it('recomputes saved classification from current evidence while preserving an adapted refusal', () => {
    const saved = classify([check('test', 'success')]);
    expect(saved.reviewOwnedChecks.ci.allowed).toBe(true);
    const adapted = refusal('already-reviewed-head');
    const result = classify([check('test')], { refusals: undefined,
      plan: { refusals: [adapted], plannerRows: [saved] } });
    expect(result.refusal).toBe(adapted);
    expect(result.reviewOwnedChecks).not.toBe(saved.reviewOwnedChecks);
    expect(result.checkEvidence.state).toBe('fail');
    expect(result.reviewOwnedChecks).toMatchObject({ ci: { allowed: false }, nonReviewOwned: ['test'], onlyRed: false });
  });

  it('preserves refusal order and multiple refusals for the same PR', () => {
    const rows = [refusal('scope-bloat'), refusal('review-ci'), refusal('already-reviewed-head')];
    expect(readPlannerRows({ refusals: rows }).map(row => row.refusal)).toEqual(rows);
  });
});

describe('normal-path parity with the pre-extraction decisions', () => {
  it.each(cases)('%s keeps the planner decision and queue nomination unchanged', (_, row, before) => {
    const rows = row ? [row] : [];
    const input = options(rows);
    // Frozen decision projections from the existing planner fixtures, including a positive fresh dispatch.
    expect(decisions(planRedTeamOnSkip(input))).toEqual(before);
    const plan = { refusals: rows, plannerRows: readPlannerRows(input) };
    expect(decisions(planRedTeamOnSkip({ ...input, plan, refusals: undefined }))).toEqual(before);
    if (!before.length) expect(input.readEvidence).not.toHaveBeenCalled();
    const queue = createRedTeamDispatchQueue({ file: 'fixture/queue.json',
      readFile: () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }); },
      writeFile: () => {}, rename: () => {}, unlink: () => {}, now: () => 1,
      // The queue admits only rows whose live PR reads back open at the planned head.
      readLivePr: () => ({ state: 'OPEN', headRefOid: head }) });
    const sync = vi.spyOn(queue, 'sync');
    runWithRedTeamQueue({ queue, repo, plan, rawPrs: input.rawPrs,
      capacity: { lanes: 1, remainingStarts: 1 }, readNetFiles: () => ({ ok: false }),
      run: passed => {
        expect(passed.plan.refusals).toEqual(rows);
        return { rows: [], dispatched: [], notStarted: [] };
      } });
    expect(sync).toHaveBeenCalledWith(repo, before.length ? [{ pr, head }] : []);
  });

  it('reads the real top-level scope-bloat refusal from reconciliation', () => {
    const row = refusal('scope-bloat');
    const source = { ...rawPr([check('gate', 'success')]), state: 'OPEN', headRefName: 'lane/5762-example',
      labels: [{ name: 'review:pending' }], mergeStateStatus: 'CLEAN', scopeBloat };
    const plan = planReconcile({ repo: 'we', prs: [source], agents: [], requiredChecks: ['gate'], now: 2_000_000 });
    expect(readPlannerRow({ repo, pr, plan, rawPrs: [source], requiredChecks: ['gate'] }).refusal)
      .toMatchObject({ kind: row.kind, scopeBloat });
  });
});
