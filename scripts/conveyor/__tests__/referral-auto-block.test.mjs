/**
 * @file referral-auto-block.test.mjs — review.referralDefault=auto-block (operator ruling 2026-10-08).
 *   Red on the old code: no auto-policy actor, no sweep, no structured-block dispute.
 */
import { describe, expect, it, vi } from 'vitest';
import { planAutoBlock, sweepAutoBlock, AUTO_BLOCK_REASON } from '../referral-auto-block.mjs';
import { sweepReviewHoldLabels } from '../review-hold-reconcile.mjs';
import { openReferralFindings, planOperatorRuling, selectFindings } from '../../operations/record-referral-ruling.mjs';
import { mandatoryReferralState, validateOperatorRuling, buildOperatorRulingComment, AUTO_POLICY_ACTOR, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';
import { ignoredRulings, rulingNeeded, RULING_NEEDED_LABEL } from '../../lib/ruling-ledger.mjs';
import { resolveReviewSettings, validateReviewSettings } from '../../lib/review-settings.mjs';
import { OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';
import { classifyEvent, normalizeComment } from '../../operations/coroner-rounds.mjs';
import { H1, H2, H3, H4, repo, record, recordComment, iso } from './ruling-fixtures.mjs';

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
    const pr0 = parked();
    const plan0Key = pr0.comments.length && planAutoBlock(pr0, { mode: 'auto-block', cardReadable }).block[0].key;
    const out = sweepAutoBlock({ repo, listPrs: () => [pr0], settings: AUTO, runRuling, cardReadable });
    expect(out).toEqual([{ num: 3794, action: 'auto-blocked', findings: 1, operatorKept: 0 }]);
    const args = runRuling.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(['--ruling=block', '--actor=auto-policy', `--finding=${plan0Key}`, `--reason=${AUTO_BLOCK_REASON}`]));
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

/** A referral record carrying several findings; `judgment` marks the finding names whose original carries `judgmentCall`. */
function multiRecord({ head, runId, items, pr = 3794 }) {
  const reviewer = mandatoryReferralReviewer(runId);
  const referrals = items.map(({ summary, file, judgmentCall }) => {
    const original = { summary, file, line: 12, verdict: 'CONFIRMED', impactIfUnfixed: 'broken', ...(judgmentCall ? { judgmentCall: true } : {}) };
    return { key: referralFindingKey('judge', original), seat: 'judge', original, finding: normalizeFinding(original) };
  });
  return { version: 1, repo, pr, head, runId, reviewer, authorBody: '<!-- authored-by-actor: author -->', attempted: true, referrals, rulings: [] };
}
const A = { summary: 'policy pointer files are missing from the standards manifest so the gate cannot see them', file: 'policy/pointer.md' };
const B = { summary: 'the retry loop never backs off so a flaky host is hammered until the timeout fires', file: 'scripts/retry.mjs' };
const J = { summary: 'naming the flag with a double negative reads badly; pick the house style', file: 'scripts/flag.mjs', judgmentCall: true };
const keyOf = (item) => referralFindingKey('judge', { summary: item.summary, file: item.file, line: 12, verdict: 'CONFIRMED', impactIfUnfixed: 'broken', ...(item.judgmentCall ? { judgmentCall: true } : {}) });
const prWith = (items, extra = {}) => ({ number: 3794, headRefOid: H1, labels: [{ name: 'review:human' }],
  comments: [recordComment(multiRecord({ head: H1, runId: 'run-1', items }), 5)], ...extra });

describe('mixed findings', () => {
  it('a judgmentCall flag set on a real finding survives the pipeline: it stays with the operator, the rest is ruled by exact key', () => {
    const pr = prWith([B, J]);
    expect(rulingNeeded(pr, { cardReadable }).findings.find((f) => f.key === keyOf(J)).judgmentCall).toBe(true);
    const plan = planAutoBlock(pr, { mode: 'auto-block', cardReadable });
    expect(plan.block.map((f) => f.key)).toEqual([keyOf(B)]);
    expect(plan.operator.map((f) => f.key)).toEqual([keyOf(J)]);
    expect(planAutoBlock(prWith([J]), { mode: 'auto-block', cardReadable })).toBeNull();
  });
  it('the sweep rules each blockable finding by its exact key, never all-open', () => {
    const runRuling = vi.fn();
    sweepAutoBlock({ repo, listPrs: () => [prWith([A, B, J])], settings: AUTO, runRuling, cardReadable });
    const findings = runRuling.mock.calls.map(([args]) => args.find((a) => a.startsWith('--finding=')));
    expect(findings.sort()).toEqual([`--finding=${keyOf(A)}`, `--finding=${keyOf(B)}`].sort());
  });
  it('a bare finding key is accepted by the ruling operation (selectFindings)', () => {
    const pr = prWith([A, B]);
    const o = openReferralFindings({ comments: pr.comments, repo, pr: pr.number, head: H1, cardReadable });
    expect(selectFindings(o.open, keyOf(B)).map((x) => x.key)).toEqual([keyOf(B)]);
  });
});

describe('a dispute next to a fresh finding', () => {
  it('rules only the fresh finding, by key; the dispute stays with the operator', () => {
    const base = prWith([A]);
    const { comment } = autoPolicyComment(base);
    const comments = [...base.comments, comment, recordComment(multiRecord({ head: H2, runId: 'run-2', items: [A] }), 20),
      recordComment(multiRecord({ head: H3, runId: 'run-3', items: [A] }), 40),
      recordComment(multiRecord({ head: H4, runId: 'run-4', items: [A, B] }), 60)];
    const pr = { number: 3794, headRefOid: H4, labels: [], comments };
    expect(ignoredRulings(pr, { humanAt: 2 }).escalate).toBe(true);
    const plan = planAutoBlock(pr, { mode: 'auto-block', cardReadable, humanAt: 2 });
    expect(plan.block.map((f) => f.key)).toEqual([keyOf(B)]);
    expect(plan.operator.map((f) => f.key)).toContain(keyOf(A));
    const runRuling = vi.fn();
    sweepAutoBlock({ repo, listPrs: () => [pr], settings: AUTO, runRuling, cardReadable, humanAt: 2 });
    expect(runRuling).toHaveBeenCalledTimes(1);
    expect(runRuling.mock.calls[0][0]).toContain(`--finding=${keyOf(B)}`);
    expect(runRuling.mock.calls[0][0]).not.toContain('--finding=all-open');
  });
});

describe('operator-mode ledger is unchanged', () => {
  it('an operator-authored structured block is NOT a standing block; only auto-policy is', () => {
    const base = parked();
    const o = openReferralFindings({ comments: base.comments, repo, pr: 3794, head: H1, cardReadable });
    const read = { head: H1, open: o.open, ruled: o.ruled, disputed: o.disputed, malformed: o.malformed, card: null, now: '2026-10-08T12:00:00.000Z', clearerId: 's' };
    const plan = planOperatorRuling(read, { repo, pr: 3794, finding: 'all-open', ruling: 'block', actor: OPERATOR_LOGINS[0], channel: 'chat', reason: 'fix it' });
    const comment = { body: plan.body, createdAt: '2026-10-08T12:00:00.000Z', author: { login: OPERATOR_LOGINS[0] } };
    const comments = [...base.comments, comment, recordComment(record({ head: H2, runId: 'run-2' }), 20)];
    expect(ignoredRulings({ number: 3794, headRefOid: H2, labels: [], comments })).toBeNull();
  });
});

describe('labels around an auto-block (review-hold sweep)', () => {
  const run = (prs, settings, runRuling) => {
    const calls = [];
    const provider = { currentRepo: () => repo, ensureLabel: () => {}, setLabels: (r, n, s) => calls.push(['set', n, s]), readPrState: () => null, postComment: () => {} };
    const results = sweepReviewHoldLabels({ repo, listPrs: () => prs, provider, settings, runRuling });
    return { calls, results };
  };
  it('a judgment call left for the operator keeps the advisory:ruling-needed signal', () => {
    const runRuling = vi.fn();
    const { calls } = run([prWith([B, J])], AUTO, runRuling);
    expect(runRuling).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual(['set', 3794, { add: RULING_NEEDED_LABEL }]);
  });
  it('a failed ruling leaves the PR parked and surfaced: the label still goes on', () => {
    const runRuling = vi.fn(() => { throw new Error('boom'); });
    const { calls, results } = run([parked()], AUTO, runRuling);
    expect(results.find((r) => r.autoBlock)).toMatchObject({ autoBlock: 'failed' });
    expect(calls).toContainEqual(['set', 3794, { add: RULING_NEEDED_LABEL }]);
  });
  it('never touches review:human on an auto-blocked PR', () => {
    const { calls } = run([parked()], AUTO, vi.fn());
    expect(JSON.stringify(calls)).not.toContain('review:human');
  });
});

describe('coroner', () => {
  it('classifies an automatic policy ruling comment as a policy-send-back round, the operator one as operator-send-back', () => {
    const body = (title) => `${title} on mandatory referrals\n\n1. **block** — pointer files must be listed (run \`run-1\`)\n`;
    const c = (title) => normalizeComment({ created_at: '2026-10-08T12:00:00Z', user: { login: 'web-everything[bot]' }, body: body(title) });
    expect(classifyEvent(c('## Automatic policy ruling'))).toMatchObject({ type: 'round', trigger: 'policy-send-back' });
    expect(classifyEvent(c('## Operator ruling'))).toMatchObject({ type: 'round', trigger: 'operator-send-back' });
  });
});
