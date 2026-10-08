/**
 * @file referral-auto-block.test.mjs — review.referralDefault=auto-block (operator ruling 2026-10-08).
 *   Red on the old code: no auto-policy actor, no sweep, no structured-block dispute.
 */
import { describe, expect, it, vi } from 'vitest';
import { planAutoBlock, sweepAutoBlock, AUTO_BLOCK_REASON } from '../referral-auto-block.mjs';
import { sweepReviewHoldLabels } from '../review-hold-reconcile.mjs';
import { openReferralFindings, planOperatorRuling } from '../../operations/record-referral-ruling.mjs';
import { mandatoryReferralState, validateOperatorRuling, buildOperatorRulingComment, AUTO_POLICY_ACTOR } from '../../lib/jury-core.mjs';
import { ignoredRulings, rulingNeeded, RULING_NEEDED_LABEL } from '../../lib/ruling-ledger.mjs';
import { resolveReviewSettings, validateReviewSettings } from '../../lib/review-settings.mjs';
import { H1, H2, H3, H4, repo, record, recordComment } from './ruling-fixtures.mjs';

const AUTO = { referralDefault: 'auto-block' };
const OPERATOR = { referralDefault: 'operator' };
const parked = (extra = {}) => ({ number: 3794, headRefOid: H1, labels: [{ name: 'review:human' }],
  comments: [recordComment(record({ head: H1, runId: 'run-1' }), 5)], ...extra });
const cardReadable = () => true;

/** The ruling comment the daemon's `record-referral-ruling` run would post, built by the real planner. */
function autoPolicyComment(pr, { actor = AUTO_POLICY_ACTOR, ruling = 'block' } = {}) {
  const o = openReferralFindings({ comments: pr.comments, repo, pr: pr.number, head: pr.headRefOid, cardReadable });
  const read = { head: pr.headRefOid, open: o.open, ruled: o.ruled, disputed: o.disputed, malformed: o.malformed, card: null,
    now: '2026-10-08T12:00:00.000Z', clearerId: 's' };
  const plan = planOperatorRuling(read, { repo, pr: pr.number, finding: 'all-open', ruling, actor, channel: 'review daemon', reason: AUTO_BLOCK_REASON });
  return { plan, comment: { body: plan.body, createdAt: '2026-10-08T12:00:00.000Z', author: { login: 'web-everything' } } };
}

describe('the setting', () => {
  it('product default is operator; the file or env can opt in; junk keeps the default', () => {
    expect(resolveReviewSettings({ fileConfig: null, env: {} }).referralDefault).toBe('operator');
    expect(resolveReviewSettings({ fileConfig: AUTO, env: {} }).referralDefault).toBe('auto-block');
    expect(resolveReviewSettings({ fileConfig: AUTO, env: { WE_REVIEW_REFERRAL_DEFAULT: 'operator' } }).referralDefault).toBe('operator');
    expect(validateReviewSettings({ referralDefault: 'yolo' }).referralDefault).toBe('operator');
  });
});

describe('auto-block plan', () => {
  it('operator mode: nothing is planned (unchanged behaviour)', () => {
    expect(planAutoBlock(parked(), { mode: 'operator', cardReadable })).toBeNull();
  });
  it('auto-block mode: a pending confirmed referral is planned for a block', () => {
    const plan = planAutoBlock(parked(), { mode: 'auto-block', cardReadable });
    expect(plan.block).toHaveLength(1);
    expect(plan.operator).toHaveLength(0);
  });
  it('a finding the reviewer marked a judgment call stays with the operator', () => {
    const plan = planAutoBlock(parked(), { mode: 'auto-block', cardReadable, isJudgment: () => true });
    expect(plan).toBeNull();
  });
});

describe('the auto-policy ruling', () => {
  it('blocks the finding, says it is policy and not the operator, and the gate honours it', () => {
    const pr = parked();
    const { plan, comment } = autoPolicyComment(pr);
    expect(plan.record.actor).toBe('auto-policy');
    expect(comment.body).toMatch(/auto-blocked by policy review\.referralDefault=auto-block/);
    expect(comment.body).toMatch(/not by the operator/);
    expect(comment.body).not.toMatch(/operator's explicit instruction/);
    expect(plan.followUp.action).toBe('send-back');
    expect(plan.followUp.body).toMatch(/automatic policy ruling/);
    const withRuling = { ...pr, comments: [...pr.comments, comment] };
    expect(mandatoryReferralState(withRuling.comments, { head: H1, cardReadable }).pending).toEqual([]);
    expect(rulingNeeded(withRuling, { cardReadable })).toBeNull();
  });
  it('auto-policy can only hold: card and not-real are refused, and a hand-built clearing record is invalid', () => {
    const pr = parked();
    expect(() => autoPolicyComment(pr, { ruling: 'not-real' })).toThrow(/may only rule `block`/);
    const { plan } = autoPolicyComment(pr);
    const forged = { ...plan.record, rulings: plan.record.rulings.map((r) => ({ ...r, result: 'not-real' })) };
    expect(validateOperatorRuling(forged)).toBe(false);
    expect(() => buildOperatorRulingComment(forged)).toThrow();
    expect(validateOperatorRuling({ ...plan.record, actor: 'stranger' })).toBe(false);
  });
});

describe('sweep', () => {
  it('auto-block: records a block as auto-policy for the pending findings and never asks the operator', () => {
    const runRuling = vi.fn();
    const out = sweepAutoBlock({ repo, listPrs: () => [parked()], settings: AUTO, runRuling, cardReadable });
    expect(out).toEqual([{ num: 3794, action: 'auto-blocked', findings: 1, operatorKept: 0 }]);
    const args = runRuling.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(['--ruling=block', '--actor=auto-policy', '--finding=all-open', `--reason=${AUTO_BLOCK_REASON}`]));
  });
  it('operator mode: the sweep does nothing', () => {
    const runRuling = vi.fn();
    expect(sweepAutoBlock({ repo, listPrs: () => [parked()], settings: OPERATOR, runRuling, cardReadable })).toEqual([]);
    expect(runRuling).not.toHaveBeenCalled();
  });
  it('a failing ruling is reported, not thrown', () => {
    const runRuling = vi.fn(() => { throw new Error('boom\nmore'); });
    expect(sweepAutoBlock({ repo, listPrs: () => [parked()], settings: AUTO, runRuling, cardReadable })[0])
      .toMatchObject({ action: 'failed', error: 'boom' });
  });
});

describe('review-hold sweep end to end', () => {
  const run = (settings, prs = [parked()]) => {
    const calls = [];
    const provider = { currentRepo: () => repo, ensureLabel: () => {}, setLabels: (r, n, s) => calls.push(['set', n, s]), readPrState: () => null, postComment: () => {} };
    const runRuling = vi.fn();
    const results = sweepReviewHoldLabels({ repo, listPrs: () => prs, provider, settings, runRuling });
    return { calls, runRuling, results };
  };
  it('auto-block: the PR is sent back and advisory:ruling-needed is NOT added', () => {
    const { calls, runRuling, results } = run(AUTO);
    expect(runRuling).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls)).not.toContain(RULING_NEEDED_LABEL);
    expect(results.find((r) => r.autoBlock)).toMatchObject({ num: 3794, autoBlock: 'auto-blocked' });
  });
  it('operator mode: unchanged, the label goes on and nothing is auto-ruled', () => {
    const { calls, runRuling } = run(OPERATOR);
    expect(runRuling).not.toHaveBeenCalled();
    expect(calls).toContainEqual(['set', 3794, { add: RULING_NEEDED_LABEL }]);
  });
});

describe('a dispute still escalates to the operator', () => {
  // auto-policy blocks on H1; the fixer pushes, the reviewer reports the same finding on H2, H3 and H4.
  const thread = () => {
    const base = parked();
    const { comment } = autoPolicyComment(base);
    return [...base.comments, comment, recordComment(record({ head: H2, runId: 'run-2' }), 20),
      recordComment(record({ head: H3, runId: 'run-3' }), 40), recordComment(record({ head: H4, runId: 'run-4' }), 60)];
  };
  const at = (head, comments) => ({ number: 3794, headRefOid: head, labels: [], comments });
  it('the auto-policy block is a standing block: the same finding on a later head is an ignored ruling', () => {
    const ig = ignoredRulings(at(H2, thread()));
    expect(ig?.matches.length).toBe(1);
    expect(ig.matches[0].source).toBe('structured');
  });
  it('past the miss limit it is a dispute for the operator, and auto-block leaves it alone', () => {
    const pr = at(H4, thread());
    const need = rulingNeeded(pr, { cardReadable, humanAt: 2 });
    expect(need.findings).toHaveLength(1);
    expect(ignoredRulings(pr, { humanAt: 2 }).escalate).toBe(true);
    expect(planAutoBlock(pr, { mode: 'auto-block', cardReadable, humanAt: 2 })).toBeNull();
  });
});
