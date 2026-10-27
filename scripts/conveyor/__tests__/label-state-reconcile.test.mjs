import { describe, expect, it, vi } from 'vitest';
import { planLabelStateReconcile, sweepLabelStateReconcile } from '../label-state-reconcile.mjs';
import { reviewRunEvidence } from '../review-referral-hold.mjs';
import { planRecordDecision } from '../../operations/review-pr.mjs';
import { defaultReadPr } from '../advisory-label-sweep.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';

const repo = 'o/n', head = 'a'.repeat(40), otherHead = 'b'.repeat(40);
const comment = body => ({ author: { login: 'web-everything' }, body });
const red = (pr, rev = head, broken = false) => comment(`<!-- we:red-team-advisory pr=${pr} rev=${rev} -->\n${broken
  ? '1. [**confirmed**] (edge-case, broken) `scripts/x.mjs:1` — break' : 'ACCEPTS'}`);
const pr = (number, labels, comments = [red(number)]) => ({ number, state: 'OPEN', headRefOid: head,
  labels, comments, body: '<!-- authored-by-actor: author -->', createdAt: '2026-01-01T00:00:00Z' });
// A read native-review channel with no reviews; `reviews: null` (unreadable) is tested explicitly.
const planOf = args => planLabelStateReconcile({ reviews: [], ...args });
function review(number, overrides = {}) {
  return { id: 'review-pr-accepted', op: 'review-pr', findings: {
    read: { repo, pr: number, netBasis: { rev: head } }, confirm: 'accept',
    record: { applied: true, effects: [{ type: 'review.label-swap', status: 'applied' }] },
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
  it.each(['failed', 'pending', 'missing', 'advisory-only', 'stack-only'])
  ('%s publication cannot authorize clearing review holds', kind => {
    const stored = review(42);
    stored.input = { actor: 'author' };
    stored.findings.record = { applied: false, effects: [{ type: 'review.label-swap', status: kind,
      error: 'accepting actor matches PR author' }] };
    if (kind === 'missing') delete stored.findings.record;
    if (kind === 'advisory-only' || kind === 'stack-only') stored.findings.record = { applied: true,
      effects: [{ type: kind === 'advisory-only' ? 'review.advisory-note' : 'review.stack-hold', status: 'applied' }] };
    expect(reviewRunEvidence(stored)).toMatchObject({ completedAt: expect.any(Number), parked: false,
      persistenceFailed: false });
    expect(planOf({ repo, pr: pr(42, ['review:changes', 'fix-waiting:host-busy'], []), review: stored })).toBeNull();
  });
  it.each(['updatedAt', 'updated_at', 'missing', 'invalid', 'same-time'])
  ('an older objection with %s edit timing retains holds', kind => {
    const objection = { ...comment('🔁 review — changes requested'), createdAt: '2026-10-26T00:59:00Z' };
    if (kind === 'updatedAt' || kind === 'updated_at') objection[kind] = '2026-10-26T01:02:00Z';
    if (kind === 'invalid') objection.updatedAt = 'invalid';
    if (kind === 'same-time') objection.updatedAt = '2026-10-26T01:00:00Z';
    expect(planOf({ repo, pr: pr(42, ['review:changes', 'fix-waiting:host-busy'], [objection]),
      review: review(42) })).toBeNull();
  });
  it.each([5973, 5970])('#%s: ACCEPTS on the live head replaces blocked and preserves ready', number => {
    const plan = planOf({ repo, pr: pr(number, ['red-team:blocked', 'red-team:pending', 'ready-to-merge']) });
    expect(plan.to).toEqual(['ready-to-merge', 'red-team:clear']);
    expect(plan.evidence.redTeam).toEqual({ id: expect.any(String), sha: head });
  });
  it('#5954: all bounced findings not-real and accepted lenses clear changes and every fix wait', () => {
    const live = pr(5954, ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy', 'fix-waiting:claim-held'],
      [referral(5954, true), red(5954)]);
    const plan = planOf({ repo, pr: live, review: review(5954) });
    expect(plan.to).toEqual(['red-team:clear']);
    expect(plan.evidence.review).toEqual({ id: 'review-pr-accepted', sha: head });
    expect(planOf({ repo, pr: { ...live, labels: plan.to }, review: review(5954) })).toBeNull();
  });
  it('an accepted review preserves changes and every fix wait when same-head stored red-team changes block', () => {
    const live = pr(42, ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held',
      'red-team:blocked', 'ready-to-merge']);
    const redTeam = { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: 'changes' } };
    const plan = planOf({ repo, pr: live, review: review(42), redTeam });
    expect(plan.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held', 'red-team:blocked']);
    expect(plan.remove).toEqual(['ready-to-merge']);
  });
  it('an unruled finding preserves review:changes and fix wait, dropping ready', () => {
    const plan = planOf({ repo, pr: pr(42, ['review:changes', 'fix-waiting:host-busy', 'ready-to-merge'],
      [referral(42, false)]), review: review(42) });
    expect(plan.to).toEqual(['review:changes', 'fix-waiting:host-busy']);
  });
  it('an explicit changes confirmation overrides the accepted panel and drops ready', () => {
    const stored = review(42);
    stored.findings.confirm = 'changes';
    stored.input = { reason: 'operator confirmed a remaining blocker' };
    const plan = planOf({ repo, pr: pr(42,
      ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held', 'ready-to-merge'], []), review: stored });
    expect(plan.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held']);
    expect(plan.remove).toEqual(['ready-to-merge']);
  });
  it('a superseding explicit accept can clear a previously confirmed changes decision', () => {
    const stored = review(42);
    stored.findings.confirm = 'accept';
    expect(planOf({ repo, pr: pr(42,
      ['review:changes', 'fix-waiting:host-busy'], []), review: stored }).to).toEqual([]);
  });
  it.each(['🔁 review — changes requested', '🔁 human review — changes requested'])
  ('a later trusted %s preserves holds until a newer accepted run', heading => {
    const stored = review(42);
    const observed = reviewRunEvidence(stored);
    expect(observed.completedAt).toBe(Date.parse('2026-10-26T01:01:00Z'));
    const verdict = { author: { login: 'chalbert' }, body: `${heading}\nRemaining blocker`,
      createdAt: '2026-10-26T01:02:00Z', updatedAt: '2026-10-26T01:02:00Z' };
    const live = pr(42, ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held', 'ready-to-merge'], [verdict]);
    expect(planOf({ repo, pr: live, review: stored }).to)
      .toEqual(['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held']);
    stored.findings.confirm = 'accept';
    stored.stepTimings = [{ step: 'read', startedAt: '2026-10-26T01:03:00Z' },
      { step: 'advise', finishedAt: '2026-10-26T01:04:00Z' }];
    expect(reviewRunEvidence(stored).completedAt).toBeGreaterThan(Date.parse(verdict.createdAt));
    expect(planOf({ repo, pr: live, review: stored }).to).toEqual(['ready-to-merge']);
  });
  it.each(['missing', 'invalid', 'same-time', 'during-run', 'REST'])
  ('a trusted changes verdict with %s timing cannot be cleared by the stored accept', kind => {
    const verdict = comment('🔁 review — changes requested\nRemaining blocker');
    if (kind === 'invalid') verdict.createdAt = 'invalid';
    // The run read the thread at 01:00:00 and finished advise at 01:01:00; it never saw either verdict.
    if (kind === 'same-time') verdict.createdAt = verdict.updatedAt = '2026-10-26T01:00:00Z';
    if (kind === 'during-run') verdict.createdAt = verdict.updatedAt = '2026-10-26T01:00:30Z';
    if (kind === 'REST') {
      delete verdict.author;
      verdict.user = { login: 'chalbert' };
      verdict.created_at = verdict.updated_at = '2026-10-26T01:02:00Z';
    }
    expect(planOf({ repo, pr: pr(42,
      ['review:changes', 'fix-waiting:host-busy'], [verdict]), review: review(42) })).toBeNull();
  });
  it.each(['older', 'untrusted', 'quoted'])('%s changes text cannot veto a settled accept', kind => {
    const verdict = { ...comment('🔁 review — changes requested'), createdAt: '2026-10-26T01:02:00Z' };
    if (kind === 'older') verdict.createdAt = verdict.updatedAt = '2026-10-26T00:59:00Z';
    if (kind === 'untrusted') verdict.author.login = 'attacker';
    if (kind === 'quoted') verdict.body = `Quoted example:\n${verdict.body}`;
    expect(planOf({ repo, pr: pr(42,
      ['review:changes', 'fix-waiting:host-busy'], [verdict]), review: review(42) }).to).toEqual([]);
  });
  it('abstain records nothing and the accepted panel cannot remove review holds', () => {
    const stored = review(42);
    stored.findings.confirm = 'abstain';
    expect(planRecordDecision(stored)).toEqual({ abstain: true });
    expect(reviewRunEvidence(stored)).toMatchObject({ completedAt: expect.any(Number), parked: false,
      persistenceFailed: false });
    expect(planOf({ repo, pr: pr(42,
      ['review:changes', 'fix-waiting:host-busy', 'fix-waiting:claim-held', 'ready-to-merge'], []), review: stored }))
      .toBeNull();
  });
  it('an unanswered confirmation preserves review holds, so a later abstain has nothing to restore', () => {
    const stored = review(42);
    delete stored.findings.confirm;
    expect(reviewRunEvidence(stored)).toMatchObject({ completedAt: expect.any(Number), parked: false,
      persistenceFailed: false });
    expect(planOf({ repo, pr: pr(42,
      ['review:changes', 'fix-waiting:host-busy', 'ready-to-merge'], []), review: stored })).toBeNull();
    stored.findings.confirm = 'abstain';
    expect(planRecordDecision(stored)).toEqual({ abstain: true });
  });
  it.each([['CHANGES_REQUESTED', '01:02'], ['COMMENTED', '01:02'], ['CHANGES_REQUESTED', '01:00:30']])
  ('a later native %s review (%s, after the run read the thread) preserves holds and drops ready', (state, time) => {
    const reviews = [{ state, user: { login: 'chalbert' }, submitted_at: `2026-10-26T${time.padEnd(8, ':00')}Z` }];
    expect(planOf({ repo, reviews, pr: pr(42,
      ['review:changes', 'fix-waiting:host-busy', 'ready-to-merge'], []), review: review(42) }).to)
      .toEqual(['review:changes', 'fix-waiting:host-busy']);
  });
  it('a standing older native CHANGES_REQUESTED review preserves holds', () => {
    const reviews = [{ state: 'CHANGES_REQUESTED', user: { login: 'chalbert' }, submitted_at: '2026-10-26T00:00:00Z' }];
    expect(planOf({ repo, reviews, pr: pr(42, ['review:changes', 'fix-waiting:host-busy'], []),
      review: review(42) })).toBeNull();
  });
  it('an approval superseding an older native change request permits clearance', () => {
    const reviews = [{ state: 'CHANGES_REQUESTED', user: { login: 'chalbert' }, submitted_at: '2026-10-26T00:00:00Z' },
      { state: 'APPROVED', user: { login: 'chalbert' }, submitted_at: '2026-10-26T00:30:00Z' }];
    expect(planOf({ repo, reviews, pr: pr(42, ['review:changes', 'fix-waiting:host-busy'], []),
      review: review(42) }).to).toEqual([]);
  });
  it.each([null, undefined])('unreadable native reviews (%s) cannot clear review holds', reviews => {
    expect(planLabelStateReconcile({ repo, reviews, pr: pr(42, ['review:changes', 'fix-waiting:host-busy'], []),
      review: review(42) })).toBeNull();
  });
  it('an explicit accept cannot bypass unresolved referrals', () => {
    const stored = review(42);
    stored.findings.confirm = 'accept';
    expect(planOf({ repo, pr: pr(42,
      ['review:changes', 'fix-waiting:host-busy', 'ready-to-merge'], [referral(42, false)]), review: stored }).to)
      .toEqual(['review:changes', 'fix-waiting:host-busy']);
  });
  it('a confirmed red-team break on head preserves blocked and drops ready', () => {
    const plan = planOf({ repo, pr: pr(42, ['red-team:blocked', 'ready-to-merge'], [red(42, head, true)]) });
    expect(plan.to).toEqual(['red-team:blocked']);
  });
  it('same-head stored changes override an ACCEPTS comment and drop ready', () => {
    const live = pr(42, ['red-team:blocked', 'red-team:pending', 'ready-to-merge']);
    const redTeam = { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: 'changes' } };
    const plan = planOf({ repo, pr: live, redTeam });
    expect(plan.to).toEqual(['red-team:blocked']);
    expect(plan.add).not.toContain('red-team:clear');
    expect(plan.remove).not.toContain('red-team:blocked');
    expect(planOf({ repo, pr: live, redTeam: { ...redTeam, head: otherHead } }).to)
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
    expect(planOf({ repo, pr: live, review: stored })).toBeNull();
  });
  it('a result on another head cannot clear blocked beside a current unruled review', () => {
    const plan = planOf({ repo, review: review(42), pr: pr(42,
      ['review:changes', 'red-team:blocked', 'ready-to-merge'], [red(42, otherHead), referral(42, false)]) });
    expect(plan.to).toEqual(['review:changes', 'red-team:blocked']);
  });
  it.each(['missing', 'head-mismatch', 'forged'])('%s evidence makes no change', kind => {
    const stored = review(42);
    stored.findings.read.netBasis.rev = otherHead;
    const comments = kind === 'missing' ? [] : [kind === 'forged'
      ? { ...red(42), author: { login: 'attacker' } } : red(42, otherHead)];
    expect(planOf({ repo, pr: pr(42, ['red-team:blocked', 'review:changes', 'ready-to-merge'], comments),
      review: kind === 'missing' ? null : stored })).toBeNull();
  });
  it('finished stored red-team status is usable only with matching repo, PR and SHA', () => {
    const live = pr(42, ['red-team:blocked'], []);
    const status = { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: 'accept' } };
    expect(planOf({ repo, pr: live, redTeam: status }).to).toEqual(['red-team:clear']);
    expect(planOf({ repo, pr: live, redTeam: { ...status, head: otherHead } })).toBeNull();
  });
});

describe('sweepLabelStateReconcile', () => {
  function fixture() {
    const live = pr(5954, ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy'], [referral(5954, true), red(5954)]);
    const stored = review(5954);
    const provider = { setLabels: vi.fn(), ensureLabel: vi.fn(), readPrReviews: vi.fn(() => []) }, emit = vi.fn();
    return { repo, prs: [live], provider, emit, readPr: vi.fn(() => live), readComments: () => live.comments,
      readReviews: () => [reviewRunEvidence(stored)], readReview: () => stored, readRedTeam: () => null };
  }
  it('a failed self-acceptance record preserves holds through the sweep', () => {
    const io = fixture(), stored = review(5954);
    stored.input = { actor: 'author' };
    delete stored.findings.record;
    stored.effects = [{ step: 'record', type: 'review.label-swap', status: 'failed',
      error: 'accepting actor matches PR author' }];
    io.readReview = () => stored;
    const [row] = sweepLabelStateReconcile(io);
    expect(row.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:clear']);
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954, {
      add: 'red-team:clear', remove: ['red-team:blocked'] });
  });
  it('an old comment edited into changes before the final write preserves holds', () => {
    const io = fixture(), live = io.prs[0];
    const old = { ...comment('Operator note'), createdAt: '2026-10-26T00:59:00Z',
      updatedAt: '2026-10-26T00:59:00Z' };
    let reads = 0;
    io.readComments = () => [...live.comments, ++reads > 1 ? { ...old,
      body: '🔁 review — changes requested', updatedAt: '2026-10-26T01:02:00Z' } : old];
    const [row] = sweepLabelStateReconcile(io);
    expect(row.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:clear']);
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954, {
      add: 'red-team:clear', remove: ['red-team:blocked'] });
  });
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
  it('the production PR reader supplies author metadata so settled referrals clear changes', () => {
    const io = fixture(), live = io.prs[0];
    const exec = vi.fn((_cmd, argv) => JSON.stringify(Object.fromEntries(
      argv[argv.indexOf('--json') + 1].split(',').map(field => [field, live[field]]))));
    io.readPr = args => defaultReadPr({ ...args, exec, readComments: io.readComments });
    expect(sweepLabelStateReconcile(io)[0]?.labelsReconciled.to).toEqual(['red-team:clear']);
    expect(exec.mock.calls[0][1].at(-1)).toBe('number,state,headRefOid,labels,body,createdAt');
    expect(exec.mock.calls[1][1].at(-1)).toBe('number,state,headRefOid,labels,body,createdAt');
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954, {
      add: 'red-team:clear', remove: ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy'] });
  });
  it.each(['later-changes', 'abstain'])('the sweep preserves review holds for %s despite an accepted panel', kind => {
    const io = fixture(), stored = review(5954);
    if (kind === 'abstain') stored.findings.confirm = 'abstain';
    else io.prs[0].comments.push({ ...comment('🔁 review — changes requested\nRemaining blocker'),
      createdAt: '2026-10-26T01:02:00Z' });
    io.readReviews = () => [reviewRunEvidence(stored)];
    io.readReview = () => stored;
    const [row] = sweepLabelStateReconcile(io);
    expect(row.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:clear']);
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954, {
      add: 'red-team:clear', remove: ['red-team:blocked'] });
  });
  it('a same-head changes verdict arriving before the write cancels the stale clearance', () => {
    const io = fixture(), live = io.prs[0];
    const later = { ...comment('🔁 review — changes requested\nRemaining blocker'), createdAt: '2026-10-26T01:02:00Z' };
    let reads = 0;
    io.readComments = () => (++reads > 1 ? [...live.comments, later] : live.comments);
    const rows = sweepLabelStateReconcile(io);
    expect(rows[0]?.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:clear']);
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954, { add: 'red-team:clear', remove: ['red-team:blocked'] });
  });
  it('a native change request arriving before the write cancels the stale clearance', () => {
    const io = fixture();
    io.provider.readPrReviews.mockReturnValueOnce([]).mockReturnValueOnce(
      [{ state: 'CHANGES_REQUESTED', user: { login: 'chalbert' }, submitted_at: '2026-10-26T01:02:00Z' }]);
    const rows = sweepLabelStateReconcile(io);
    expect(rows[0]?.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:clear']);
    expect(io.provider.readPrReviews).toHaveBeenCalledWith(repo, 5954);
  });
  it('the sweep reads native reviews; a standing change request or unreadable reviews keep review holds', () => {
    for (const reader of [() => [{ state: 'CHANGES_REQUESTED', user: { login: 'chalbert' },
      submitted_at: '2026-10-26T01:02:00Z' }], () => { throw Error('reviews unreadable'); }]) {
      const io = fixture();
      io.provider.readPrReviews.mockImplementation(reader);
      const [row] = sweepLabelStateReconcile(io);
      expect(row.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:clear']);
    }
  });
  it('a newer same-head run recorded before the write is re-read and its changes confirmation keeps holds', () => {
    const io = fixture(), accepted = review(5954), changed = review(5954);
    changed.id = 'review-pr-newer';
    changed.findings.confirm = 'changes';
    changed.stepTimings = [{ step: 'read', startedAt: '2026-10-26T02:00:00Z' },
      { step: 'advise', finishedAt: '2026-10-26T02:01:00Z' }];
    let indexReads = 0;
    io.readReviews = () => (++indexReads > 1 ? [reviewRunEvidence(accepted), reviewRunEvidence(changed)]
      : [reviewRunEvidence(accepted)]);
    io.readReview = id => (id === changed.id ? changed : accepted);
    const [row] = sweepLabelStateReconcile(io);
    expect(indexReads).toBe(2);
    expect(row.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:clear']);
    expect(row.labelsReconciled.evidence.review).toEqual({ id: 'review-pr-newer', sha: head });
  });
  it('a stale plan with nothing left to change after the final read writes nothing', () => {
    const io = fixture(), live = io.prs[0];
    io.readPr.mockReturnValueOnce(live).mockReturnValueOnce({ ...live, labels: ['red-team:clear'] });
    expect(sweepLabelStateReconcile(io)).toEqual([]);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
  });
  it('the production PR reader preserves its default fields for existing callers', () => {
    const exec = vi.fn(() => '{}');
    defaultReadPr({ repo, number: 42, exec, readComments: () => [] });
    expect(exec.mock.calls[0][1].at(-1)).toBe('number,state,labels,headRefOid');
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
