import { describe, it, expect, vi } from 'vitest';
import { decideSetLabel, runReviewLabelCli, buildVerdictComment } from '../review-set-label.mjs';
import { gateOutcomesForHead, sendBackStepOutcome, gateRoundGrants, GATE_OUTCOMES, redTeamGateMarker } from '../lib/red-team-gate.mjs';
import { buildRoundExtensionComment } from '../conveyor/round-extension-mark.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { normalizeFinding, referralFindingKey, mandatoryReferralReviewer, renderReferralRecord } from '../lib/jury-core.mjs';
import { PR_COMMENTS_PAGE_SIZE } from '../lib/review-label-provider.mjs';

const PR = 7031;
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const record = (outcome = GATE_OUTCOMES.SENT_BACK, rev = HEAD, login = 'web-everything') => ({
  author: { login }, body: redTeamGateMarker(PR, rev, outcome),
});
const sentBack = (comments, head = HEAD) => sendBackStepOutcome(gateOutcomesForHead(comments, PR, head)) === GATE_OUTCOMES.SENT_BACK;
const apply = (labels, decision) => [...new Set([...labels.filter(l => !decision.removeLabels.includes(l)), decision.addLabel])];

function accept({ labels = ['review:changes'], comments = [record()], head = HEAD, readComments, freshComments = comments, freshHead = head, freshThrows = false, postCommentState = {}, readGrantScope = () => null } = {}) {
  let liveLabels = [...labels];
  const posted = [];
  const output = [];
  const signalFix = vi.fn();
  const appendLedgerVerdict = vi.fn(() => ({ ok: true }));
  const setLabels = vi.fn((_repo, _pr, { add, remove }) => { liveLabels = apply(liveLabels, { addLabel: add, removeLabels: remove }); });
  let reads = 0;
  let afterPost = {};
  const provider = {
    readPrState: () => {
      if (reads++ && freshThrows) throw new Error('fresh state unavailable');
      return { state: 'OPEN', headRefOid: reads > 1 ? freshHead : head, labels: liveLabels, comments: reads > 1 ? freshComments : comments, body: '', ...afterPost };
    },
    readComments: readComments ?? (() => comments),
    readLabels: () => liveLabels,
    setLabels,
    postComment: (_repo, _pr, body) => { posted.push(body); afterPost = postCommentState; },
  };
  const stopped = new Error('CLI exit');
  let exitCode;
  const exit = vi.spyOn(process, 'exit').mockImplementation(code => { exitCode = code; throw stopped; });
  try { runReviewLabelCli({
    argv: [String(PR), '--repo=o/n', '--to=accepted'], defaultActor: 'test', usage: 'test', provider,
    buildComment: o => buildVerdictComment(o), successResult: o => ({ ok: true, ...o }),
    refusalResult: o => ({ ok: false, ...o }), emit: line => output.push(JSON.parse(line)),
    appendLedgerVerdict, signalFix, readGrantScope,
    fileApprovalPrevention: vi.fn(), findFiledApprovalPrevention: () => null,
  }); } catch (error) { if (error !== stopped) throw error; } finally { exit.mockRestore(); }
  return { labels: liveLabels, posted, result: output.at(-1), signalFix, exitCode, setLabels, appendLedgerVerdict };
}

function expectRefused(result, labels = ['review:changes']) {
  expect(result.exitCode).toBe(1);
  expect(result.labels).toEqual(labels);
  expect(result.posted).toEqual([]);
  expect(result.setLabels).not.toHaveBeenCalled();
  expect(result.appendLedgerVerdict).not.toHaveBeenCalled();
  expect(result.signalFix).not.toHaveBeenCalled();
  expect(result.result.decision?.reason ?? result.result.error).toMatch(/send.back|unreadable|head changed|malformed|unavailable/i);
}

describe('accept refuses a red-team send-back without writes', () => {
  it('pure decision refuses from pending too, while rearm remains unaffected', () => {
    expect(decideSetLabel({ to: 'accepted', currentLabels: ['review:pending'], sentBackSameHead: true })).toMatchObject({ allowed: false, addLabel: '', removeLabels: [] });
    expect(decideSetLabel({ to: 'rearm', currentLabels: ['review:changes'], sentBackSameHead: true }).addLabel).toBe('review:pending');
  });

  it('pure decision refuses same-head sent-back changes without a label mutation', () => {
    const decision = decideSetLabel({ to: 'accepted', currentLabels: ['review:changes', 'review:pending'], sentBackSameHead: true });
    expect(decision).toMatchObject({ allowed: false, addLabel: '', removeLabels: [] });
    expect(decision.reason).toMatch(/send.back/i);
  });

  it('CLI refusal leaves every label untouched and writes no comment, ledger row or stamp', () => {
    const labels = ['review:changes', 'review:pending', 'review:accepted', 'ready-to-merge', 'redteam:accepted', 'advisory:accepted'];
    expectRefused(accept({ labels }), labels);
  });

  it.each([['review:pending'], []])('refuses a same-head send-back even with labels %j', (...labels) => {
    expectRefused(accept({ labels }), labels);
  });

  it('accept on a newer head is unaffected: exact rev equality is required', () => {
    expect(sentBack([record()], NEW_HEAD)).toBe(false);
    const result = accept({ head: NEW_HEAD });
    expect(result.labels).toContain('review:accepted');
    expect(result.labels).not.toContain('review:changes');
    expect(result.result.to).toBe('accepted');
  });

  it.each([[GATE_OUTCOMES.ROUND_CAP], [GATE_OUTCOMES.SENT_BACK, GATE_OUTCOMES.ROUND_CAP]])('round-cap is not a send-back (%j)', (...outcomes) => {
    const comments = outcomes.map(outcome => record(outcome));
    expect(sentBack(comments)).toBe(false);
    expect(accept({ comments }).labels).toEqual(['review:accepted']);
  });

  it('an untrusted author cannot hold acceptance with a forged gate record', () => {
    const comments = [record(GATE_OUTCOMES.SENT_BACK, HEAD, 'mallory')];
    expect(sentBack(comments)).toBe(false);
    expect(accept({ comments }).labels).toEqual(['review:accepted']);
  });

  it('replays #7031: changes, rearm to pending, red-team send-back, same-head re-accept still owes a fix', () => {
    const rearmed = apply(['review:changes'], decideSetLabel({ to: 'rearm', currentLabels: ['review:changes'] }));
    expect(rearmed).toEqual(['review:pending']);
    const sentBackLabels = apply(rearmed, decideSetLabel({ to: 'changes', currentLabels: rearmed, reason: 'confirmed red-team break' }));
    expectRefused(accept({ labels: sentBackLabels }));
  });

  it('unreadable embedded comment thread keeps changes, never accepts', () => {
    const result = accept({ comments: null });
    expect(result.labels).toEqual(['review:changes']);
    expect(result.posted).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it.each(['throws', 'unreadable', 'incomplete'])('no fail-open catch: complete gate-record read %s keeps changes', mode => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({ id: i, body: 'ordinary comment' }));
    const readComments = () => { if (mode === 'throws') throw new Error('thread unavailable'); return mode === 'unreadable' ? null : []; };
    expectRefused(accept({ comments, readComments }));
  });

  it('reads the full thread so a send-back beyond the embedded page still holds', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({ id: i, body: 'ordinary comment' }));
    expectRefused(accept({ comments, readComments: () => [...comments, record()] }));
  });

  it('a superseded cap plus a grant and later send-back still refuses', () => {
    const grant = { author: { login: OPERATOR_LOGINS[0] }, body: buildRoundExtensionComment({
      repo: 'o/n', pr: PR, by: 1, actor: OPERATOR_LOGINS[0], channel: 'test', reason: 'one more fix', at: '2026-11-20T00:00:00Z',
    }) };
    const comments = [record(GATE_OUTCOMES.ROUND_CAP), grant, record()];
    const readGrantScope = vi.fn(() => null);
    expectRefused(accept({ comments, readGrantScope }));
    expect(readGrantScope).toHaveBeenCalledWith({ repo: 'o/n', pr: { number: PR, headRefOid: HEAD, comments } });
  });

  it('a stale cap posted after the granted send-back cannot override its snapshot', () => {
    const grant = { author: { login: OPERATOR_LOGINS[0] }, body: buildRoundExtensionComment({
      repo: 'o/n', pr: PR, by: 1, actor: OPERATOR_LOGINS[0], channel: 'test', reason: 'one more fix', at: '2026-11-20T00:00:00Z',
    }) };
    const resultId = '1'.repeat(16);
    const grantIds = gateRoundGrants([grant], PR, 'o/n').map(g => g.id);
    expect(grantIds).toHaveLength(1);
    const comments = [grant,
      { author: { login: 'web-everything' }, body: redTeamGateMarker(PR, HEAD, GATE_OUTCOMES.SENT_BACK, resultId, grantIds) },
      { author: { login: 'web-everything' }, body: redTeamGateMarker(PR, HEAD, GATE_OUTCOMES.ROUND_CAP, resultId, []) },
    ];
    expectRefused(accept({ comments }));
  });

  it('a cap for a different result cannot override a send-back', () => {
    const comments = [
      { author: { login: 'web-everything' }, body: redTeamGateMarker(PR, HEAD, GATE_OUTCOMES.ROUND_CAP, '1'.repeat(16)) },
      { author: { login: 'web-everything' }, body: redTeamGateMarker(PR, HEAD, GATE_OUTCOMES.SENT_BACK, '2'.repeat(16)) },
    ];
    expectRefused(accept({ comments }));
  });

  it('a send-back appearing in the fresh pre-write thread refuses before ledger, comment and labels', () => {
    expectRefused(accept({ comments: [], freshComments: [record()] }));
  });

  it('re-reads a full fresh thread and refuses a send-back arriving past its embedded page', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, () => ({ body: 'ordinary' }));
    let reads = 0;
  let afterPost = {};
    expectRefused(accept({ comments, readComments: () => reads++ ? [...comments, record()] : comments }));
    expect(reads).toBe(2);
  });

  it.each([[null], [{}], [{ body: 1 }], ['ordinary comment']])('malformed short embedded thread entry %j refuses', entry => {
    expectRefused(accept({ comments: [entry] }));
  });

  it.each([null, [{}], [{ body: 1 }]])('malformed fresh evidence %j refuses', freshComments => {
    expectRefused(accept({ comments: [], freshComments }));
  });

  it('a malformed entry in the paginated thread refuses', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, () => ({ body: 'ordinary' }));
    expectRefused(accept({ comments, readComments: () => [...comments, null] }));
  });

  it('refuses the acceptance label when the head changes during postComment', () => {
    const result = accept({ comments: [], postCommentState: { headRefOid: NEW_HEAD } });
    expect(result.exitCode).toBe(1);
    expect(result.result.error).toMatch(/head changed before acceptance/i);
    expect(result.posted).toHaveLength(1);
    expect(result.appendLedgerVerdict).toHaveBeenCalledTimes(1);
    expect(result.setLabels).not.toHaveBeenCalled();
    expect(result.labels).toEqual(['review:changes']);
    expect(result.signalFix).not.toHaveBeenCalled();
  });

  it('refuses the acceptance label when a mandatory referral arrives during postComment', () => {
    const original = { summary: 'broken', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const referral = { version: 1, repo: 'o/n', pr: PR, head: HEAD, runId: 'run-late-referral',
      reviewer: mandatoryReferralReviewer('run-late-referral'), authorBody: '<!-- authored-by-actor: author -->', attempted: true,
      referrals: [{ key: referralFindingKey('judgeAdvisory', original), seat: 'judgeAdvisory', original, finding: normalizeFinding(original) }], rulings: [] };
    const comments = [{ author: { login: 'web-everything' }, body: renderReferralRecord(referral) }];
    const result = accept({ comments: [], postCommentState: { comments } });
    expect(result.exitCode).toBe(1);
    expect(result.result.error).toMatch(/mandatory referral hold/i);
    expect(result.posted).toHaveLength(1);
    expect(result.appendLedgerVerdict).toHaveBeenCalledTimes(1);
    expect(result.setLabels).not.toHaveBeenCalled();
    expect(result.labels).toEqual(['review:changes']);
    expect(result.signalFix).not.toHaveBeenCalled();
  });

  it('refuses the acceptance label when a send-back arrives during postComment', () => {
    const result = accept({ comments: [], postCommentState: { comments: [record()] } });
    expect(result.exitCode).toBe(1);
    expect(result.result.error).toMatch(/same-head red-team send-back/i);
    expect(result.posted).toHaveLength(1);
    expect(result.appendLedgerVerdict).toHaveBeenCalledTimes(1);
    expect(result.setLabels).not.toHaveBeenCalled();
    expect(result.labels).toEqual(['review:changes']);
    expect(result.signalFix).not.toHaveBeenCalled();
  });

  it('a bad initial head refuses acceptance', () => {
    expectRefused(accept({ comments: [], head: 'bad-head' }));
  });

  it('a bad fresh head refuses acceptance', () => {
    expectRefused(accept({ comments: [], freshHead: 'bad-head' }));
  });

  it('a thrown fresh state read refuses acceptance', () => {
    expectRefused(accept({ comments: [], freshThrows: true }));
  });
});
