// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { resolvePrOwnershipSettings, loadPrOwnershipSettings } from '../pr-ownership-settings.mjs';
import { ownerFor, assessPrOwnership, assessOwnership } from '../../operations/pr-ownership.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
const checks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/pr-ownership/${name}.json`, import.meta.url), 'utf8'));
const before = 'pr-5157-before-ci-heal';
const escalated = 'pr-5157-ci-heal-escalated';
const unlabeled = 'pr-5172-unlabeled-red';
function replay(name, settings = {}, mutate = () => {}) {
  const fx = fixture(name); mutate(fx.pr);
  return planReconcile({ repo: 'we', prs: [fx.pr], now: Date.parse(fx.observedAt), requiredChecks: checks,
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
