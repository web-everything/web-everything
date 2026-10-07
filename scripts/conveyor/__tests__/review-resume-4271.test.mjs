/**
 * @file scripts/conveyor/__tests__/review-resume-4271.test.mjs
 * @description Card 126, live PR #4271 (2026-10-07). Replays the PR's real comment sequence (fixture): two mandatory
 *   referral records on the head, the 19:45Z advisory ("Pending: 7 ..."), then the operator rulings at 20:01Z.
 *   Three product defects, each pinned here and RED on the old code:
 *   (2) the advisory's pending count and the list shown for ruling came from two derivations (the label's list used
 *       `cardReadable: () => true`, the advisory counted the gate's raw list), so they disagreed;
 *   (1) recording a ruling while others stay pending returned no follow-up at all; and a ruled PR must be owed a
 *       fresh review on the same head (guarded here end to end through the real hold and the real planner);
 *   (3) a `review:human` PR with a refusal logged nothing, ever.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mandatoryReferralState, readReferralRecords } from '../../lib/jury-core.mjs';
import { rulingNeeded } from '../../lib/ruling-ledger.mjs';
import { renderAdvisoryNote } from '../../operations/review-pr.mjs';
import { enrichPrsWithReferralHolds } from '../review-referral-hold.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { explainPendingNotDispatched } from '../../../skills-src/conveyor/review-daemon.mjs';
import { planRulingFollowUp } from '../../operations/record-referral-ruling.mjs';

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pr-4271-ruling-sequence.json'), 'utf8'));
const repo = fx.repo;
const head = fx.headRefOid;
// The thread as it stood when the advisory posted (records + advisory), and after the operator's two rulings.
const beforeRulings = fx.comments.slice(0, 3);
const afterRulings = fx.comments;
const pr = (comments, labels = ['review:human', 'advisory:ruling-needed']) => ({
  number: fx.pr, headRefOid: head, body: fx.body, createdAt: fx.createdAt, isDraft: false, baseRefName: 'main',
  labels: labels.map((name) => ({ name })), comments,
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'ci' }],
});
// The gate as the daemon runs it: the card the operator named does not exist in the daemon's checkout.
const noCards = () => false;
const gateContext = { repo, pr: fx.pr, head, body: fx.body, createdAt: fx.createdAt, cardReadable: noCards };

describe('card 126 (2): one source for the pending count', () => {
  it('the gate holds 7 findings, and names all 7', () => {
    const state = mandatoryReferralState(beforeRulings, gateContext);
    expect(state.pending).toHaveLength(7);
    expect(state.pendingFindings).toHaveLength(7);
    expect(state.pendingReasons).toEqual([]);
  });

  it('the label list equals the gate list (same card rule), not a shorter one', () => {
    const state = mandatoryReferralState(beforeRulings, gateContext);
    const need = rulingNeeded({ headRefOid: head, body: fx.body, createdAt: fx.createdAt, comments: beforeRulings }, { cardReadable: noCards });
    expect(need.findings.map((f) => f.key).sort()).toEqual(state.pendingFindings.map((f) => f.key).sort());
  });

  it('the advisory states the count of the findings it lists, and lists them', () => {
    const state = mandatoryReferralState(beforeRulings, gateContext);
    const verdict = { verdict: 'needs-human', findings: [], lensVerdicts: {}, lenses: [],
      pendingReferrals: state.pending, pendingFindings: state.pendingFindings, blockedReferrals: [] };
    const note = renderAdvisoryNote({ read: { repo, pr: fx.pr, disposition: 'converge', netBasis: { base: 'b', rev: head },
      netChangedFiles: [], degraded: false }, verdict });
    expect(note).toContain('Pending: 7 mandatory referral(s) await a ruling');
    const listed = note.split('### Awaiting a ruling')[1].split('\n').filter((l) => /^\d+\. /.test(l));
    expect(listed).toHaveLength(7);
  });

  it('hold tokens that name no finding are not counted as findings', () => {
    const state = mandatoryReferralState(beforeRulings, { ...gateContext, body: '', createdAt: fx.createdAt, stampPolicy: 'refuse' });
    expect(state.pendingFindings.length + state.pendingReasons.length).toBe(state.pending.length);
  });
});

describe('card 126 (1): recorded rulings re-arm the review', () => {
  const open = [{ state: 'pending', runId: 'r', key: 'a', seat: 's', file: 'f', line: 1, summary: 'one' },
    { state: 'pending', runId: 'r', key: 'b', seat: 's', file: 'g', line: 2, summary: 'two' }];
  it('a ruling that leaves findings pending says it re-armed the review and names what remains', () => {
    expect(planRulingFollowUp({ open, selected: [open[0]], ruling: 'not-real', reason: 'x', enabled: true, head }))
      .toMatchObject({ action: 'rearm', remaining: [{ file: 'g', summary: 'two' }] });
  });
  it('a ruling that leaves nothing pending resumes (and clears the label)', () => {
    expect(planRulingFollowUp({ open, selected: open, ruling: 'not-real', reason: 'x', enabled: true, head })).toEqual({ action: 'resume' });
  });
  it('replay: parked before the rulings, owed a fresh review on the SAME head after them', () => {
    const run = { repo, pr: fx.pr, head, startedAt: Date.parse('2026-10-07T19:36:46Z'), completedAt: Date.parse('2026-10-07T19:45:34Z'),
      parked: true, attempted: true, persistenceFailed: false, count: 7, pending: [],
      // what the parked run already saw: every ruling on the head's records at the time
      rulings: readReferralRecords(beforeRulings, { head }).records.flatMap((r) => r.rulings).map((r) => JSON.stringify(r)) };
    const plan = (comments) => {
      const [enriched] = enrichPrsWithReferralHolds([pr(comments)], { repo, readRuns: () => [run] });
      return planReconcile({ repo: 'we', prs: [enriched], agents: [], requiredChecks: ['test'], now: Date.parse('2026-10-07T20:30:00Z') });
    };
    const before = plan(beforeRulings);
    expect(before.dispatch).toEqual([]);
    expect(before.refusals.map((r) => r.kind)).toEqual(['review-referrals-pending']);
    const after = plan(afterRulings);
    expect(after.refusals).toEqual([]);
    expect(after.dispatch.map((d) => d.kind)).toEqual(['review']);
  });
});

describe('card 126 (3): a review:human PR is explained every tick', () => {
  const plan = { dispatch: [], refusals: [{ prNumber: fx.pr, kind: 'review-referrals-pending', why: 'review paused: 7 referrals need a ruling',
    referralHold: { kind: 'referral' } }] };
  it('logs the reason for a review:human PR even when it is a referral hold', () => {
    const out = explainPendingNotDispatched({ prs: [pr(afterRulings)], plan });
    expect(out).toEqual([{ prNumber: fx.pr, labels: ['review:human'], reasons: ['review-referrals-pending: review paused: 7 referrals need a ruling'] }]);
  });
  it('logs a review:human PR the plan did not mention at all, instead of staying silent', () => {
    const out = explainPendingNotDispatched({ prs: [pr(afterRulings)], plan: { dispatch: [], refusals: [] } });
    expect(out[0].reasons).toEqual(['absent from the reconcile plan (no dispatch, no refusal)']);
  });
  it('logs every tick: the same inputs give the same line again', () => {
    const a = explainPendingNotDispatched({ prs: [pr(afterRulings)], plan });
    const b = explainPendingNotDispatched({ prs: [pr(afterRulings)], plan });
    expect(b).toEqual(a);
    expect(a).toHaveLength(1);
  });
});
