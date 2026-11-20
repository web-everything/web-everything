import { describe, it, expect, vi } from 'vitest';
import { decideSetLabel, runReviewLabelCli, buildVerdictComment } from '../review-set-label.mjs';
import { gateOutcomesForHead, sendBackStepOutcome, GATE_OUTCOMES, redTeamGateMarker } from '../lib/red-team-gate.mjs';
import { PR_COMMENTS_PAGE_SIZE } from '../lib/review-label-provider.mjs';

const PR = 7031;
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const record = (outcome = GATE_OUTCOMES.SENT_BACK, rev = HEAD, login = 'web-everything') => ({
  author: { login }, body: redTeamGateMarker(PR, rev, outcome),
});
const sentBack = (comments, head = HEAD) => sendBackStepOutcome(gateOutcomesForHead(comments, PR, head)) === GATE_OUTCOMES.SENT_BACK;
const apply = (labels, decision) => [...new Set([...labels.filter(l => !decision.removeLabels.includes(l)), decision.addLabel])];

function accept({ labels = ['review:changes'], comments = [record()], head = HEAD, readComments } = {}) {
  let liveLabels = [...labels];
  const posted = [];
  const output = [];
  const signalFix = vi.fn();
  const provider = {
    readPrState: () => ({ state: 'OPEN', headRefOid: head, labels: liveLabels, comments, body: '' }),
    readComments: readComments ?? (() => comments),
    readLabels: () => liveLabels,
    setLabels: (_repo, _pr, { add, remove }) => { liveLabels = apply(liveLabels, { addLabel: add, removeLabels: remove }); },
    postComment: (_repo, _pr, body) => { posted.push(body); },
  };
  const stopped = new Error('CLI exit');
  let exitCode;
  const exit = vi.spyOn(process, 'exit').mockImplementation(code => { exitCode = code; throw stopped; });
  try { runReviewLabelCli({
    argv: [String(PR), '--repo=o/n', '--to=accepted'], defaultActor: 'test', usage: 'test', provider,
    buildComment: o => buildVerdictComment(o), successResult: o => ({ ok: true, ...o }),
    refusalResult: o => ({ ok: false, ...o }), emit: line => output.push(JSON.parse(line)),
    appendLedgerVerdict: () => ({ ok: true }), signalFix,
    fileApprovalPrevention: vi.fn(), findFiledApprovalPrevention: () => null,
  }); } catch (error) { if (error !== stopped) throw error; } finally { exit.mockRestore(); }
  return { labels: liveLabels, posted, result: output.at(-1), signalFix, exitCode };
}

function expectKept(result) {
  expect(result.labels).toContain('review:changes');
  expect(result.labels).not.toContain('review:accepted');
  expect(result.labels).not.toContain('review:pending');
  expect(result.result.to).toBe('changes');
  expect(result.posted.join('\n')).not.toMatch(/reviewed-sha|✅ review — accepted/);
  expect(result.signalFix).toHaveBeenCalledWith(expect.objectContaining({ label: 'review:changes' }));
}

describe('accept keeps a red-team send-back', () => {
  it('the pure option applies only to accepts carrying changes', () => {
    expect(decideSetLabel({ to: 'accepted', currentLabels: ['review:pending'], sentBackSameHead: true }).addLabel).toBe('review:accepted');
    expect(decideSetLabel({ to: 'rearm', currentLabels: ['review:changes'], sentBackSameHead: true }).addLabel).toBe('review:pending');
  });

  it('pure decision keeps same-head sent-back changes and removes only present pending', () => {
    const decision = decideSetLabel({ to: 'accepted', currentLabels: ['review:changes', 'review:pending'], sentBackSameHead: sentBack([record()]) });
    expect(decision).toMatchObject({ allowed: true, addLabel: 'review:changes', removeLabels: ['review:pending'] });
    expect(decision.reason).toMatch(/send.back/i);
    expect(decideSetLabel({ to: 'accepted', currentLabels: ['review:changes'], sentBackSameHead: true }).removeLabels).toEqual([]);
  });

  it('CLI accept over same-head sent-back keeps changes without an acceptance stamp or success framing', () => {
    expectKept(accept({ labels: ['review:changes', 'review:pending'] }));
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
    expectKept(accept({ labels: sentBackLabels }));
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
    expectKept(accept({ comments, readComments }));
  });

  it('reads the full thread so a send-back beyond the embedded page still holds', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({ id: i, body: 'ordinary comment' }));
    expectKept(accept({ comments, readComments: () => [...comments, record()] }));
  });
});
