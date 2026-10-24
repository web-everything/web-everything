// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { planReconcile as planReconcileCore } from '../reconcile-core.mjs';
// These replays select the serial policy; the default fast gate is covered below.
const planReconcile = options => planReconcileCore({ reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false }, ...options });
import { resolvePrOwnershipSettings, loadPrOwnershipSettings } from '../pr-ownership-settings.mjs';
import { ownerFor, assessPrOwnership, assessOwnership } from '../../operations/pr-ownership.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { buildAdvisoryFixComment } from '../advisory-fix-mark.mjs';
const checks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/pr-ownership/${name}.json`, import.meta.url), 'utf8'));
const before = 'pr-5157-before-ci-heal';
const escalated = 'pr-5157-ci-heal-escalated';
const unlabeled = 'pr-5172-unlabeled-red';
function replay(name, settings = {}, mutate = () => {}) {
  const fx = fixture(name); mutate(fx.pr);
  return planReconcile({ repo: 'we', prs: [fx.pr], now: Date.parse(fx.observedAt), requiredChecks: checks,
    // Isolate the incident's opt-in ownership rules. The overlay's default `stuck`
    // healer now also restores settled green orphans, covered separately below.
    reviewLabelHeal: 'green',
    advisoryReviewOnHumanHandoff: 'off', unlabeledRedAgentPr: 'off', ...settings });
}
const on = { advisoryReviewOnHumanHandoff: 'on' };
const healing = { unlabeledRedAgentPr: 'review-label', now: Date.parse(fixture(unlabeled).observedAt) + 2 * 60_000 };
const reviews = p => p.dispatch.filter(d => d.kind === 'review');
const annotate = pr => {
  const rows = pr.statusCheckRollup.filter(r => r.name === 'merge-gate');
  rows[rows.length - 1].mergeGateReviewHold = { holds: ['test-gaming'], jobId: 1 };
};

describe('cards 273 and 278 incident replays', () => {
  it('pins all three live baselines with settings off', () => {
    expect(replay(before).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
    const handed = replay(escalated);
    expect(handed.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated' }));
    expect(reviews(handed)).toEqual([]);
    expect(replay(unlabeled).refusals).toContainEqual(expect.objectContaining({ kind: 'nothing-owed', phase: 'queued' }));
  });
  it('retains the escalation and note while supplying an advisory verdict for the human', () => {
    const result = replay(escalated, on);
    const baseline = replay(escalated);
    expect(result.refusals).toContainEqual(baseline.refusals.find(r => r.kind === 'ci-heal-escalated'));
    expect(result.notes).toEqual(baseline.notes);
    // Card 273, #5157: kind review uses review-pr INVARIANT 2, which refuses human acceptance.
    expect(reviews(result)).toEqual([expect.objectContaining({ kind: 'review', labels: expect.arrayContaining(['review:human']),
      advisoryReview: { head: fixture(escalated).pr.headRefOid, reason: 'human-handoff', ciWaived: true } })]);
  });
  it('routes an annotated review hold to review, while a real merge-gate failure remains healable', () => {
    const result = replay(before, on, annotate);
    expect(result.dispatch.some(d => d.kind === 'ci-heal')).toBe(false);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'review-hold-red' }));
    expect(reviews(result)[0].advisoryReview).toMatchObject({ reason: 'review-hold', ciWaived: true });
    expect(replay(before, on).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
  });
  it.each([escalated, before])('never repeats a current advisory on %s', name => {
    const result = replay(name, on, pr => {
      if (name === before) annotate(pr);
      pr.comments.push({ author: { login: 'web-everything' }, createdAt: '2026-10-13T14:16:00Z',
        body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Accept\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${'0'.repeat(40)}..${pr.headRefOid}\`` });
    });
    expect(reviews(result)).toEqual([]);
  });
  it.each(['merge-gate', 'review-gate', 'both'])('keeps the advisory fixer reachable on a red %s hold across ticks', gate => {
    const fx = fixture(before);
    annotate(fx.pr);
    const merge = fx.pr.statusCheckRollup.filter(r => r.name === 'merge-gate').at(-1);
    if (gate === 'review-gate') merge.conclusion = 'SUCCESS';
    if (gate !== 'merge-gate') fx.pr.statusCheckRollup.filter(r => r.name === 'review-gate').at(-1).conclusion = 'FAILURE';
    const options = { repo: 'we', prs: [fx.pr], now: Date.parse(fx.observedAt),
      requiredChecks: [...checks, 'review-gate'], ...on };
    expect(reviews(planReconcile(options))).toHaveLength(1);
    fx.pr.labels = fx.pr.labels.filter(l => l.name !== 'review:pending');
    fx.pr.labels.push({ name: 'advisory:changes' });
    fx.pr.comments.push({ author: { login: 'web-everything' }, createdAt: fx.observedAt,
      body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Changes requested\n\n**Advisory outcome:** \`changes\`\n\nAdmitted finding: the test games the gate.\n\nNet basis: \`${'0'.repeat(40)}..${fx.pr.headRefOid}\`` });
    for (let tick = 1; tick <= 3; tick++) {
      const result = planReconcile({ ...options, now: options.now + tick * 60_000 });
      expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix', mode: 'advisory-fix' })]);
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'review-hold-red' }));
    }
    const capped = planReconcile({ ...options, advisoryFixCap: 0, roundCapAction: 'person' });
    expect(capped.dispatch).toEqual([]);
    expect(capped.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', capKind: 'advisory-fix' }));
    const empty = planReconcile({ ...options, prs: [{ ...fx.pr, comments: [] }] });
    expect(empty.dispatch).toEqual([]);
    expect(empty.refusals).toContainEqual(expect.objectContaining({ kind: 'no-findings' }));
    const moved = { ...fx.pr, headRefOid: 'b'.repeat(40) };
    for (const addressed of [false, true]) {
      const pr = { ...moved, comments: [...moved.comments,
        ...(addressed ? [{ author: { login: 'web-everything' }, body: buildAdvisoryFixComment({}) }] : [])] };
      const recovery = { ...options, prs: [pr], advisoryFixCap: 0, roundCapAction: 'person' };
      expect(planReconcile(recovery).dispatch).toEqual([expect.objectContaining({ kind: 'review',
        advisoryReview: { head: pr.headRefOid, reason: 'review-hold', ciWaived: true } })]);
      for (const blocker of [{ isDraft: true }, { referralHold: { kind: 'same-head', why: 'awaiting ruling' } }]) {
        expect(planReconcile({ ...recovery, prs: [{ ...pr, ...blocker }] }).dispatch).toEqual([]);
      }
    }
    fx.pr.statusCheckRollup.filter(r => r.name === 'test').at(-1).conclusion = 'FAILURE';
    expect(planReconcile(options).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal' }));
  });
  it('respects the restore grace at observation time', () => {
    expect(replay(unlabeled, { unlabeledRedAgentPr: 'review-label' }).dispatch).toEqual([]);
  });
  it('restores the review owner of the published red unlabeled PR after grace', () => {
    expect(replay(unlabeled, healing).dispatch).toContainEqual(expect.objectContaining({
      kind: 'restore-review-label', variant: 'stuck', rule: 'unlabeled-red', label: 'review:pending' }));
    expect(replay(unlabeled, healing, pr => pr.labels.push({ name: 'review:pending' })).dispatch.some(d => d.rule === 'unlabeled-red')).toBe(false);
    const green = replay(unlabeled, healing, pr => { pr.labels = pr.labels.filter(l => l.name !== 'status:ci-red'); });
    expect(green.refusals).toContainEqual(expect.objectContaining({ kind: 'nothing-owed' }));
  });
  it('folds an advisory pre-gate refusal into the original escalation', () => {
    const result = replay(escalated, on, pr => { pr.isDraft = true; });
    expect(reviews(result)).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-heal-escalated',
      reviewRefusal: expect.objectContaining({ kind: 'draft' }) }));
  });
});

it('the default stuck healer restores the settled green orphan even with ownership overrides off', () => {
  // The incident snapshot is still inside the ten-minute grace after its newest
  // completed check. The newer stuck healer must restore it once that grace ends.
  const result = replay(unlabeled, { reviewLabelHeal: 'stuck', now: healing.now });
  expect(result.dispatch).toEqual([expect.objectContaining({
    kind: 'restore-review-label', variant: 'stuck', label: 'review:pending',
  })]);
});

describe('ownership reports', () => {
  it('names the orphan and the daemon executing its planned next move', () => {
    expect(ownerFor({ phase: 'queued', unlabeledRed: true }).owner).toBe('none');
    const pr = { ...fixture(unlabeled).pr, repo: 'we', phase: 'queued', bound: [] };
    expect(assessPrOwnership(pr).owner).toBe('none');
    const plan = replay(unlabeled, healing);
    const daemons = [{ name: 'fix-dispatch', state: 'alive-and-idle' }];
    const row = assessPrOwnership(pr, { plan, daemons });
    expect(row.nextActor).toBe('fix-dispatch');
    const bareFacts = { number: pr.number, phase: 'queued', headRefName: pr.headRefName, bound: [] };
    expect(assessPrOwnership(bareFacts, { plan, daemons })).toMatchObject({ owner: 'none', nextActor: 'fix-dispatch', healthy: true });
    expect(row.flags.some(f => f.flag === 'orphan')).toBe(false);
    const report = assessOwnership({ repos: [{ repo: 'we', prs: [pr], plan }], daemons, gaps: [] });
    expect(report.summary.byNextActor['fix-dispatch']).toBe(1);
    expect(assessPrOwnership({ ...pr, phase: 'needs-human' }, { plan: { dispatch: [{ prNumber: pr.number, kind: 'review' }] } }).nextActor).toBe('review');
  });
});

describe('ownership settings cascade', () => {
  it('has standard defaults and independent overrides through every layer', () => {
    expect(resolvePrOwnershipSettings()).toEqual({ advisoryReviewOnHumanHandoff: { value: 'on', source: 'standard' },
      unlabeledRedAgentPr: { value: 'review-label', source: 'standard' } });
    for (const layer of ['platform', 'repo']) {
      expect(resolvePrOwnershipSettings({ [layer]: { prOwnership: { advisoryReviewOnHumanHandoff: 'off', unlabeledRedAgentPr: 'off' } } }))
        .toMatchObject({ advisoryReviewOnHumanHandoff: { value: 'off', source: layer }, unlabeledRedAgentPr: { value: 'off', source: layer } });
    }
    expect(resolvePrOwnershipSettings({ platform: { prOwnership: { advisoryReviewOnHumanHandoff: 'off' } },
      repo: { prOwnership: { advisoryReviewOnHumanHandoff: 'on' } } }).advisoryReviewOnHumanHandoff.source).toBe('repo');
    expect(resolvePrOwnershipSettings({ repo: { prOwnership: { advisoryReviewOnHumanHandoff: 'off' } },
      env: { WE_PR_OWNERSHIP_ADVISORY_ON_HANDOFF: 'on', WE_PR_OWNERSHIP_UNLABELED_RED: 'off' } }))
      .toMatchObject({ advisoryReviewOnHumanHandoff: { value: 'on', source: 'env' }, unlabeledRedAgentPr: { value: 'off', source: 'env' } });
  });
  it('records invalid layers without suppressing a valid preference', () => {
    const result = resolvePrOwnershipSettings({ platform: { prOwnership: { advisoryReviewOnHumanHandoff: 'bad' } },
      repo: { prOwnership: { advisoryReviewOnHumanHandoff: 'off' } }, env: { WE_PR_OWNERSHIP_ADVISORY_ON_HANDOFF: 'bad' } });
    expect(result.advisoryReviewOnHumanHandoff).toMatchObject({ value: 'off', source: 'repo',
      ignored: [{ source: 'platform', reason: expect.any(String) }, { source: 'env', reason: expect.any(String) }] });
  });
  it('loads IO layers and rejects unreadable settings', () => {
    expect(loadPrOwnershipSettings({ env: {}, readFile: () => '{}', readDeclared: () => ({ settings: {} }) }))
      .toEqual(resolvePrOwnershipSettings());
    expect(() => loadPrOwnershipSettings({ readFile: () => '{' })).toThrow();
    expect(() => loadPrOwnershipSettings({ readFile: () => '{}', readDeclared: () => ({ errors: ['bad'] }) })).toThrow();
  });
});

it('the default fast-check policy does not dispatch a CI-red advisory through the legacy waiver', () => {
  const fx = fixture(escalated);
  for (const check of fx.pr.statusCheckRollup) if (check.name === 'test') check.conclusion = 'FAILURE';
  fx.pr.statusCheckRollup.push(...['standards', 'test-shard (1)'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })));
  const result = planReconcileCore({ repo: 'we', prs: [fx.pr], now: Date.parse(fx.observedAt), requiredChecks: checks, ...on });
  expect(reviews(result)).toEqual([]);
  expect(result.refusals).toContainEqual(expect.objectContaining({ reviewRefusal: expect.objectContaining({ kind: 'review-ci' }) }));
});
