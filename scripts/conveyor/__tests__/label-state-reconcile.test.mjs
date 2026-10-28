import { describe, expect, it, vi } from 'vitest';
import { planLabelStateReconcile, sweepLabelStateReconcile, readLabelReconcileComments } from '../label-state-reconcile.mjs';
import { reviewRunEvidence } from '../review-referral-hold.mjs';
import { planRecordDecision } from '../../operations/review-pr.mjs';
import { defaultReadPr } from '../advisory-label-sweep.mjs';
import { readCompletePrComments } from '../pr-comments-complete.mjs';
import { readRedTeamDisposition } from '../../lib/red-team-gate.mjs';
import * as redTeamGate from '../../lib/red-team-gate.mjs';
import { buildRedTeamDispositionInputs } from '../../lib/red-team-disposition-inputs.mjs';
import { syncRedTeamStatusLabels } from '../../lib/red-team-status-labels.mjs';
import { buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';

const repo = 'o/n', head = 'a'.repeat(40), otherHead = 'b'.repeat(40);
const comment = body => ({ author: { login: 'web-everything' }, body });
const red = (pr, rev = head, broken = false) => comment(`<!-- we:red-team-advisory pr=${pr} rev=${rev} -->\n${broken
  ? '1. [**confirmed**] (edge-case, broken) `scripts/x.mjs:1` — break' : 'ACCEPTS'}`);
const pr = (number, labels, comments = [red(number)]) => ({ number, state: 'OPEN', headRefOid: head,
  labels, comments, body: '<!-- authored-by-actor: author -->', createdAt: '2026-01-01T00:00:00Z' });
// A read native-review channel with no reviews; `reviews: null` (unreadable) is tested explicitly.
const planOf = args => planLabelStateReconcile({ reviews: [], ...args });
function standingRulingThread(impact = 'broken') {
  const standingRuling = { ok: true, id: `${repo}#6000`, author: 'chalbert', by: 1, maxPerPr: 3,
    repos: [repo], cardOnlyHeads: { [head]: true }, uneditedComments: ['IC_auto'] };
  const result = { ...red(42, head, true), createdAt: '2026-10-21T17:00:00Z' };
  result.body = result.body.replace('edge-case, broken', `edge-case, ${impact}`);
  const id = redTeamGate.liveResultGateState([result], 42, head).resultId;
  const cap = { ...comment(redTeamGate.redTeamGateMarker(42, head, 'round-cap', id, [])),
    createdAt: '2026-10-21T17:10:00Z' };
  const at = '2026-10-21T18:00:00Z';
  const grant = { id: 'IC_auto', author: { login: 'web-everything[bot]', type: 'Bot' }, createdAt: at,
    body: buildRoundExtensionComment({ repo, pr: 42, by: 1, actor: 'chalbert', channel: 'chat',
      reason: 'one more round', at, standingRuling: standingRuling.id, head,
      episode: `${repo}#42@${head}:review:12/12` }) };
  // A human release after the grant is invalid: the pending round still belongs to automation.
  const release = { author: { login: 'chalbert', type: 'User' }, createdAt: '2026-10-21T19:00:00Z',
    body: `${redTeamGate.redTeamGateMarker(42, head, 'operator-not-real', id)}\n- 1 finding(s) left advisory (#1).` };
  return { standingRuling, comments: [result, cap, grant, release] };
}
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
  it.each(['injected', 'process', 'default'])
  ('a confirmed degraded finding respects the %s red-team policy', kind => {
    const result = red(42, head, true);
    result.body = result.body.replace('edge-case, broken', 'edge-case, degraded');
    const live = pr(42, ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy', 'ready-to-merge'], [result]);
    const policy = { WE_RED_TEAM_CONFIRMED_BREAKS: 'degraded=send-back' };
    vi.stubEnv('WE_RED_TEAM_CONFIRMED_BREAKS', policy.WE_RED_TEAM_CONFIRMED_BREAKS);
    if (kind !== 'process') delete process.env.WE_RED_TEAM_CONFIRMED_BREAKS;
    try {
      const plan = planOf({ repo, pr: live, review: review(42), ...(kind === 'injected' ? { env: policy } : {}) });
      expect(plan.to).toEqual(kind === 'default' ? ['ready-to-merge', 'red-team:clear']
        : ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy']);
      expect(plan.remove).toEqual(kind === 'default'
        ? ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy'] : ['ready-to-merge']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
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
  it.each(['updatedAt', 'updated_at', 'same-time'])
  ('an older objection with %s edit timing retains holds', kind => {
    const objection = { ...comment('🔁 review — changes requested'), createdAt: '2026-10-26T00:59:00Z' };
    if (kind === 'updatedAt' || kind === 'updated_at') objection[kind] = '2026-10-26T01:02:00Z';
    if (kind === 'same-time') objection.updatedAt = '2026-10-26T01:00:00Z';
    expect(planOf({ repo, pr: pr(42, ['review:changes', 'fix-waiting:host-busy'], [objection]),
      review: review(42) })).toBeNull();
  });
  it.each(['missing', 'invalid', 'REST-invalid'])
  ('an older objection with %s edit timing cannot prove clearance', kind => {
    const objection = { ...comment('🔁 review — changes requested'), createdAt: '2026-10-26T00:59:00Z' };
    if (kind === 'invalid') objection.updatedAt = 'invalid';
    if (kind === 'REST-invalid') {
      objection.created_at = objection.createdAt;
      delete objection.createdAt;
      objection.updated_at = 'invalid';
    }
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
      'red-team:blocked', 'ready-to-merge'], []);
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
  it('same-head stored changes without a live disposition drop ready', () => {
    const live = pr(42, ['red-team:blocked', 'red-team:pending', 'ready-to-merge'], []);
    const redTeam = { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: 'changes' } };
    const plan = planOf({ repo, pr: live, redTeam });
    expect(plan.to).toEqual(['red-team:blocked']);
    expect(plan.add).not.toContain('red-team:clear');
    expect(plan.remove).not.toContain('red-team:blocked');
    expect(planOf({ repo, pr: live, redTeam: { ...redTeam, head: otherHead } })).toBeNull();
  });
  it.each(['accept', 'degraded', 'operator-not-real'])
  ('a live %s disposition overrides stored changes and clears settled review holds', kind => {
    const result = red(42, head, kind !== 'accept');
    if (kind === 'degraded') result.body = result.body.replace('edge-case, broken', 'edge-case, degraded');
    const comments = [result];
    if (kind === 'operator-not-real') comments.push(comment(
      `<!-- we:red-team-gate pr=42 rev=${head} outcome=round-cap -->\n- 1 confirmed break(s) NOT sent back: round cap (#1).`), { author: { login: 'chalbert' },
      body: `<!-- we:red-team-gate pr=42 rev=${head} outcome=operator-not-real -->\n- 1 finding(s) left advisory (#1).` });
    expect(readRedTeamDisposition({ repo, pr: 42, head, comments, env: {} }))
      .toMatchObject({ result: { rev: head }, sendBack: [], held: [] });
    const live = pr(42, ['red-team:blocked', 'red-team:pending', 'review:changes',
      'fix-waiting:host-busy', 'ready-to-merge'], comments);
    const redTeam = { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: 'changes' } };
    expect(planOf({ repo, pr: live, redTeam, review: review(42), env: {} }).to)
      .toEqual(['ready-to-merge', 'red-team:clear']);
  });
  it.each(['send-back', 'held', 'forged-release', 'stale-release'])
  ('a live %s disposition still blocks despite a stored accept', kind => {
    const comments = [red(42, head, true)];
    if (kind.endsWith('release')) comments.push(comment(
      `<!-- we:red-team-gate pr=42 rev=${head} outcome=round-cap -->\n- 1 confirmed break(s) NOT sent back: round cap (#1).`));
    if (kind !== 'send-back') comments.push({ author: { login: kind === 'forged-release' ? 'attacker' : 'chalbert' },
      body: `<!-- we:red-team-gate pr=42 rev=${kind === 'stale-release' ? otherHead : head} outcome=${kind === 'held' ? 'round-cap' : 'operator-not-real'} -->\n${kind === 'held'
        ? '- 1 confirmed break(s) NOT sent back: round cap (#1).' : '- 1 finding(s) left advisory (#1).'}` });
    const redTeam = { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: 'accept' } };
    expect(planOf({ repo, pr: pr(42, ['red-team:blocked', 'ready-to-merge'], comments), redTeam }).to)
      .toEqual(['red-team:blocked']);
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

describe('shared red-team disposition inputs', () => {
  const env = { WE_RED_TEAM_STATUS_LABELS: 'on', WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'off' };
  function fixture(comments, labels = ['red-team:blocked', 'ready-to-merge']) {
    const live = pr(42, labels, comments);
    return { repo, env, prs: [live], provider: { ensureLabel: vi.fn(), setLabels: vi.fn(), readPrReviews: () => [] },
      readPr: () => live, readComments: () => live.comments, readReviews: () => [], readRedTeam: () => null,
      readGrantScope: vi.fn(() => null), emit: vi.fn() };
  }
  it('honours a verified automatic extension and rejects an operator-not-real release of its pending round', () => {
    const { comments, standingRuling } = standingRulingThread();
    expect(redTeamGate.gateRoundGrants(comments, 42, repo, standingRuling)).toHaveLength(1);
    const io = fixture(comments);
    io.readGrantScope.mockReturnValue(standingRuling);
    expect(planOf({ repo, pr: io.prs[0], env, standingRuling }).to).toEqual(['red-team:blocked']);
    expect(sweepLabelStateReconcile(io)[0].labelsReconciled.to).toEqual(['red-team:blocked']);
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 42, { add: null, remove: ['ready-to-merge'] });
    expect(io.readGrantScope).toHaveBeenCalledTimes(2);
    expect(io.readGrantScope).toHaveBeenCalledWith({ repo, pr: { number: 42, headRefOid: head, comments } });
  });
  it('re-resolves standing-ruling scope from the freshly read comments before the final plan', () => {
    const { comments, standingRuling } = standingRulingThread();
    const first = comments.filter(c => c.id !== 'IC_auto');
    const io = fixture(first);
    io.readComments = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(comments);
    io.readGrantScope.mockImplementation(({ pr }) => pr.comments === comments ? standingRuling : null);
    expect(sweepLabelStateReconcile(io)[0].labelsReconciled.to).toEqual(['red-team:blocked']);
    expect(io.readGrantScope).toHaveBeenNthCalledWith(1, { repo, pr: { number: 42, headRefOid: head, comments: first } });
    expect(io.readGrantScope).toHaveBeenNthCalledWith(2, { repo, pr: { number: 42, headRefOid: head, comments } });
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 42, { add: null, remove: ['ready-to-merge'] });
  });
  it('a throwing standing-ruling reader returns null scope and marks it unreadable', () => {
    const { comments } = standingRulingThread();
    const io = fixture(comments);
    io.readGrantScope.mockImplementation(() => { throw Error('unreadable ruling'); });
    const inputs = buildRedTeamDispositionInputs({ repo, pr: 42, head, comments: io.prs[0].comments,
      env, readGrantScope: io.readGrantScope });
    expect(inputs.standingRuling).toBeNull();
    expect(inputs.scopeUnreadable).toBe(true);
    expect(redTeamGate.gateRoundGrants(inputs.comments, 42, repo, inputs.standingRuling)).toEqual([]);
  });
  it.each(['initial', 'final'])('unreadable standing-ruling scope on the %s plan skips an operator-not-real release without writes, provisioning or events', phase => {
    const { comments, standingRuling } = standingRulingThread();
    const io = fixture(comments);
    // Without the scope, this full thread would wrongly release the automation-owned pending round.
    expect(planOf({ repo, pr: io.prs[0], env, standingRuling: null }).to)
      .toEqual(['ready-to-merge', 'red-team:clear']);
    expect(planOf({ repo, pr: io.prs[0], env, standingRuling }).add).toEqual([]);
    io.readGrantScope.mockImplementation(() => { throw Error('unreadable ruling'); });
    if (phase === 'final') io.readGrantScope.mockReturnValueOnce(standingRuling);
    expect(sweepLabelStateReconcile(io)).toEqual([]);
    expect(io.readGrantScope).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.provider.ensureLabel).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
  it('an explicit null scope keeps the planner pure and never triggers grant IO', () => {
    const readGrantScope = vi.fn(() => { throw Error('must not read'); });
    const inputs = buildRedTeamDispositionInputs({ repo, pr: 42, head, comments: [], env,
      standingRuling: null, readGrantScope });
    expect(inputs).toEqual({ repo, pr: 42, head, comments: [], env, standingRuling: null, statusLabels: true });
    expect(readGrantScope).not.toHaveBeenCalled();
  });
  it.each(['live accept', 'live changes', 'stored accept', 'stored changes'])
  ('statusLabels=off suppresses all red-team writes and ready drops for %s', kind => {
    const io = fixture(kind.startsWith('live') ? [red(42, head, kind.endsWith('changes'))] : [],
      ['red-team:pending', 'red-team:blocked', 'red-team:clear', 'ready-to-merge']);
    io.env = { ...env, WE_RED_TEAM_STATUS_LABELS: 'off' };
    io.readRedTeam = () => kind.startsWith('stored')
      ? { repo, pr: 42, head, status: 'finished', result: { foldedVerdict: kind.split(' ')[1] } } : null;
    expect(sweepLabelStateReconcile(io)).toEqual([]);
    expect(io.provider.ensureLabel).not.toHaveBeenCalled();
    expect(io.provider.setLabels).not.toHaveBeenCalled();
  });
  it.each(['accept', 'changes'])('statusLabels=off preserves review-label handling for %s', verdict => {
    const io = fixture([red(42, head, true)],
      ['review:changes', 'fix-waiting:host-busy', 'red-team:pending', 'ready-to-merge']);
    io.env = { ...env, WE_RED_TEAM_STATUS_LABELS: 'off' };
    const stored = review(42);
    stored.findings.confirm = verdict;
    io.readReviews = () => [reviewRunEvidence(stored)];
    io.readReview = () => stored;
    const plan = sweepLabelStateReconcile(io)[0].labelsReconciled;
    expect(plan.to).toEqual(verdict === 'accept' ? ['red-team:pending', 'ready-to-merge']
      : ['review:changes', 'fix-waiting:host-busy', 'red-team:pending']);
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 42, { add: null,
      remove: verdict === 'accept' ? ['review:changes', 'fix-waiting:host-busy'] : ['ready-to-merge'] });
  });
  it('statusLabels=off removes ready-to-merge for stored changes even when standing-ruling scope is unreadable', () => {
    const { comments } = standingRulingThread();
    const labels = ['review:changes', 'fix-waiting:host-busy', 'red-team:blocked', 'ready-to-merge'];
    const io = fixture(comments, labels);
    io.env = { ...env, WE_RED_TEAM_STATUS_LABELS: 'off' };
    io.readGrantScope.mockImplementation(() => { throw Error('unreadable ruling'); });
    const stored = review(42);
    stored.findings.confirm = 'changes';
    stored.findings.referralVerdict.verdict = 'changes';
    io.readReviews = () => [reviewRunEvidence(stored)];
    io.readReview = () => stored;
    const rows = sweepLabelStateReconcile(io);
    expect(rows).toHaveLength(1);
    expect(rows[0].labelsReconciled.to)
      .toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:blocked']);
    expect(io.readGrantScope).toHaveBeenCalledTimes(2);
    expect(io.provider.setLabels).toHaveBeenCalledTimes(1);
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 42, { add: null, remove: ['ready-to-merge'] });
    expect(io.provider.ensureLabel).not.toHaveBeenCalled();
    expect(io.emit).toHaveBeenCalledTimes(1);
  });
  it.each(['injected', 'process'])('the %s confirmed-breaks policy reaches both grant-aware sweep plans', kind => {
    const { comments, standingRuling } = standingRulingThread('degraded');
    const run = policy => {
      const io = fixture(comments);
      const policyEnv = { ...env, WE_RED_TEAM_CONFIRMED_BREAKS: `degraded=${policy}` };
      if (kind === 'injected') io.env = policyEnv;
      else {
        for (const [key, value] of Object.entries(policyEnv)) vi.stubEnv(key, value);
        delete io.env;
      }
      io.readGrantScope.mockReturnValue(standingRuling);
      return sweepLabelStateReconcile(io)[0].labelsReconciled;
    };
    try {
      expect(run('advisory').to).toEqual(['ready-to-merge', 'red-team:clear']);
      expect(run('send-back').to).toEqual(['red-team:blocked']);
    } finally { vi.unstubAllEnvs(); }
  });
  it('feeds exactly the normal reader inputs to both reconcile disposition reads on every plan', () => {
    const { comments, standingRuling } = standingRulingThread();
    const io = fixture(comments);
    io.env = { ...env, WE_RED_TEAM_CONFIRMED_BREAKS: 'broken=send-back,degraded=send-back' };
    io.readGrantScope.mockReturnValue(standingRuling);
    const { statusLabels, ...expected } = buildRedTeamDispositionInputs({ repo, pr: 42, head, comments,
      env: io.env, standingRuling });
    expect(statusLabels).toBe(true);
    const reader = vi.spyOn(redTeamGate, 'readRedTeamDisposition');
    try {
      syncRedTeamStatusLabels({ repo, pr: 42, head, comments, env: io.env, live: io.prs[0],
        provider: io.provider, readGrantScope: io.readGrantScope });
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith(expected);
      const normalInputs = reader.mock.calls[0][0];
      reader.mockClear();
      sweepLabelStateReconcile(io);
      expect(reader).toHaveBeenCalledTimes(4);
      for (const [inputs] of reader.mock.calls) expect(inputs).toEqual(normalInputs);
    } finally { reader.mockRestore(); }
  });
});

describe('sweepLabelStateReconcile', () => {
  function threadReader(before, after, raceOnRead = 1) {
    let editReads = 0;
    const calls = [];
    const exec = (_cmd, argv) => {
      if (!argv.includes('graphql')) {
        calls.push('body');
        return 'Operator note\t2026-10-26T00:59:00Z\tchalbert\tIC_old\thttps://example.test/comment\n';
      }
      const history = argv.some(a => a.includes('lastEditedAt'));
      calls.push(history ? 'edits' : 'count');
      const comments = history ? { nodes: ++editReads >= raceOnRead * 2 ? after : before,
        pageInfo: { hasNextPage: false, endCursor: null } } : { totalCount: 1 };
      return JSON.stringify({ data: { repository: { pullRequest: { comments } } } });
    };
    return { calls, read: (number, options) => readLabelReconcileComments(number, { ...options, exec }) };
  }
  const unedited = [{ id: 'IC_old', lastEditedAt: null }];
  const edited = [{ id: 'IC_old', lastEditedAt: '2026-10-26T01:02:00Z' }];
  it('a comment edited between the body and edit-history reads fails closed', () => {
    const reader = threadReader(unedited, edited);
    expect(() => reader.read(5954, { repo })).toThrow('comment thread changed during read');
    expect(reader.calls).toEqual(['edits', 'body', 'count', 'edits']);
  });
  it.each(['added', 'deleted', 'replaced', 'duplicate'])('a comment %s between edit snapshots fails closed', kind => {
    const after = kind === 'added' ? [...unedited, { id: 'IC_new', lastEditedAt: null }]
      : kind === 'deleted' ? [] : kind === 'duplicate' ? [...unedited, ...unedited]
        : [{ id: 'IC_new', lastEditedAt: null }];
    expect(() => threadReader(unedited, after).read(5954, { repo }))
      .toThrow('comment thread changed during read');
  });
  it.each([1, 2])('an edit during sweep read %s preserves holds without clearance', raceOnRead => {
    const io = fixture(), reader = threadReader(unedited, edited, raceOnRead);
    io.prs[0].labels = ['review:changes', 'fix-waiting:host-busy'];
    const labels = [...io.prs[0].labels];
    io.readComments = reader.read;
    expect(sweepLabelStateReconcile(io)).toEqual([{ num: 5954, error: 'comment thread changed during read' }]);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
    expect(io.prs[0].labels).toEqual(labels);
    expect(io.prs[0].labels).not.toContain('ready-to-merge');
  });
  it.each([[unedited], [edited]])('an unchanged thread retains its verified edit stamp (%j)', snapshot => {
    const reader = threadReader(snapshot, snapshot);
    expect(reader.read(5954, { repo })[0].updatedAt)
      .toBe(snapshot[0].lastEditedAt ?? '2026-10-26T00:59:00Z');
    expect(reader.calls).toEqual(['edits', 'body', 'count', 'edits']);
    const io = fixture();
    io.prs[0].labels = ['review:changes', 'fix-waiting:host-busy'];
    io.readComments = reader.read;
    expect(sweepLabelStateReconcile(io)[0].labelsReconciled.to).toEqual([]);
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954,
      { add: null, remove: ['review:changes', 'fix-waiting:host-busy'] });
  });
  it.each(['injected', 'process', 'default'])
  ('the sweep carries the %s policy through both plans to the label writer', kind => {
    const io = fixture(), live = io.prs[0];
    live.comments = [red(5954, head, true)];
    live.comments[0].body = live.comments[0].body.replace('edge-case, broken', 'edge-case, degraded');
    live.labels.push('ready-to-merge');
    const policy = { WE_RED_TEAM_CONFIRMED_BREAKS: 'degraded=send-back' };
    if (kind === 'injected') io.env = policy;
    vi.stubEnv('WE_RED_TEAM_CONFIRMED_BREAKS', policy.WE_RED_TEAM_CONFIRMED_BREAKS);
    if (kind !== 'process') delete process.env.WE_RED_TEAM_CONFIRMED_BREAKS;
    try {
      const [row] = sweepLabelStateReconcile(io);
      expect(row.labelsReconciled.to).toEqual(kind === 'default' ? ['ready-to-merge', 'red-team:clear']
        : ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy']);
      expect(io.provider.setLabels).toHaveBeenCalledTimes(1);
      expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954, kind === 'default'
        ? { add: 'red-team:clear', remove: ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy'] }
        : { add: null, remove: ['ready-to-merge'] });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each(['comment', 'edit', 'native', 'unreadable'])
  ('a same-head %s arriving during the final stored read cannot be cleared', kind => {
    const io = fixture(), live = io.prs[0], stored = review(5954);
    live.labels.push('ready-to-merge');
    const old = { ...comment('Operator note'), id: 'IC_old', createdAt: '2026-10-26T00:59:00Z',
      updatedAt: '2026-10-26T00:59:00Z' };
    live.comments.push(old);
    let reads = 0;
    io.readReviews = () => {
      if (++reads === 2) {
        if (kind === 'comment') live.comments.push({ ...comment('🔁 review — changes requested'), id: 'IC_new',
          createdAt: '2026-10-26T01:02:00Z', updatedAt: '2026-10-26T01:02:00Z' });
        if (kind === 'edit') Object.assign(old, { body: '🔁 review — changes requested', updatedAt: '2026-10-26T01:02:00Z' });
        if (kind === 'native') io.provider.readPrReviews.mockReturnValue([
          { state: 'CHANGES_REQUESTED', user: { login: 'chalbert' }, submitted_at: '2026-10-26T01:02:00Z' }]);
      }
      return [reviewRunEvidence(stored)];
    };
    io.readComments = () => {
      if (kind === 'unreadable' && reads === 2) throw Error('final thread unreadable');
      return structuredClone(live.comments);
    };
    const [row] = sweepLabelStateReconcile(io);
    expect(reads).toBe(2);
    if (kind === 'unreadable') {
      expect(row.error).toBe('final thread unreadable');
      expect(io.provider.setLabels).not.toHaveBeenCalled();
      expect(io.emit).not.toHaveBeenCalled();
    } else {
      expect(row.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:clear']);
      expect(io.provider.setLabels).toHaveBeenCalledTimes(1);
      expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954,
        { add: 'red-team:clear', remove: ['red-team:blocked', 'ready-to-merge'] });
    }
  });
  it.each(['later-edit', 'old-edit', 'never-edited', 'missing', 'duplicate', 'invalid', 'failed-page'])
  ('production edit metadata (%s) is joined before planning clearance', kind => {
    const io = fixture();
    io.prs[0].labels = ['review:changes', 'fix-waiting:host-busy', 'ready-to-merge'];
    const lastEditedAt = kind === 'never-edited' ? null : kind === 'invalid' ? 'invalid'
      : kind === 'old-edit' ? '2026-10-26T00:59:30Z' : '2026-10-26T01:02:00Z';
    const exec = vi.fn((_cmd, argv) => {
      if (!argv.includes('graphql')) return '🔁 review — changes requested\t2026-10-26T00:59:00Z\tchalbert\tIC_old\thttps://example.test/comment\n';
      if (!argv.some(a => a.includes('lastEditedAt'))) return JSON.stringify({ data: { repository: {
        pullRequest: { comments: { totalCount: 1 } } } } });
      if (kind === 'failed-page') throw Error('edit page unreadable');
      const nodes = kind === 'missing' ? [] : [{ id: 'IC_old', lastEditedAt }];
      if (kind === 'duplicate') nodes.push(nodes[0]);
      return JSON.stringify({ data: { repository: { pullRequest: { comments: {
        nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    });
    io.readComments = (number, options) => readLabelReconcileComments(number, { ...options, exec });
    const [row] = sweepLabelStateReconcile(io);
    if (['missing', 'duplicate', 'invalid', 'failed-page'].includes(kind)) {
      expect(row.error).toBeTruthy();
      expect(io.provider.setLabels).not.toHaveBeenCalled();
      expect(io.emit).not.toHaveBeenCalled();
    } else {
      expect(row.labelsReconciled.to).toEqual(kind === 'later-edit'
        ? ['review:changes', 'fix-waiting:host-busy'] : ['ready-to-merge']);
      expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954, { add: null,
        remove: kind === 'later-edit' ? ['ready-to-merge'] : ['review:changes', 'fix-waiting:host-busy'] });
    }
  });
  it.each(['comment', 'edit', 'native', 'stored', 'unreadable'])
  ('a same-head %s hold arriving during provisioning survives the final refresh', kind => {
    const io = fixture(), live = io.prs[0], stored = review(5954);
    live.labels.push('ready-to-merge');
    const old = { ...comment('Operator note'), createdAt: '2026-10-26T00:59:00Z',
      updatedAt: '2026-10-26T00:59:00Z' };
    if (kind === 'edit') live.comments.push(old);
    let provisioned = false;
    io.readReview = () => stored;
    io.provider.ensureLabel.mockImplementation(() => {
      provisioned = true;
      if (kind === 'comment') live.comments.push({ ...comment('🔁 review — changes requested'),
        createdAt: '2026-10-26T01:02:00Z', updatedAt: '2026-10-26T01:02:00Z' });
      if (kind === 'edit') Object.assign(old, { body: '🔁 review — changes requested', updatedAt: '2026-10-26T01:02:00Z' });
      if (kind === 'native') io.provider.readPrReviews.mockReturnValue([
        { state: 'CHANGES_REQUESTED', user: { login: 'chalbert' }, submitted_at: '2026-10-26T01:02:00Z' }]);
      if (kind === 'stored') stored.findings.confirm = 'changes';
    });
    io.readComments = () => {
      if (kind === 'unreadable' && provisioned) throw Error('thread unreadable after provisioning');
      return structuredClone(live.comments);
    };
    const rows = sweepLabelStateReconcile(io);
    expect(provisioned).toBe(true);
    if (kind === 'unreadable') {
      expect(rows[0].error).toBe('thread unreadable after provisioning');
      expect(io.provider.setLabels).not.toHaveBeenCalled();
      expect(io.emit).not.toHaveBeenCalled();
    } else {
      expect(rows[0]?.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:clear']);
      expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954,
        { add: 'red-team:clear', remove: ['red-team:blocked', 'ready-to-merge'] });
    }
  });
  function fixture() {
    const live = pr(5954, ['review:changes', 'red-team:blocked', 'fix-waiting:host-busy'], [referral(5954, true), red(5954)]);
    const stored = review(5954);
    const provider = { setLabels: vi.fn(), ensureLabel: vi.fn(), readPrReviews: vi.fn(() => []) }, emit = vi.fn();
    return { repo, prs: [live], provider, emit, readPr: vi.fn(() => live), readComments: () => live.comments,
      readReviews: () => [reviewRunEvidence(stored)], readReview: () => stored, readRedTeam: () => null };
  }
  it('the complete production comment reader cannot authorize clearance without edit metadata', () => {
    const io = fixture();
    const exec = vi.fn((_cmd, argv) => argv.includes('graphql')
      ? JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } })
      : '🔁 review — changes requested\t2026-10-26T00:59:00Z\tchalbert\tIC_old\thttps://example.test/comment\n');
    io.prs[0].labels = ['review:changes', 'fix-waiting:host-busy', 'ready-to-merge'];
    io.readComments = (number, options) => readCompletePrComments(number, { ...options, exec });
    expect(io.readComments(5954, { repo })[0]).toEqual({ body: '🔁 review — changes requested',
      createdAt: '2026-10-26T00:59:00Z', author: { login: 'chalbert' }, id: 'IC_old', url: 'https://example.test/comment' });
    expect(sweepLabelStateReconcile(io)[0]?.labelsReconciled.to).toEqual(['review:changes', 'fix-waiting:host-busy']);
    expect(io.provider.setLabels).toHaveBeenCalledWith(repo, 5954, {
      add: null, remove: ['ready-to-merge'] });
  });
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
  it('a refreshed plan needing another label waits for the next tick to provision it', () => {
    const io = fixture(), live = io.prs[0];
    live.labels.push('ready-to-merge');
    // A concurrent writer removed blocked while a fresh red-team objection arrived.
    io.readPr.mockReturnValueOnce(live).mockReturnValue({ ...live,
      labels: ['review:changes', 'fix-waiting:host-busy', 'ready-to-merge'] });
    io.provider.ensureLabel.mockImplementation(() => { live.comments = [red(5954, head, true)]; });
    expect(sweepLabelStateReconcile(io)).toEqual([]);
    expect(io.provider.ensureLabel).toHaveBeenCalledTimes(1);
    expect(io.provider.ensureLabel).toHaveBeenCalledWith(repo, 'red-team:clear', expect.any(Object));
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
    io.provider.ensureLabel.mockImplementation(() => {});
    expect(sweepLabelStateReconcile(io)[0]?.labelsReconciled.to)
      .toEqual(['review:changes', 'fix-waiting:host-busy', 'red-team:blocked']);
    expect(io.provider.ensureLabel).toHaveBeenLastCalledWith(repo, 'red-team:blocked', expect.any(Object));
  });
  it('failed provisioning leaves labels and events untouched', () => {
    const io = fixture();
    io.provider.ensureLabel.mockImplementation(() => { throw Error('provision failed'); });
    expect(sweepLabelStateReconcile(io)[0].error).toBe('provision failed');
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
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
  it.each([1, 2])('an unreadable complete thread on read %s leaves labels untouched and can retry', failedRead => {
    const io = fixture();
    const labels = [...io.prs[0].labels];
    const read = io.readComments;
    let reads = 0;
    io.readComments = (...args) => {
      if (++reads === failedRead) throw Error('incomplete thread\nreader details');
      return read(...args);
    };
    expect(sweepLabelStateReconcile(io)).toEqual([{ num: 5954, error: 'incomplete thread' }]);
    expect(io.prs[0].labels).toEqual(labels);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
    expect(sweepLabelStateReconcile(io)[0]?.labelsReconciled.to).toEqual(['red-team:clear']);
    expect(io.provider.setLabels).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledTimes(1);
  });
  it('a head move during the evidence reads leaves labels untouched', () => {
    const io = fixture();
    io.readPr.mockReturnValueOnce(io.prs[0]).mockReturnValueOnce({ ...io.prs[0], headRefOid: otherHead });
    expect(sweepLabelStateReconcile(io)).toEqual([]);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
  it.each(['comments', 'native', 'index', 'review', 'red-team', 'provision'])
  ('a push during the final %s read or preparation cancels clearance', phase => {
    const io = fixture();
    let liveHead = head;
    io.readPr.mockImplementation(() => ({ ...io.prs[0], headRefOid: liveHead }));
    const target = phase === 'native' || phase === 'provision' ? io.provider : io;
    const key = { comments: 'readComments', native: 'readPrReviews', index: 'readReviews',
      review: 'readReview', 'red-team': 'readRedTeam', provision: 'ensureLabel' }[phase];
    const original = target[key];
    let reads = 0;
    target[key] = (...args) => {
      const result = original(...args);
      if (++reads === (phase === 'provision' ? 1 : 2)) liveHead = otherHead;
      return result;
    };
    expect(sweepLabelStateReconcile(io)).toEqual([]);
    expect(liveHead).toBe(otherHead);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
  it.each(['missing', 'closed', 'wrong-pr', 'missing-head', 'unreadable'])
  ('a %s final metadata read cannot authorize a label write', kind => {
    const io = fixture(), live = io.prs[0];
    io.readPr.mockReturnValueOnce(live).mockReturnValueOnce(live).mockImplementation(() => {
      if (kind === 'unreadable') throw Error('final head unreadable');
      if (kind === 'missing') return null;
      return { ...live, ...(kind === 'closed' ? { state: 'CLOSED' }
        : kind === 'wrong-pr' ? { number: 42 } : { headRefOid: undefined }) };
    });
    const rows = sweepLabelStateReconcile(io);
    expect(rows).toEqual(kind === 'unreadable'
      ? [{ num: live.number, labelsReconciled: 'skipped', error: 'final head unreadable' }] : []);
    expect(io.provider.setLabels).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
  it('the final production head read performs no further evidence reads', () => {
    const io = fixture(), live = io.prs[0];
    io.readComments = vi.fn(io.readComments);
    const exec = vi.fn(() => JSON.stringify(live));
    io.readPr = args => defaultReadPr({ exec, readComments: io.readComments, ...args });
    expect(sweepLabelStateReconcile(io)[0]?.labelsReconciled.to).toEqual(['red-team:clear']);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(io.readComments).toHaveBeenCalledTimes(4);
    expect(exec.mock.calls[2][1].at(-1)).toBe('number,state,headRefOid');
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
