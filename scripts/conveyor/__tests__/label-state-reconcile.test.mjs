import { describe, expect, it, vi } from 'vitest';
import { planLabelStateReconcile, sweepLabelStateReconcile } from '../label-state-reconcile.mjs';
import { reviewRunEvidence } from '../review-referral-hold.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';

const repo = 'o/n', head = 'a'.repeat(40), otherHead = 'b'.repeat(40);
const comment = body => ({ author: { login: 'web-everything' }, body });
const red = (pr, rev = head, broken = false) => comment(`<!-- we:red-team-advisory pr=${pr} rev=${rev} -->\n${broken
  ? '1. [**confirmed**] (edge-case, broken) `scripts/x.mjs:1` — break' : 'ACCEPTS'}`);
const pr = (number, labels, comments = [red(number)]) => ({ number, state: 'OPEN', headRefOid: head,
  labels, comments, body: '<!-- authored-by-actor: author -->', createdAt: '2026-01-01T00:00:00Z' });
function review(number, overrides = {}) {
  return { id: 'review-pr-accepted', op: 'review-pr', findings: {
    read: { repo, pr: number, netBasis: { rev: head } },
    referralVerdict: { verdict: 'accept', pendingReferrals: [], blockedReferrals: [],
      lenses: ['correctness', 'security'], lensVerdicts: { correctness: 'accept', security: 'accept' }, ...overrides },
  }, stepTimings: [{ step: 'read', startedAt: '2026-10-26T01:00:00Z' },
    { step: 'advise', finishedAt: '2026-10-26T01:01:00Z' }] };
}
function referral(number, ruled) {
  const original = { summary: 'broken case', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const key = referralFindingKey('judge', original), runId = 'review-pr-bounced';
  const reviewer = mandatoryReferralReviewer(runId);
  return comment(renderReferralRecord({ version: 1, repo, pr: number, head, runId, reviewer,
    authorBody: '<!-- authored-by-actor: author -->', attempted: true,
    referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }],
    rulings: ruled ? [{ id: 'r1', key, reviewerId: reviewer.id, lens: 'correctness', result: 'not-real',
      rationale: 'checked', evidence: ['diff'] }] : [] }));
}

describe('planLabelStateReconcile', () => {
  it.each([5973, 5970])('#%s: ACCEPTS on the live head replaces blocked and preserves ready', number => {
    const plan = planLabelStateReconcile({ repo, pr: pr(number, ['red-team:blocked', 'red-team:pending', 'ready-to-merge']) });
    expect(plan.to).toEqual(['ready-to-merge', 'red-team:clear']);
    expect(plan.evidence.redTeam).toEqual({ id: expect.any(String), sha: head });
  });
  it('#5954: all bounced findings not-real and accepted lenses clear changes and every fix wait', () => {
    const live = pr(5954, ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy', 'fix-waiting:claim-held'],
      [referral(5954, true), red(5954)]);
    const plan = planLabelStateReconcile({ repo, pr: live, review: review(5954) });
    expect(plan.to).toEqual(['red-team:clear']);
    expect(plan.evidence.review).toEqual({ id: 'review-pr-accepted', sha: head });
    expect(planLabelStateReconcile({ repo, pr: { ...live, labels: plan.to }, review: review(5954) })).toBeNull();
  });
  it('an accepted review preserves changes and every fix wait when same-head stored red-team changes block', () => {
    const live = pr(42, ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held',
      'red-team:blocked', 'ready-to-merge']);
    const redTeam = { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: 'changes' } };
    const plan = planLabelStateReconcile({ repo, pr: live, review: review(42), redTeam });
    expect(plan.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held', 'red-team:blocked']);
    expect(plan.remove).toEqual(['ready-to-merge']);
  });
  it('an unruled finding preserves review:changes and fix wait, dropping ready', () => {
    const plan = planLabelStateReconcile({ repo, pr: pr(42, ['review:changes', 'fix-waiting:host-busy', 'ready-to-merge'],
      [referral(42, false)]), review: review(42) });
    expect(plan.to).toEqual(['review:changes', 'fix-waiting:host-busy']);
  });
  it('a confirmed red-team break on head preserves blocked and drops ready', () => {
    const plan = planLabelStateReconcile({ repo, pr: pr(42, ['red-team:blocked', 'ready-to-merge'], [red(42, head, true)]) });
    expect(plan.to).toEqual(['red-team:blocked']);
  });
  it('same-head stored changes override an ACCEPTS comment and drop ready', () => {
    const live = pr(42, ['red-team:blocked', 'red-team:pending', 'ready-to-merge']);
    const redTeam = { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: 'changes' } };
    const plan = planLabelStateReconcile({ repo, pr: live, redTeam });
    expect(plan.to).toEqual(['red-team:blocked']);
    expect(plan.add).not.toContain('red-team:clear');
    expect(plan.remove).not.toContain('red-team:blocked');
    expect(planLabelStateReconcile({ repo, pr: live, redTeam: { ...redTeam, head: otherHead } }).to)
      .toEqual(['ready-to-merge', 'red-team:clear']);
  });
  it.each(['parked resumed-unfinished', 'persistence-failed', 'incomplete'])
  ('%s review evidence preserves changes and every fix wait', kind => {
    const stored = review(42);
    stored.stepTimings = stored.stepTimings.filter(t => t.step !== 'advise');
    if (kind !== 'incomplete') stored.resumeOf = {
      adviseFinishedAt: '2026-10-26T01:01:00Z',
      verdict: { verdict: kind === 'persistence-failed' ? 'accept' : 'needs-human',
        pendingReferrals: [kind === 'persistence-failed' ? 'referral-persistence-failed' : 'finding-key'] },
    };
    const live = pr(42, ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held'], []);
    expect(reviewRunEvidence(stored)).toMatchObject(kind === 'incomplete' ? { incomplete: true }
      : kind === 'persistence-failed' ? { parked: false, persistenceFailed: true } : { parked: true });
    expect(planLabelStateReconcile({ repo, pr: live, review: stored })).toBeNull();
  });
  it('a result on another head cannot clear blocked beside a current unruled review', () => {
    const plan = planLabelStateReconcile({ repo, review: review(42), pr: pr(42,
      ['review:changes', 'red-team:blocked', 'ready-to-merge'], [red(42, otherHead), referral(42, false)]) });
    expect(plan.to).toEqual(['review:changes', 'red-team:blocked']);
  });
  it.each(['missing', 'head-mismatch', 'forged'])('%s evidence makes no change', kind => {
    const stored = review(42);
    stored.findings.read.netBasis.rev = otherHead;
    const comments = kind === 'missing' ? [] : [kind === 'forged'
      ? { ...red(42), author: { login: 'attacker' } } : red(42, otherHead)];
    expect(planLabelStateReconcile({ repo, pr: pr(42, ['red-team:blocked', 'review:changes', 'ready-to-merge'], comments),
      review: kind === 'missing' ? null : stored })).toBeNull();
  });
  it('finished stored red-team status is usable only with matching repo, PR and SHA', () => {
    const live = pr(42, ['red-team:blocked'], []);
    const status = { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: 'accept' } };
    expect(planLabelStateReconcile({ repo, pr: live, redTeam: status }).to).toEqual(['red-team:clear']);
    expect(planLabelStateReconcile({ repo, pr: live, redTeam: { ...status, head: otherHead } })).toBeNull();
  });
});

describe('sweepLabelStateReconcile', () => {
  function fixture() {
    const live = pr(5954, ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy'], [referral(5954, true), red(5954)]);
    const stored = review(5954);
    const provider = { setLabels: vi.fn(), ensureLabel: vi.fn() }, emit = vi.fn();
    return { repo, prs: [live], provider, emit, readPr: vi.fn(() => live), readComments: () => live.comments,
      readReviews: () => [reviewRunEvidence(stored)], readReview: () => stored, readRedTeam: () => null };
  }
  it('writes through the shared provider and emits before/after with result IDs and SHA only on changes', () => {
    const io = fixture(), [row] = sweepLabelStateReconcile(io);
    expect(io.provider.ensureLabel).toHaveBeenCalledWith(repo, 'red-team:clear', expect.any(Object));
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954, {
      add: 'red-team:clear', remove: ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy'] });
    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith({ kind: 'labels-reconciled', repo, pr: 5954,
      detail: { pr: 5954, from: row.labelsReconciled.from, to: ['red-team:clear'], evidence: row.labelsReconciled.evidence } });
    io.prs[0].labels = row.labelsReconciled.to;
    expect(sweepLabelStateReconcile(io)).toEqual([]);
    expect(io.emit).toHaveBeenCalledTimes(1);
  });
  it('dryRun plans the change without label writes, provisioning or events', () => {
    const io = fixture();
    expect(sweepLabelStateReconcile({ ...io, dryRun: true })[0].dryRun).toBe(true);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.provider.ensureLabel).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
  it('an unreadable complete thread leaves labels untouched', () => {
    const io = fixture();
    const rows = sweepLabelStateReconcile({ ...io, readComments: () => { throw Error('incomplete thread'); } });
    expect(rows[0].error).toBe('incomplete thread');
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
  it('a head move during the evidence reads leaves labels untouched', () => {
    const io = fixture();
    io.readPr.mockReturnValueOnce(io.prs[0]).mockReturnValueOnce({ ...io.prs[0], headRefOid: otherHead });
    expect(sweepLabelStateReconcile(io)).toEqual([]);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
  it('a failed label write does not emit a change event', () => {
    const io = fixture(); io.provider.setLabels.mockImplementation(() => { throw Error('write failed'); });
    expect(sweepLabelStateReconcile(io)[0].error).toBe('write failed');
    expect(io.emit).not.toHaveBeenCalled();
  });
  it('unreadable local stores and no published result make no change', () => {
    const io = fixture(); io.prs[0].comments = [];
    expect(sweepLabelStateReconcile({ ...io, readReviews: () => { throw Error('unreadable'); },
      readRedTeam: () => { throw Error('unreadable'); } })).toEqual([]);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
  });
});
