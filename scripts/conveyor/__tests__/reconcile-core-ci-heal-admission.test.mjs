import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { buildRebaseOntoMainComment, DEFAULT_MAX_REBASE_RETRIES_PER_SHA } from '../main-red-recovery.mjs';

const NOW = Date.parse('2026-11-26T07:00:00Z');
const HEAD = 'a'.repeat(40);
const labels = (...names) => names.map(name => ({ name }));
const check = (name, conclusion = 'FAILURE', extra = {}) => ({ name, status: 'COMPLETED', conclusion,
  completedAt: '2026-11-26T06:30:00Z', ...extra });
const gate = (cls = 'main', extra = {}) => check('merge-gate', 'FAILURE', {
  id: 123, mergeGateAdmission: { class: cls, why: 'red-main-freeze', jobId: 123 }, ...extra,
});
const pr = (extra = {}) => ({ number: 7483, state: 'OPEN', headRefName: 'lane/7483-repair',
  headRefOid: HEAD, rowsHead: HEAD, rowsComplete: true, baseRefName: 'main', mergeStateStatus: 'UNSTABLE', mergeable: 'MERGEABLE',
  labels: labels('ci:failed'), comments: [], statusCheckRollup: [gate()], ...extra });
const openWindow = [{ start: '2026-11-26T06:00:00Z', end: null }];
const mainGreenNow = { red: false, sha: 'b'.repeat(40), at: '2026-11-26T06:50:00Z' };
const run = (row = pr(), extra = {}) => planReconcile({ prs: [row], agents: [], now: NOW,
  requiredChecks: ['merge-gate'], advisoryReviewOnHumanHandoff: 'on',
  reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false }, ...extra });
const noHeal = plan => expect(plan.dispatch.filter(row => row.kind === 'ci-heal')).toEqual([]);
const refusal = (plan, kind) => expect(plan.refusals).toContainEqual(expect.objectContaining({ prNumber: 7483, kind }));
const heal = (plan, basis, classes) => expect(plan.dispatch).toContainEqual(expect.objectContaining({
  kind: 'ci-heal', prNumber: 7483, admission: { admitted: true, basis, classes },
}));

describe('CI-heal admission at the planner push sites', () => {
  it('enrichment to planner: a merge-gate whose only hold is red-main-freeze, with main red, plans no ci-heal and refuses main-red (live #7483)', () => {
    // The annotation is the enrichment boundary's output; the observed check stays red.
    const row = pr();
    const plan = run(row, { mainRedWindows: openWindow });
    noHeal(plan);
    refusal(plan, 'main-red');
    expect(row.statusCheckRollup[0].conclusion).toBe('FAILURE');
  });
  it('a DIRTY PR with a main hold is refused while main is red, then admitted once main is green', () => {
    const dirty = pr({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' });
    const red = run(dirty, { mainRedWindows: openWindow });
    noHeal(red);
    refusal(red, 'main-red');
    heal(run({ ...dirty, mainGreenNow }, { mainRedWindows: [] }), 'main-green', ['main']);
  });
  it('the rebase-cap-exhausted path is unchanged', () => {
    const comments = Array.from({ length: DEFAULT_MAX_REBASE_RETRIES_PER_SHA }, () => ({
      author: { login: 'web-everything' }, body: buildRebaseOntoMainComment({ headSha: HEAD, ok: false, error: 'push race' }),
    }));
    const row = pr({ comments, statusCheckRollup: [check('test')], requiredCheckName: 'test',
      requiredCheckCompletedAt: '2026-11-26T06:30:00Z', aheadByOnMain: 33 });
    heal(run(row, { requiredChecks: ['test'], mainRedWindows: openWindow }), 'real', ['real']);
    const mainOnly = run(pr({ comments }), { mainRedWindows: openWindow });
    noHeal(mainOnly);
    refusal(mainOnly, 'main-red');
  });
  it('the review-hold refusal still dispatches the advisory review row', () => {
    const row = pr({ labels: labels('review:human'), statusCheckRollup: [gate('review', {
      mergeGateReviewHold: { holds: ['review-acceptance'], jobId: 123 },
    })] });
    const plan = run(row);
    noHeal(plan);
    refusal(plan, 'review-hold-red'); // Existing guard runs before the new admission gate.
    expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', humanHandoffAdvisory: true }));
  });
  it('needs-human with advisory changes still reaches the fix path', () => {
    const plan = run(pr({ labels: labels('review:human', 'advisory:changes'),
      comments: [{ author: { login: 'web-everything' }, body: `${ADVISORY_NOTE_MARKER}\n\nSome admitted finding text.` }],
      statusCheckRollup: [gate('review', { mergeGateReviewHold: { holds: ['review-acceptance'], jobId: 123 } })],
    }));
    noHeal(plan);
    expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'fix', mode: 'advisory-fix' }));
  });
  it("an empty failing set refuses no-failing-check, not 'unnamed'", () => {
    // A durable ci:failed label survives an empty check read; no observed check authorizes a heal.
    const plan = run(pr({ statusCheckRollup: [] }), { requiredChecks: ['test'] });
    noHeal(plan);
    refusal(plan, 'no-failing-check');
  });
  it('main green uses the main push CI run, not PR-required checks', () => {
    // mainGreenNow is the IO shell's latest completed ci.yml push-run result. Main never runs merge-gate.
    heal(run(pr({ mainGreenNow }), { mainRedWindows: [], mainLatestCheckRuns: [check('test', 'SUCCESS')] }),
      'main-green', ['main']);
    const unknown = run(pr(), { mainLatestCheckRuns: [check('test', 'SUCCESS'), check('merge-gate', 'SUCCESS')] });
    noHeal(unknown);
    refusal(unknown, 'main-red');
    const open = run(pr({ mainGreenNow }), { mainRedWindows: openWindow });
    noHeal(open);
    refusal(open, 'main-red');
  });
  it('CodeQL site behaviour unchanged for review-held repair cases', () => {
    const codeqlFailure = { checkRunId: '456', alerts: [] };
    const held = pr({ labels: labels('review:human'), codeqlFailure, statusCheckRollup: [gate('review', {
      mergeGateReviewHold: { holds: ['review-acceptance'], jobId: 123 },
    }), check('CodeQL')] });
    const plan = run(held);
    noHeal(plan);
    refusal(plan, 'review-hold-red');
    expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', humanHandoffAdvisory: true }));
    const queued = run(pr({ labels: labels('ready-to-merge', 'review:accepted'), codeqlFailure,
      statusCheckRollup: [check('test', 'SUCCESS'), check('CodeQL')] }), { requiredChecks: ['test'] });
    heal(queued, 'real', ['real']);
    expect(queued.dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal', reason: 'codeql', codeql: codeqlFailure }));
  });
  it('a real failing test check still dispatches ci-heal with admission basis real', () => {
    heal(run(pr({ statusCheckRollup: [check('test')] }), { requiredChecks: ['test'], mainRedWindows: openWindow }),
      'real', ['real']);
  });
});
