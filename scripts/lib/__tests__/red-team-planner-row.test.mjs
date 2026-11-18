import { describe, expect, it, vi } from 'vitest';
import { foldReviewRefusalInto, planReconcile } from '../../conveyor/reconcile-core.mjs';
import { reviewCiGate } from '../review-ci-gate.mjs';
import { readPlannerRow, readPlannerRows } from '../red-team-planner-row.mjs';
import { planRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { createRedTeamDispatchQueue, runWithRedTeamQueue } from '../red-team-dispatch-queue.mjs';

// Shapes from review-red-team-on-skip.test.mjs, red-team-dispatch-queue.test.mjs and
// reconcile-core.test.mjs (foldReviewRefusalInto and the annotated held-gate fixtures).
const repo = 'web-everything/web-everything', pr = 5762, head = 'a'.repeat(40);
const check = (name, conclusion = 'failure', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
const rawPr = (statusCheckRollup = []) => ({ number: pr, headRefOid: head, comments: [], reviews: [], statusCheckRollup });
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

  it.each([
    ['review-gate', check('review-gate'), ['review-gate']],
    ['review-owned merge-gate', check('merge-gate', 'failure', { mergeGateReviewHold: { holds: ['review-gate'], jobId: 5874001 } }), ['merge-gate']],
    ['plain merge-gate', check('merge-gate'), []],
    ['red-team', check('red-team'), []],
    ['ordinary test', check('test'), []],
  ])('reuses normal ownership for a required %s failure', (_, failed, owned) => {
    const checks = [check('gate', 'success'), failed];
    const requiredChecks = ['gate', failed.name];
    const result = readPlannerRow({ repo, pr, refusals: [refusal('review-ci')], rawPrs: [rawPr(checks)], requiredChecks });
    expect(result.reviewOwnedChecks).toEqual({
      ci: reviewCiGate({ headSha: head, requiredChecks, checks }),
      required: [failed.name], nonRequired: [], reviewOwned: owned,
      nonReviewOwned: owned.length ? [] : [failed.name], gatesOnlyRed: !!owned.length, onlyRed: !!owned.length,
    });
  });

  it('does not count optional failures as required review holds', () => {
    const result = readPlannerRow({ pr, refusals: [refusal('review-ci')], rawPrs: [rawPr([check('review-gate')])], requiredChecks: ['test'] });
    expect(result.reviewOwnedChecks).toMatchObject({ required: [], nonRequired: ['review-gate'], reviewOwned: [], onlyRed: false });
    expect(result.reviewOwnedChecks.ci.affected).toEqual([{ name: 'test', reason: 'missing' }]);
  });

  it('keeps unknown, missing, pending and wrong-head evidence closed', () => {
    for (const checks of [undefined, [], [check('review-gate', null, { status: 'in_progress' })],
      [check('review-gate', 'success', { head_sha: 'b'.repeat(40) })]]) {
      const result = readPlannerRow({ pr, refusals: [refusal('review-ci')], rawPrs: [rawPr(checks)], requiredChecks: ['review-gate'] });
      expect(result.reviewOwnedChecks.ci.allowed).toBe(false);
      expect(result.reviewOwnedChecks.onlyRed).toBe(false);
    }
  });

  it('uses the producer classification with an adapted refusal instead of re-deriving it from the raw daemon snapshot', () => {
    const original = refusal('nothing-owed', { phase: 'queued' });
    const requiredChecks = ['review-gate'];
    const saved = readPlannerRow({ repo, pr, refusals: [original], rawPrs: [rawPr([check('review-gate')])], requiredChecks });
    const adapted = { ...original, kind: 'already-reviewed-head' };
    const result = readPlannerRow({ repo, pr, plan: { refusals: [adapted], plannerRows: [saved] }, rawPrs: [rawPr()], requiredChecks });
    expect(result.refusal).toBe(adapted);
    expect(result.reviewOwnedChecks).toBe(saved.reviewOwnedChecks);
    expect(result.reviewOwnedChecks.reviewOwned).toEqual(['review-gate']);
  });

  it.each(['failure', 'success'])('rejects %s checks entirely from another head for CI and red-only evidence', conclusion => {
    const checks = [check('test', 'success'), check('review-gate', conclusion)]
      .map(row => ({ ...row, head_sha: 'b'.repeat(40) }));
    const result = readPlannerRow({ repo, pr, refusals: [refusal('review-ci')],
      rawPrs: [rawPr(checks)], requiredChecks: ['test', 'review-gate'] });
    expect(result.reviewOwnedChecks.onlyRed).toBe(false);
    expect(result.reviewOwnedChecks.ci).toMatchObject({ allowed: false, affected: [
      { name: 'test', reason: 'wrong-head' }, { name: 'review-gate', reason: 'wrong-head' },
    ] });
  });

  it.each([
    ['same head and required set', {}, true],
    ['reordered and duplicated required set', { requiredChecks: ['review-gate', 'test', 'test'] }, true],
    ['head B with no checks', { rawPrs: [{ ...rawPr(), headRefOid: 'b'.repeat(40) }] }, false],
    ['changed required set', { requiredChecks: ['test', 'review-gate', 'integration'] }, false],
    ['different repo', { repo: 'other/repo' }, false],
    ['different PR', { pr: pr + 1, rawPrs: [{ ...rawPr(), number: pr + 1 }],
      refusals: [refusal('review-ci', { prNumber: pr + 1 })] }, false],
    ['missing repo', { repo: undefined }, false],
    ['missing head', { rawPrs: [{ ...rawPr(), headRefOid: undefined }] }, false],
    ['missing required set', { requiredChecks: null }, false],
    ['empty required set', { requiredChecks: [] }, false],
    ['malformed required set', { requiredChecks: ['test', ''] }, false],
  ])('reuses saved classification only for a known matching key: %s', (_, changed, reuse) => {
    const input = { repo, pr, refusals: [refusal('review-ci')], requiredChecks: ['test', 'review-gate'] };
    const saved = readPlannerRow({ ...input, rawPrs: [rawPr([check('test', 'success'), check('review-gate', 'success')])] });
    expect(saved.reviewOwnedChecks.ci.allowed).toBe(true);
    const result = readPlannerRow({ ...input, rawPrs: [rawPr()], plan: { plannerRows: [saved] }, ...changed });
    expect(result.reviewOwnedChecks === saved.reviewOwnedChecks).toBe(reuse);
    expect(result.reviewOwnedChecks.ci.allowed).toBe(reuse);
    if (!reuse) expect(result.reviewOwnedChecks.onlyRed).toBe(false);
  });

  it('recomputes legacy saved rows with no classification key', () => {
    const input = { repo, pr, refusals: [refusal('review-ci')], requiredChecks: ['test'] };
    const saved = readPlannerRow({ ...input, rawPrs: [rawPr([check('test', 'success')])] });
    delete saved.classificationKey;
    const result = readPlannerRow({ ...input, rawPrs: [rawPr()], plan: { plannerRows: [saved] } });
    expect(result.reviewOwnedChecks).not.toBe(saved.reviewOwnedChecks);
    expect(result.reviewOwnedChecks.ci).toMatchObject({ allowed: false, affected: [{ name: 'test', reason: 'missing' }] });
  });

  it.each([
    ['missing head', { headRefOid: undefined }, ['review-gate'], 'missing-head'],
    ['missing required set', {}, null, 'unknown-required-set'],
    ['empty required set', {}, [], 'unknown-required-set'],
  ])('fails closed on red-only evidence with %s', (_, changed, requiredChecks, reason) => {
    const result = readPlannerRow({ repo, pr, refusals: [refusal('review-ci')],
      rawPrs: [{ ...rawPr([check('review-gate')]), ...changed }], requiredChecks });
    expect(result.reviewOwnedChecks.ci).toMatchObject({ allowed: false, reason });
    expect(result.reviewOwnedChecks.onlyRed).toBe(false);
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
      writeFile: () => {}, rename: () => {}, unlink: () => {}, now: () => 1 });
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
