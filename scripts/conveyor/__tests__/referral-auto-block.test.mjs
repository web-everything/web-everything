/**
 * @file referral-auto-block.test.mjs — review.referralDefault=auto-block (operator ruling 2026-10-08).
 *   Red on the old code: no auto-policy actor, no sweep, no structured-block dispute.
 */
import { describe, expect, it, vi } from 'vitest';
import { planAutoBlock, sweepAutoBlock, AUTO_BLOCK_REASON } from '../referral-auto-block.mjs';
import { decideReferralHold, blockRuledReferralsFor } from '../review-referral-hold.mjs';
import { sweepReviewHoldLabels } from '../review-hold-reconcile.mjs';
import { openReferralFindings, planOperatorRuling, selectFindings } from '../../operations/record-referral-ruling.mjs';
import { mandatoryReferralState, validateOperatorRuling, buildOperatorRulingComment, AUTO_POLICY_ACTOR, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';
import { ignoredRulings, rulingNeeded, rulingDisputeText, fixerRulingBrief, renderRulingNotAddressed, RULING_NEEDED_LABEL } from '../../lib/ruling-ledger.mjs';
import { resolveReviewSettings, validateReviewSettings, resolveReferralSafetySettings } from '../../lib/review-settings.mjs';
import { OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';
import { classifyEvent, normalizeComment } from '../../operations/coroner-rounds.mjs';
import { H1, H2, H3, H4, repo, record, recordComment, iso } from './ruling-fixtures.mjs';
import { buildVerdictComment } from '../../review-set-label.mjs';
import { parseLatestHumanClearedSha } from '../../lib/review-escalation.mjs';

const AUTO = { referralDefault: 'auto-block' };
const OPERATOR = { referralDefault: 'operator' };
const parked = (extra = {}) => ({ number: 3794, state: 'OPEN', headRefOid: H1, labels: [{ name: 'review:human' }],
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
  it('a trusted human clearance is final for its head; an older clearance leaves the new head reviewable', () => {
    const withClearance = (headSha) => parked({ headRefOid: H2, comments: [
      recordComment(record({ head: H2, runId: 'run-2' }), 5),
      { body: buildVerdictComment({ to: 'clear-human', actor: 'Nicolas Gilbert', headSha }),
        createdAt: iso(10), author: { login: 'web-everything' } },
    ] });
    const opts = { mode: 'auto-block', cardReadable, isJudgment: () => false };
    const older = withClearance(H1);
    expect(parseLatestHumanClearedSha(older.comments)).toBe(H1);
    expect(planAutoBlock(older, opts)).toMatchObject({ head: H2, block: [expect.any(Object)], operator: [] });

    const cleared = withClearance(H2);
    expect(parseLatestHumanClearedSha(cleared.comments)).toBe(cleared.headRefOid);
    expect(planAutoBlock(cleared, opts)).toBeNull();
  });
  it('clear-human then a same-head plain accept remains protected from auto-block', () => {
    const pr = parked();
    pr.comments.push(
      { body: buildVerdictComment({ to: 'clear-human', actor: 'operator', headSha: H1 }), author: { login: 'web-everything' } },
      { body: buildVerdictComment({ to: 'accepted', actor: 'reviewer', headSha: H1 }), author: { login: 'web-everything' } },
    );
    expect(parseLatestHumanClearedSha(pr.comments)).toBeNull();
    expect(planAutoBlock(pr, { mode: 'auto-block', cardReadable, isJudgment: () => false })).toBeNull();
  });
  it.each([
    ['trusted current-head clearance', H2, { login: 'web-everything' }, true],
    ['trusted stale-head clearance', H1, { login: 'web-everything' }, false],
    ['untrusted current-head marker', H2, { login: 'drive-by' }, false],
    ['current-head marker with no author', H2, undefined, false],
  ])('auto-block respects %s with a mixed-case live head', (_name, headSha, author, final) => {
    const pr = parked({ headRefOid: H2.toUpperCase(), comments: [
      recordComment(record({ head: H2, runId: 'run-2' }), 5),
      { body: buildVerdictComment({ to: 'clear-human', actor: 'operator', headSha }), createdAt: iso(10), author },
    ] });
    const plan = planAutoBlock(pr, { mode: 'auto-block', cardReadable, isJudgment: () => false });
    if (final) expect(plan).toBeNull();
    else expect(plan).toMatchObject({ head: H2, block: [expect.any(Object)], operator: [] });
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
    const out = sweepAutoBlock({ repo, listPrs: () => [pr0], readPr: () => pr0, settings: AUTO, runRuling, cardReadable });
    expect(out).toEqual([{ num: 3794, action: 'auto-blocked', findings: 1, operatorKept: 0 }]);
    const args = runRuling.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(['--ruling=block', '--actor=auto-policy', `--finding=${plan0Key}`, `--reason=${AUTO_BLOCK_REASON}`]));
  });
  it('operator mode: the sweep does nothing', () => {
    const runRuling = vi.fn();
    expect(sweepAutoBlock({ repo, listPrs: () => [parked()], readPr: () => parked(), settings: OPERATOR, runRuling, cardReadable })).toEqual([]);
    expect(runRuling).not.toHaveBeenCalled();
  });
  it('a failing ruling is reported, not thrown', () => {
    const runRuling = vi.fn(() => { throw new Error('boom\nmore'); });
    expect(sweepAutoBlock({ repo, listPrs: () => [parked()], readPr: () => parked(), settings: AUTO, runRuling, cardReadable })[0])
      .toMatchObject({ action: 'failed', error: 'boom' });
  });
});

describe('review-hold sweep end to end', () => {
  const run = (settings, prs = [parked()]) => {
    const calls = [];
    const provider = { currentRepo: () => repo, ensureLabel: () => {}, setLabels: (r, n, s) => calls.push(['set', n, s]), readPrState: () => null, postComment: () => {} };
    let ruled = false;
    const runRuling = vi.fn(() => { ruled = true; });
    const readPr = ({ number }) => {
      const pr = prs.find((p) => p.number === number);
      return { ...pr, comments: ruled ? [...pr.comments, autoPolicyComment(pr).comment] : pr.comments };
    };
    const results = sweepReviewHoldLabels({ repo, listPrs: () => prs, readPr, provider, settings, runRuling });
    return { calls, runRuling, results };
  };
  it('auto-block: the PR is sent back and advisory:ruling-needed is NOT added', () => {
    const { calls, runRuling, results } = run(AUTO);
    expect(runRuling).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls)).not.toContain(RULING_NEEDED_LABEL);
    expect(results.find((r) => r.autoBlock)).toMatchObject({ num: 3794, autoBlock: 'auto-blocked' });
  });
  it('operator mode: leaves the ruling label to the mirror and nothing is auto-ruled', () => {
    const { calls, runRuling } = run(OPERATOR);
    expect(runRuling).not.toHaveBeenCalled();
    expect(JSON.stringify(calls)).not.toContain(RULING_NEEDED_LABEL);
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
  const at = (head, comments) => ({ number: 3794, state: 'OPEN', headRefOid: head, labels: [], comments });
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
const prWith = (items, extra = {}) => ({ number: 3794, state: 'OPEN', headRefOid: H1, labels: [{ name: 'review:human' }],
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
    sweepAutoBlock({ repo, listPrs: () => [prWith([A, B, J])], readPr: () => prWith([A, B, J]), settings: AUTO, runRuling, cardReadable });
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
    const pr = { number: 3794, state: 'OPEN', headRefOid: H4, labels: [], comments };
    expect(ignoredRulings(pr, { humanAt: 2 }).escalate).toBe(true);
    const plan = planAutoBlock(pr, { mode: 'auto-block', cardReadable, humanAt: 2 });
    expect(plan.block.map((f) => f.key)).toEqual([keyOf(B)]);
    expect(plan.operator.map((f) => f.key)).toContain(keyOf(A));
    const runRuling = vi.fn();
    sweepAutoBlock({ repo, listPrs: () => [pr], readPr: () => pr, settings: AUTO, runRuling, cardReadable, humanAt: 2 });
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
    expect(ignoredRulings({ number: 3794, state: 'OPEN', headRefOid: H2, labels: [], comments })).toBeNull();
  });
});

describe('labels around an auto-block (review-hold sweep)', () => {
  const run = (prs, settings, runRuling) => {
    const calls = [];
    const provider = { currentRepo: () => repo, ensureLabel: () => {}, setLabels: (r, n, s) => calls.push(['set', n, s]), readPrState: () => null, postComment: () => {} };
    const results = sweepReviewHoldLabels({ repo, listPrs: () => prs, readPr: ({ number }) => prs.find((p) => p.number === number), provider, settings, runRuling });
    return { calls, results };
  };
  it('a judgment call left for the operator leaves the ruling label to the mirror', () => {
    const runRuling = vi.fn();
    const { calls } = run([prWith([B, J])], AUTO, runRuling);
    expect(runRuling).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls)).not.toContain(RULING_NEEDED_LABEL);
  });
  it('a failed ruling is reported without writing the mirror-owned label', () => {
    const runRuling = vi.fn(() => { throw new Error('boom'); });
    const { calls, results } = run([parked()], AUTO, runRuling);
    expect(results.find((r) => r.autoBlock)).toMatchObject({ autoBlock: 'failed' });
    expect(JSON.stringify(calls)).not.toContain(RULING_NEEDED_LABEL);
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


describe('fresh complete auto-block decisions (#5955)', () => {
  it('discovers a late referral that the first 100 comments omit', () => {
    const pr = parked({ state: 'OPEN' });
    const comments = [...Array.from({ length: 119 }, () => ({ body: 'discussion' })), ...pr.comments];
    const runRuling = vi.fn();
    const out = sweepAutoBlock({ repo, settings: AUTO, runRuling, cardReadable,
      listPrs: () => [{ ...pr, comments: comments.slice(0, 100) }], readPr: () => ({ ...pr, comments }) });
    expect(out).toEqual([{ num: 3794, action: 'auto-blocked', findings: 1, operatorKept: 0 }]);
    expect(runRuling).toHaveBeenCalledTimes(1);
  });
  it.each(['ruling', 'judgment', 'dispute'])('a late %s prevents an obsolete auto-block', (kind) => {
    const snapshot = parked({ state: 'OPEN' });
    let fresh = snapshot;
    if (kind === 'ruling') fresh = { ...snapshot, comments: [...snapshot.comments,
      ...Array.from({ length: 118 }, () => ({ body: 'discussion' })),
      { ...autoPolicyComment(snapshot, { actor: OPERATOR_LOGINS[0] }).comment, author: { login: OPERATOR_LOGINS[0] } }] };
    if (kind === 'judgment') fresh = { ...prWith([J]), comments: [...Array.from({ length: 119 }, () => ({ body: 'discussion' })), ...prWith([J]).comments] };
    if (kind === 'dispute') {
      fresh = { ...snapshot, headRefOid: H4, comments: [...snapshot.comments, autoPolicyComment(snapshot).comment,
        recordComment(record({ head: H2, runId: 'run-2' }), 20), recordComment(record({ head: H3, runId: 'run-3' }), 40),
        ...Array.from({ length: 115 }, () => ({ body: 'discussion' })), recordComment(record({ head: H4, runId: 'run-4' }), 60)] };
    }
    const runRuling = vi.fn();
    expect(sweepAutoBlock({ repo, settings: AUTO, runRuling, cardReadable, humanAt: 2,
      listPrs: () => [snapshot], readPr: () => fresh })).toEqual([]);
    expect(runRuling).not.toHaveBeenCalled();
  });
  it.each([
    ['read error', () => { throw new Error('page 2 failed'); }],
    ['non-array comments', () => parked({ state: 'OPEN', comments: null })],
    ['missing head', () => parked({ state: 'OPEN', headRefOid: '' })],
    ['missing labels', () => parked({ state: 'OPEN', labels: null })],
    ['closed PR', () => parked({ state: 'CLOSED' })],
  ])('never reports successful blocking after %s', (_, readPr) => {
    const runRuling = vi.fn();
    const out = sweepAutoBlock({ repo, settings: AUTO, runRuling, cardReadable, readPr, listPrs: () => [parked()] });
    expect(out[0]).toMatchObject({ action: 'failed', findings: 0, error: expect.stringContaining('live re-read failed') });
    expect(runRuling).not.toHaveBeenCalled();
  });
  it('operator mode performs no discovery, live reads, repository resolution, or writes', () => {
    const listPrs = vi.fn(); const readPr = vi.fn(); const resolveRepo = vi.fn(); const runRuling = vi.fn();
    expect(sweepAutoBlock({ settings: OPERATOR, listPrs, readPr, resolveRepo, runRuling })).toEqual([]);
    for (const fn of [listPrs, readPr, resolveRepo, runRuling]) expect(fn).not.toHaveBeenCalled();
  });
  it('resolves one repository and isolates failed reads, then retries on a later tick', () => {
    const runRuling = vi.fn(); const resolveRepo = vi.fn(() => repo);
    let fail = true;
    const readPr = vi.fn(({ repo: slug, number }) => {
      expect(slug).toBe(repo);
      if (number === 8 && fail) throw new Error('unavailable');
      return parked({ state: 'OPEN', number });
    });
    const sweep = () => sweepAutoBlock({ resolveRepo, readPr, settings: AUTO, runRuling, cardReadable,
      listPrs: () => [{ number: 8 }, { number: 3794 }] });
    expect(sweep().map((r) => r.action)).toEqual(['failed', 'auto-blocked']);
    expect(resolveRepo).toHaveBeenCalledOnce();
    expect(runRuling).toHaveBeenCalledOnce();
    expect(runRuling.mock.calls[0][0]).toContain(`--repo=${repo}`);
    fail = false;
    expect(sweep().every((r) => r.action === 'auto-blocked')).toBe(true);
  });
  it.each([false, true])('composed sweep leaves post-ruling label reconciliation to the mirror (dryRun=%s)', (dryRun) => {
    const trace = [];
    const pr = parked({ state: 'OPEN', labels: [RULING_NEEDED_LABEL] });
    const original = JSON.stringify(pr);
    let ruled = false;
    const runRuling = vi.fn(() => { trace.push('rule'); ruled = true; });
    const readPr = () => {
      trace.push(ruled ? 'read ruled' : 'read pending');
      return { ...pr, comments: ruled ? [...pr.comments, autoPolicyComment(pr).comment] : pr.comments };
    };
    const provider = { currentRepo: () => repo, ensureLabel: vi.fn(), setLabels: vi.fn(() => trace.push('label')) };
    const out = sweepReviewHoldLabels({ repo, settings: AUTO, runRuling, readPr, provider, dryRun, listPrs: () => [pr] });
    expect(out.find((r) => r.autoBlock)).toMatchObject({ autoBlock: 'auto-blocked' });
    if (dryRun) {
      expect(trace).toEqual(['read pending']);
      expect(runRuling).not.toHaveBeenCalled();
      expect(provider.setLabels).not.toHaveBeenCalled();
    } else {
      expect(trace).toEqual(['read pending', 'rule']);
      expect(runRuling).toHaveBeenCalledOnce();
      expect(provider.setLabels).not.toHaveBeenCalled();
    }
    expect(provider.ensureLabel).not.toHaveBeenCalled();
    expect(out.some((r) => 'ruling' in r)).toBe(false);
    expect(JSON.stringify(pr)).toBe(original);
  });
  it('an auto-block read error is reported without a legacy ruling-label pass', () => {
    let reads = 0;
    const readPr = () => { if (++reads === 1) throw new Error('unavailable'); return parked({ state: 'OPEN' }); };
    const provider = { ensureLabel: vi.fn(), setLabels: vi.fn() };
    const runRuling = vi.fn();
    const out = sweepReviewHoldLabels({ repo, settings: AUTO, runRuling, readPr, provider, listPrs: () => [parked()] });
    expect(out.map((r) => r.autoBlock ?? r.ruling)).toEqual(['failed']);
    expect(provider.ensureLabel).not.toHaveBeenCalled();
    expect(provider.setLabels).not.toHaveBeenCalled();
    expect(runRuling).not.toHaveBeenCalled();
    expect(reads).toBe(1);
  });

});


// A ruling is an event on the thread, not a wake that must happen after the pause.
function replay5514({ actor = AUTO_POLICY_ACTOR, evidence = ['policy/pointer.md:12: the live code covers this case'] } = {}) {
  const r = record({ head: H1, runId: 'review-pr-5514', pr: 5514 });
  const key = r.referrals[0].key;
  const initial = recordComment(r, 1);
  const block = { author: { login: 'web-everything' }, createdAt: iso(2), body: buildOperatorRulingComment({
    version: 1, repo, pr: 5514, head: H1, actor, channel: 'review daemon', reason: AUTO_BLOCK_REASON,
    at: iso(2), clearerId: '', rulings: [{ runId: r.runId, key, result: 'block' }] }) };
  const ruled = structuredClone(r);
  ruled.rulings = [{ id: 'nr-5514', key, reviewerId: r.reviewer.id, lens: r.reviewer.lens,
    result: 'not-real', rationale: 'the finding is disproved on the live head', evidence }];
  // The ruling precedes the pause in this synthetic, head-and-key pinned replay.
  const answer = recordComment(ruled, 16);
  const pause = { author: { login: 'web-everything' }, createdAt: iso(29),
    body: 'review paused: 1 referrals need a ruling' };
  const pr = { number: 5514, headRefOid: H1, body: r.authorBody, comments: [initial, block, answer, pause] };
  const run = { repo, pr: 5514, head: H1, parked: true, attempted: true, persistenceFailed: false,
    startedAt: Date.parse(iso(20)), completedAt: Date.parse(iso(29)), count: 1 };
  return { pr, run, r, ruled, answer, block };
}

describe('auto-policy supersession', () => {
  it('an auto-policy block is superseded by a later mandatory-reviewer not-real that carries evidence', () => {
    const { pr } = replay5514();
    const state = mandatoryReferralState(pr.comments, { head: H1 });
    expect(state.pending).toEqual([]);
    expect(state.blocked).toEqual([]);
    expect(blockRuledReferralsFor(pr, { repo })).toEqual([]);
    expect(openReferralFindings({ comments: pr.comments, repo, pr: pr.number, head: H1, body: pr.body }).open).toEqual([]);
  });
  it('PR 5514 replay: the 22:56 operator ruling under the legacy repo slug clears the 23:09 pause', () => {
    const { pr, run, r } = replay5514();
    const ruling = { version: 1, repo: 'chalbert/web-everything', pr: 5514, head: H1,
      actor: OPERATOR_LOGINS[0], channel: 'operator', reason: 'the reviewer already disproved this finding',
      at: '2026-10-17T22:56:39.107Z', clearerId: '',
      rulings: [{ runId: r.runId, key: r.referrals[0].key, result: 'not-real' }] };
    const comments = [pr.comments[0], { author: { login: OPERATOR_LOGINS[0] },
      createdAt: '2026-10-17T22:56:46Z', body: buildOperatorRulingComment(ruling) },
      { ...pr.comments.at(-1), createdAt: '2026-10-17T23:09:18Z' }];
    const live = { ...pr, comments };
    const parked = { ...run, startedAt: Date.parse('2026-10-17T23:00:00Z'), completedAt: Date.parse('2026-10-17T23:09:18Z') };
    expect(decideReferralHold(live, [parked], { repo })).toBeNull();
    expect(rulingNeeded(live)).toBeNull();
    expect(openReferralFindings({ comments, repo, pr: 5514, head: H1 }).open).toEqual([]);
  });
  it('PR 5514 replay: a ruling for an unrelated repository never clears this finding', () => {
    const { pr, run, r } = replay5514();
    const ruling = { version: 1, repo: 'unrelated/web-everything', pr: 5514, head: H1,
      actor: OPERATOR_LOGINS[0], channel: 'operator', reason: 'different repository', at: iso(16), clearerId: '',
      rulings: [{ runId: r.runId, key: r.referrals[0].key, result: 'not-real' }] };
    const live = { ...pr, comments: [pr.comments[0], { author: { login: OPERATOR_LOGINS[0] },
      createdAt: iso(16), body: buildOperatorRulingComment(ruling) }, pr.comments.at(-1)] };
    expect(decideReferralHold(live, [run], { repo })).not.toBeNull();
    expect(rulingNeeded(live)?.findings).toHaveLength(1);
  });
  it('PR 5514 replay: a ruling before the pause already satisfies the live head and key', () => {
    const { pr, run } = replay5514();
    expect(decideReferralHold(pr, [run], { repo, now: Date.parse(iso(30)) })).toBeNull();
    expect(blockRuledReferralsFor(pr, { repo })).toEqual([]);
    expect(rulingNeeded(pr)).toBeNull();
  });
  it('an auto-policy block is NOT superseded by a not-real with no evidence, or by a non-mandatory reviewer', () => {
    const { pr, answer, ruled } = replay5514();
    for (const bad of [{ ...ruled, rulings: [{ ...ruled.rulings[0], evidence: [] }] },
      { ...ruled, rulings: [{ ...ruled.rulings[0], reviewerId: 'other-reviewer' }] }]) {
      const body = answer.body.replace(encodeURIComponent(JSON.stringify(ruled)), encodeURIComponent(JSON.stringify(bad)));
      const comments = [...pr.comments.slice(0, 2), { ...answer, body }];
      expect(mandatoryReferralState(comments, { head: H1 }).blocked).toHaveLength(1);
    }
  });
  it('an operator-sourced block is never superseded by a reviewer not-real', () => {
    const { pr } = replay5514({ actor: OPERATOR_LOGINS[0] });
    expect(mandatoryReferralState(pr.comments, { head: H1 }).blocked).toHaveLength(1);
  });
  it('escalation and dispute text names an auto-policy block as auto-policy, never as the operator ruled', () => {
    const { pr } = replay5514();
    const next = record({ head: H2, runId: 'next', pr: 5514 });
    const ig = ignoredRulings({ ...pr, headRefOid: H2, comments: [...pr.comments.slice(0, 2), recordComment(next, 35)] }, { humanAt: 1 });
    expect(ig.matches).toHaveLength(1);
    for (const text of [rulingDisputeText(5514, ig), fixerRulingBrief(ig), renderRulingNotAddressed(ig)]) {
      expect(text).toContain('auto-policy');
      expect(text).not.toMatch(/the operator (?:already )?(?:ruled|gave)|operator ruling/i);
    }
  });
  it('PR 5514 replay: three escalations over an auto-block collapse to zero once the reviewer ruled not-real', () => {
    const { pr, answer } = replay5514();
    // Three earlier heads each auto-blocked the same finding, then the current head was auto-blocked too.
    const earlier = [H2, H3, H4].flatMap((head, i) => {
      const rec = record({ head, runId: `old-${i}`, pr: 5514 });
      const op = { version: 1, repo, pr: 5514, head, actor: AUTO_POLICY_ACTOR, channel: 'review daemon',
        reason: AUTO_BLOCK_REASON, at: iso(i - 8), clearerId: '',
        rulings: [{ runId: rec.runId, key: rec.referrals[0].key, result: 'block' }] };
      return [recordComment(rec, i - 9), { author: { login: 'web-everything' }, createdAt: op.at, body: buildOperatorRulingComment(op) }];
    });
    const before = { ...pr, comments: [...earlier, ...pr.comments.slice(0, 2)] };
    for (let tick = 0; tick < 3; tick++) expect(ignoredRulings(before, { humanAt: 1 })?.escalate).toBe(true);
    const after = { ...before, comments: [...before.comments, answer, pr.comments.at(-1)] };
    expect(ignoredRulings(after, { humanAt: 1 })).toBeNull();
    expect(rulingNeeded(after, { humanAt: 1 })).toBeNull();
  });
  it('unknown or earlier reviewer chronology and an unreadable ruling record retain the auto-block', () => {
    const { pr, answer } = replay5514();
    for (const time of [undefined, iso(1), iso(2)]) {
      const comments = [...pr.comments.slice(0, 2), { ...answer, createdAt: time }];
      expect(mandatoryReferralState(comments, { head: H1 }).blocked).toHaveLength(1);
    }
    const corrupt = { author: { login: 'web-everything' }, createdAt: iso(18),
      body: '<!-- mandatory-referral-operator-ruling-v1: unreadable -->' };
    const state = mandatoryReferralState([...pr.comments, corrupt], { head: H1 });
    expect(state.blocked).toHaveLength(1);
    expect(state.pending).toContain('malformed-operator-ruling');
  });
  it('a new head or finding requires its own ruling', () => {
    const { pr } = replay5514();
    for (const current of [record({ head: H2, runId: 'new-head', pr: 5514 }),
      record({ head: H1, runId: 'changed-finding', pr: 5514, summary: 'a different broken obligation' })]) {
      const state = mandatoryReferralState([...pr.comments, recordComment(current, 40)], { head: current.head });
      expect(state.pending).toContain(current.referrals[0].key);
    }
  });
  it('the env rollback retains the block and logs its value and source', () => {
    const { pr } = replay5514();
    const log = vi.fn();
    vi.stubEnv('WE_REVIEW_AUTO_BLOCK_YIELDS_TO_REVIEWER_NOT_REAL', 'false');
    try {
      expect(mandatoryReferralState(pr.comments, { head: H1, log }).blocked).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('review.autoBlockYieldsToReviewerNotReal=false (env)'));
    } finally { vi.unstubAllEnvs(); }
  });
  it('resolves the rollback through the review cascade with provenance', () => {
    const settings = resolveReferralSafetySettings({ fileConfig: null, platform: { autoBlockYieldsToReviewerNotReal: false }, env: {} });
    expect(settings.value.autoBlockYieldsToReviewerNotReal).toBe(false);
    expect(settings.sources.autoBlockYieldsToReviewerNotReal).toBe('platform');
    const { pr } = replay5514();
    expect(mandatoryReferralState(pr.comments, { head: H1, autoBlockYieldsToReviewerNotReal: false }).blocked).toHaveLength(1);
  });
});
