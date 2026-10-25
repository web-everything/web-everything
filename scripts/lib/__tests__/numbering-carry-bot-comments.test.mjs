import { describe, expect, it, vi } from 'vitest';
import { isNumberingTolerableLaterBody, planNumberingRestamp } from '../numbering-carry.mjs';
import { applyHumanClearanceCarry, latestHumanClearance } from '../human-clearance-carry.mjs';
import { normalizeDiffFingerprint } from '../review-escalation.mjs';
import { buildLandingRetractionComment } from '../../operations/land-prevention-card.mjs';
import { buildClearanceComment } from '../drain-merge-strategy.mjs';
import { buildGateComment } from '../../operations/red-team-gate-apply.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

// Replay the #5759 ordering. Only the reported SHA prefixes are known; the suffixes
// below are synthetic. The git proof is injected, not inferred from these SHAs.
const FROM = 'f7c0342cc1' + '0'.repeat(30);
const TO = 'a16e32cdb2' + '0'.repeat(30);
const BEFORE = 'diff --git a/backlog/item.md b/backlog/item.md\n--- a/backlog/item.md\n+++ b/backlog/item.md\n@@ -1 +1 @@\n-old\n+xhkw054 xxwio5a\n';
const AFTER = BEFORE.replace('+xhkw054 xxwio5a', '+#7065 #7066');
const ON = { value: true, source: 'test' };
const comment = (body, login, minute = 2) => ({
  body, author: { login }, createdAt: `2026-10-25T10:0${minute}:00Z`,
});
const retraction = () => buildLandingRetractionComment({
  headSha: FROM, session: 'prevention-card-5759',
  result: { step: 'landing', reason: 'landing job failed' },
});
// Same exported renderers and options as accept-carry-forward.replay.test.mjs.
const advisory = () => renderRedTeamComment({
  pr: 5759, rev: TO, provider: 'codex', model: 'm',
  findings: [], recheckStatus: 'ok', foldedVerdict: 'accept',
});
const gate = (outcome = 'card-queued') => buildGateComment({
  pr: 5759, head: TO, outcome,
  plan: {
    sendBack: outcome === 'sent-back' ? [{ index: 1 }] : [],
    card: outcome === 'card-queued' ? [{ index: 1 }] : [], advisory: [],
  },
  cardResult: { ok: true, session: 'prevention-card-123' },
});

describe('numbering carry recognises trusted machine comments with author metadata', () => {
  it.each([
    ['landing retraction', retraction(), 'web-everything[bot]'],
    ['drain enqueue clearance', buildClearanceComment(TO), 'web-everything[bot]'],
    ['non-blocking red-team advisory', advisory(), 'web-everything[bot]'],
    ['card-queued red-team gate', gate(), 'web-everything[bot]'],
  ])('tolerates a trusted %s', (_kind, body, login) => {
    expect(isNumberingTolerableLaterBody(body, comment(body, login))).toBe(true);
  });

  it('fails closed on a landing retraction from an untrusted author', () => {
    const body = retraction();
    expect(isNumberingTolerableLaterBody(body, comment(body, 'mallory'))).toBe(false);
  });

  it.each([
    ['appended objection', body => `${body}\nDo not merge; this approval is withdrawn.`],
    ['prepended prose', body => `Do not merge.\n${body}`],
    ['malformed marker', body => body.replace('approval-prevention-retracted:', 'approval-prevention-retracted head=')],
    ['invalid SHA', body => body.replace(FROM, 'not-a-sha')],
  ])('fails closed on a retraction-looking body with %s', (_kind, change) => {
    const body = change(retraction());
    expect(isNumberingTolerableLaterBody(body, comment(body, 'web-everything[bot]'))).toBe(false);
  });

  it('retains a sent-back red-team gate as a hold even from a trusted author', () => {
    const body = gate('sent-back');
    expect(isNumberingTolerableLaterBody(body, comment(body, 'web-everything[bot]'))).toBe(false);
  });

  it.each([
    ['advisory', advisory()], ['card-queued gate', gate()],
  ])('fails closed on a body-only red-team %s without author metadata', (_kind, body) => {
    expect(isNumberingTolerableLaterBody(body)).toBe(false);
  });
});

function acceptedThread() {
  const markers = `<!-- reviewed-sha: ${FROM} -->\n<!-- reviewed-diff: ${normalizeDiffFingerprint(BEFORE)} -->\n<!-- cleared-human: chalbert -->`;
  return [
    comment(`✅ review — human cleared\n${markers}`, 'chalbert', 0),
    // The acceptance record retains the human clearance on the same head.
    comment(`✅ review — accepted\n${markers}`, 'web-everything[bot]', 1),
  ];
}
function machineNotes() {
  return [
    comment(retraction(), 'web-everything[bot]', 2),
    comment('<!-- drain-skip-reason -->\nskipped: numbering carry awaiting recheck', 'web-everything[bot]', 3),
    comment(buildClearanceComment(TO), 'web-everything[bot]', 4),
  ];
}
const changes = () => comment('🔁 review — changes requested\nA genuine defect needs fixing.', 'chalbert', 5);
const plan = comments => planNumberingRestamp({
  labels: ['review:pending'], headSha: TO, comments, reviews: [],
});

function applyWithLiveThread(liveComments) {
  const initial = acceptedThread();
  const proveNumbering = vi.fn(() => ({
    ok: true, reason: 'verified numbering: xhkw054 → #7065, xxwio5a → #7066',
  }));
  const exec = vi.fn(() => '');
  const readNumberingLiveEvidence = vi.fn(() => ({ headSha: TO, comments: liveComments, reviews: [] }));
  const result = applyHumanClearanceCarry({
    pr: 5759, numberingOnly: true, equivalence: 'strict',
    setting: ON, numberingSetting: ON, netPatchSetting: { value: false, source: 'test' },
    evidence: {
      humanClearance: latestHumanClearance(initial),
      headSha: TO, headDiffSha: TO, headDiff: AFTER,
    },
    exec, proveNumbering, readNumberingLiveEvidence, log: () => {},
  });
  // These assertions distinguish live-thread rejection from a fixture/proof failure.
  expect(proveNumbering).toHaveBeenCalledTimes(1);
  expect(proveNumbering.mock.calls[0][0]).toMatchObject({ fromSha: FROM, toSha: TO });
  expect(readNumberingLiveEvidence).toHaveBeenCalledTimes(1);
  return { result, exec };
}

describe('#5759 numbering move after human clearance', () => {
  it('the planner nominates the human acceptance across trusted retraction and drain notes', () => {
    expect(plan([...acceptedThread(), ...machineNotes()])).toMatchObject({
      candidate: true, from: FROM, to: TO, human: true, actor: 'chalbert',
    });
  });

  it('the live re-read carries a proven numbering move across trusted retraction and drain notes', () => {
    const { result, exec } = applyWithLiveThread([...acceptedThread(), ...machineNotes()]);
    expect(result).toMatchObject({
      carried: { fromSha: FROM, toSha: TO, actor: 'chalbert', tier: 'numbering', recorded: true },
    });
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args.slice(0, 4)).toEqual(['pr', 'comment', '5759', '--body']);
    expect(args[4]).toContain(`from=${FROM} to=${TO}`);
  });

  it('the planner still refuses a genuine later changes verdict beside the same machine notes', () => {
    expect(plan([...acceptedThread(), ...machineNotes(), changes()])).toMatchObject({ candidate: false, hold: true });
  });

  it('the live re-read defers without recording when a genuine changes verdict arrives after proof', () => {
    const { result, exec } = applyWithLiveThread([...acceptedThread(), ...machineNotes(), changes()]);
    expect(result).toMatchObject({ action: 'defer', applyLabel: null });
    expect(result.reason).toContain('a later verdict or unknown comment stands');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('enqueue-clearance recognition stays an exact, trusted-author envelope', () => {
  const clearance = () => buildClearanceComment(TO);
  it.each([
    ['trailing prose after the envelope', `${clearance()}\nDo not merge; this approval is withdrawn.`],
    ['marker line only plus a verdict', `<!-- we-drain-enqueue-clearance head=${TO} -->\nDo not merge; this approval is withdrawn.`],
  ])('refuses %s even from a trusted author', (_k, body) => {
    expect(isNumberingTolerableLaterBody(body, comment(body, 'web-everything[bot]'))).toBe(false);
    expect(isNumberingTolerableLaterBody(body)).toBe(false);
  });
  it('refuses the exact envelope from an untrusted author', () => {
    expect(isNumberingTolerableLaterBody(clearance(), comment(clearance(), 'mallory'))).toBe(false);
  });
});
