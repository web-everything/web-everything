// Run natively with node:test, and participate in the repository's Vitest glob.
const { test } = await import(process.env.VITEST ? 'vitest' : 'node:test');
import assert from 'node:assert/strict';
import { GATE_IDS } from '../../lib/merge-gate-inventory.mjs';
import { formatPrResult } from '../../lib/merge-gate-verdict.mjs';
import { excusePrMergeGateHolds, readMergeGateVerdict } from '../../lib/merge-gate-hold-class.mjs';
import { waitingOnReview, gateOnlyRedStates, requiredCheckStates } from '../ci-heal-verdict-recheck.mjs';
import { planReconcile, reviewHoldGatesOnlyRed, reviewHoldOnlyRed } from '../reconcile-core.mjs';
import { buildCandidates, sweepCiRedRecovery } from '../ci-red-recovery-watch.mjs';
import { buildCiHealEscalationComment, checkNeedsHumanEscalable } from '../ci-heal-escalation-mark.mjs';
import { planNeedsHumanVoid, runReconcileNotesAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const HEAD = 'a'.repeat(40);
const requiredChecks = ['test', 'merge-gate']; // review-gate is deliberately outside branch protection.
const settings = { recheckNotCiBreak: true, voidNeedsHumanWhenCiGreen: true };
const check = (name, conclusion = 'SUCCESS', extra = {}) => ({
  name, status: 'COMPLETED', conclusion, completedAt: '2026-11-17T22:40:00Z', ...extra,
});
const rawPr = (labels = ['review:pending']) => ({
  number: 7037, state: 'OPEN', headRefOid: HEAD, headRefName: 'lane/workflow-edit',
  mergeStateStatus: 'UNSTABLE', labels: labels.map(name => ({ name })), comments: [],
  statusCheckRollup: [check('test'), check('merge-gate', 'FAILURE', {
    detailsUrl: 'https://github.com/web-everything/web-everything/actions/runs/1/job/123',
  }), check('review-gate', 'FAILURE', { output: { summary: 'check-review-gate held - a review hold stands: review:pending, review:human, review:changes, review:held-mechanical' } })],
});
const log = (extra = []) => {
  const overrides = new Map([
    ['review-acceptance', { status: 'hold', reason: 'human-only: workflow files require clear-human at this exact head' }],
    ...extra.map(row => [row.id, row]),
  ]);
  return `${formatPrResult({ num: 7037, ok: false, results: GATE_IDS.map(id => ({
    id, status: 'pass', reason: 'ok', ...overrides.get(id),
  })) })}\nmerge-gate: HOLD — held\n`;
};
const classified = ({ labels, text = log(), head = HEAD } = {}) => excusePrMergeGateHolds([rawPr(labels)], {
  repo: 'web-everything/web-everything', mergeGateSetting: 'on',
  readMergeGateVerdict: args => readMergeGateVerdict({ ...args, cache: new Map(), runGh: argv =>
    argv[1].endsWith('/logs') ? text : JSON.stringify({ head_sha: head }) }),
})[0];
const plan = pr => planReconcile({ prs: [pr], agents: [], requiredChecks, verdictSettings: settings,
  shadowDeps: { mode: 'off' },
  now: Date.parse('2026-11-17T22:45:00Z'), advisoryReviewOnHumanHandoff: 'off' });
const escalable = pr => checkNeedsHumanEscalable({ pr: pr.number, headSha: HEAD, outcome: 'needs-human',
  settings, readPr: () => pr, readRequired: () => ({ checks: requiredChecks }) });

test('approval-wait only -> waiting-on-review, gate stays red, no heal or escalation', async () => {
  for (const labels of [['review:pending'], ['review:human'], ['review:changes'], ['review:held-mechanical']]) {
    const pr = classified({ labels });
    assert.equal(pr.statusCheckRollup[1].conclusion, 'FAILURE');
    assert.deepEqual(pr.statusCheckRollup[1].mergeGateReviewHold.holds, ['review-acceptance']);
    assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), true);
    const result = plan(pr);
    assert.equal(result.dispatch.some(row => row.kind === 'ci-heal'), false);
    assert.ok(result.refusals.some(row => row.ciClassification === 'waiting-on-review'
      && row.owner === 'review/orchestrator'));
    assert.ok((await escalable(pr)).refusal);
    assert.deepEqual(buildCandidates([pr], { requiredChecks, readAheadBy: () => 0 }), []);
  }
});

test('no review hold label -> heals and remains a recovery candidate despite proven gate holds', () => {
  for (const labels of [[], ['review:accepted'], ['review:awaiting-advisory']]) {
    const pr = classified({ labels });
    assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), false);
    const result = plan(pr);
    assert.ok(result.dispatch.some(row => row.kind === 'ci-heal'));
    assert.equal(result.refusals.some(row => row.ciClassification === 'waiting-on-review'), false);
    assert.equal(buildCandidates([pr], { requiredChecks, readAheadBy: () => 0 }).length, 1);
  }
});

test('review-gate STARTUP_FAILURE -> stays red, heals and remains a recovery candidate with review:pending', () => {
  const pr = classified();
  pr.statusCheckRollup[2].conclusion = 'STARTUP_FAILURE';
  assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), false);
  const result = plan(pr);
  assert.ok(result.dispatch.some(row => row.kind === 'ci-heal'));
  assert.equal(result.refusals.some(row => row.ciClassification === 'waiting-on-review'), false);
  assert.equal(buildCandidates([pr], { requiredChecks, readAheadBy: () => 0 }).length, 1);
});

test('review-gate completed FAILURE with its own hold output and review:pending -> waiting-on-review', () => {
  const pr = classified();
  pr.statusCheckRollup[1] = check('merge-gate');
  assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), true);
  const result = plan(pr);
  assert.equal(result.dispatch.some(row => row.kind === 'ci-heal'), false);
  assert.ok(result.refusals.some(row => row.ciClassification === 'waiting-on-review'));
  assert.deepEqual(buildCandidates([pr], { requiredChecks, readAheadBy: () => 0 }), []);
});

test('review-gate setup FAILURE or unreadable cause with review:pending -> heal and escalation stay available', async () => {
  for (const output of [undefined, { summary: 'actions/checkout failed' },
    { summary: 'actions/setup-node failed' }, { summary: 'npm ci failed' }]) {
    const pr = classified();
    pr.statusCheckRollup[2].output = output;
    assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), false);
    const result = plan(pr);
    assert.ok(result.dispatch.some(row => row.kind === 'ci-heal'));
    assert.equal(result.refusals.some(row => row.ciClassification === 'waiting-on-review'), false);
    assert.equal((await escalable(pr)).refusal, null);
    // review-gate itself is outside this fixture's roster; its unknown failure
    // must still prevent retiring an existing escalation.
    pr.comments = [{ author: { login: 'web-everything' }, body: buildCiHealEscalationComment({
      headSha: HEAD, outcome: 'needs-human', reason: 'review-gate failed during setup',
    }) }];
    assert.equal(plan(pr).notes.some(row => row.kind === 'ci-heal-escalation-moot'), false);
  }
});

test('approval-wait plus a real red test -> heal and escalation remain available', async () => {
  const pr = classified();
  pr.statusCheckRollup[0].conclusion = 'FAILURE';
  assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), false);
  assert.ok(plan(pr).dispatch.some(row => row.kind === 'ci-heal'));
  assert.equal((await escalable(pr)).refusal, null);
  assert.equal(buildCandidates([pr], { requiredChecks, readAheadBy: () => 0 }).length, 1);
});

test('same-name review gates from different workflows/suites or unknown sources retain unreadable failures and heal', async () => {
  for (const sources of [
    [{ workflowName: 'main-ci' }, { workflowName: 'review' }],
    [{ checkSuite: { id: 'suite-a' } }, { checkSuite: { id: 'suite-b' } }],
    [{ workflowName: 'review', check_suite: { id: 1 } }, { workflowName: 'review', check_suite: { id: 2 } }],
    [{}, {}],
  ]) {
    for (const reverse of [false, true]) {
      const pr = classified();
      const rows = [
        check('review-gate', 'FAILURE', { id: 10, ...sources[0] }),
        { ...pr.statusCheckRollup[2], id: 20, ...sources[1] },
      ];
      pr.statusCheckRollup.splice(2, 1, ...(reverse ? rows.toReversed() : rows));
      const evidence = { rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels };
      assert.equal(waitingOnReview(evidence), false);
      assert.equal(gateOnlyRedStates(evidence).gateOnlyRed, false);
      assert.equal(reviewHoldGatesOnlyRed(pr.statusCheckRollup, requiredChecks, pr.labels), false);
      assert.equal(reviewHoldOnlyRed(pr.statusCheckRollup, requiredChecks, pr.labels), false);
      const result = plan(pr);
      assert.ok(result.dispatch.some(row => row.kind === 'ci-heal'));
      assert.equal(result.refusals.some(row => row.ciClassification === 'waiting-on-review'), false);
      assert.equal((await escalable(pr)).refusal, null);
      assert.equal(buildCandidates([pr], { requiredChecks, readAheadBy: () => 0 }).length, 1);
    }
  }
});

test('a newer successful rerun of the same identifiable job supersedes its older failure and is not red', () => {
  for (const source of [{ workflowName: 'review' }, { check_suite: { id: 42 } }]) {
    for (const reverse of [false, true]) {
      const pr = classified();
      const rows = [
        check('review-gate', 'FAILURE', { id: 10, ...source }),
        check('review-gate', 'SUCCESS', { id: 20, ...source }),
      ];
      pr.statusCheckRollup = [check('test'), check('merge-gate'), ...(reverse ? rows.toReversed() : rows)];
      const evidence = { rollup: pr.statusCheckRollup, requiredChecks: [...requiredChecks, 'review-gate'], labels: pr.labels };
      assert.deepEqual(requiredCheckStates(evidence).red, []);
      assert.deepEqual(gateOnlyRedStates(evidence).red, []);
      assert.equal(waitingOnReview(evidence), false);
      assert.equal(plan(pr).dispatch.some(row => row.kind === 'ci-heal'), false);
      assert.deepEqual(buildCandidates([pr], { requiredChecks: evidence.requiredChecks, readAheadBy: () => 0 }), []);
    }
  }
});

test('the escalation CLI applies the same head-bound verdict annotation before recording', async () => {
  const pr = rawPr();
  const refusal = await checkNeedsHumanEscalable({ pr: pr.number, headSha: HEAD, outcome: 'needs-human', settings,
    prChecksOptions: { runGh: () => JSON.stringify(pr), mergeGateSetting: 'on',
      readMergeGateVerdict: args => readMergeGateVerdict({ ...args, cache: new Map(), runGh: argv =>
        argv[1].endsWith('/logs') ? log() : JSON.stringify({ head_sha: HEAD }) }) },
    readRequired: () => ({ checks: requiredChecks }),
  });
  assert.ok(refusal.refusal);
});

test('review:human plus a test-gaming hold also belongs to review (#6938 shape)', () => {
  const pr = classified({ labels: ['review:human'], text: log([
    { id: 'review-acceptance', status: 'hold', reason: 'park: human-gated (review:human)' },
    { id: 'test-gaming', status: 'hold', reason: 'human clearance required' },
  ]) });
  assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), true);
  assert.equal(plan(pr).dispatch.some(row => row.kind === 'ci-heal'), false);
});

test('recovery watch builds candidates from annotated evidence, not the raw PR read', () => {
  let classifiedReads = 0;
  const result = sweepCiRedRecovery({ repo: 'web-everything/web-everything',
    readOpenPrs: () => [rawPr()],
    excuseHolds: prs => { classifiedReads++; assert.equal(prs[0].number, 7037); return [classified()]; },
    readAttributedRequiredChecks: () => requiredChecks,
    readMainRuns: () => [], readMainLatestCheckRuns: () => [], readPriority: () => null,
    readAheadBy: () => assert.fail('a review-only hold must never become a recovery candidate'),
  });
  assert.equal(classifiedReads, 1);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.dispatch, []);
});

test('CodeQL or any real/fail-closed verdict gate -> heal/escalate', async () => {
  for (const row of [{ id: 'codeql', status: 'hold' }, { id: 'review-acceptance', status: 'fail-closed' },
    { id: 'freshness', status: 'hold' }]) {
    const pr = classified({ text: log([{ ...row, reason: 'real failure' }]) });
    assert.equal(pr.statusCheckRollup[1].mergeGateReviewHold, undefined);
    assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), false);
    assert.ok(plan(pr).dispatch.some(row => row.kind === 'ci-heal'));
    assert.equal((await escalable(pr)).refusal, null);
  }
});

test('unreadable or stale-head verdict -> stays red and heal/escalation remain available', async () => {
  for (const options of [{ text: 'unreadable job log' }, { text: log().replace('HOLD — held', 'HOLD — workflow self-check failed') },
    { head: 'b'.repeat(40) }]) {
    const pr = classified(options);
    assert.equal(pr.statusCheckRollup[1].conclusion, 'FAILURE');
    assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), false);
    assert.ok(plan(pr).dispatch.some(row => row.kind === 'ci-heal'));
    assert.equal((await escalable(pr)).refusal, null);
  }
});

test('a real red or unreadable check outside the required roster also prevents a review-wait claim', async () => {
  for (const conclusion of ['FAILURE', null]) {
    const pr = classified();
    pr.statusCheckRollup.push(check('CodeQL', conclusion));
    assert.equal(waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels }), false);
    assert.equal((await escalable(pr)).refusal, null);
    assert.equal(plan(pr).refusals.some(row => row.ciClassification === 'waiting-on-review'), false);
  }
});

test('already-escalated approval-wait head retires its CI escalation and raises no needs-you note', () => {
  const pr = classified();
  pr.comments = [{ author: { login: 'web-everything' }, body: buildCiHealEscalationComment({
    headSha: HEAD, outcome: 'needs-human', reason: 'merge-gate and review-gate red only from the review hold',
  }) }];
  const result = plan(pr);
  assert.equal(result.notes.some(row => row.kind === 'ci-heal-escalated'), false);
  const note = result.notes.find(row => row.kind === 'ci-heal-escalation-moot');
  assert.ok(note);
  const voidRow = planNeedsHumanVoid({ note, pr, repo: 'we', verdictSettings: settings,
    readRequiredChecks: () => requiredChecks });
  assert.equal(voidRow.kind, 'ci-heal-needs-human-void');
  const published = [], posted = [];
  runReconcileNotesAllRepos({ repos: ['we'], dryRun: false, verdictSettings: settings,
    tick: () => ({ ...result, prsByNumber: new Map([[pr.number, pr]]) }),
    readRequiredChecks: () => requiredChecks, publish: event => published.push(event),
    postComment: input => { posted.push(input); return { ok: true }; },
  });
  assert.deepEqual(published, []);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.includes('needs-human'));
  // Unknown merge-gate evidence outside branch protection must not retire the old alert either.
  const unknown = { ...pr, statusCheckRollup: rawPr().statusCheckRollup };
  assert.equal(planNeedsHumanVoid({ note, pr: unknown, repo: 'we', verdictSettings: settings,
    readRequiredChecks: () => ['test'] }), null);
});
