// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RED_TEAM_HOLDS, redTeamOwedDecision, redTeamReadReviewable } from '../review-red-team-policy.mjs';
import { parseRedTeamComment } from '../red-team-gate.mjs';
import { reviewedRead, completedSeat, completedComment } from './fixtures/red-team-owed.mjs';

const head = 'a'.repeat(40), fromRev = 'b'.repeat(40);
const pass = (rev = head) => ({ head: rev, read: reviewedRead(rev),
  seats: [{ ...completedSeat(rev), valid: true }], result: parseRedTeamComment(completedComment(42, rev).body),
  scheduling: { scheduled: true, inFlight: false, queued: false, skipCardOnly: true } });
describe('redTeamOwedDecision', () => {
  it('clears only a completed result, scored head-bound diff, and completed valid seat together', () => {
    expect(redTeamOwedDecision(pass())).toEqual({ owed: true, cleared: true, reasons: [] });
    for (const over of [{ result: null }, { seats: [] }, { seats: [{ ...completedSeat(head), status: 'error', valid: true }] },
      { result: { ...pass().result, rev: fromRev } }, { result: { ...pass().result, completedReview: false } }]) {
      expect(redTeamOwedDecision({ ...pass(), ...over }).cleared).toBe(false);
    }
  });
  it('a publishable policy-clear never pays execution debt, and one bad row poisons a completed pass', () => {
    expect(redTeamOwedDecision({ ...pass(), result: { ...pass().result, shapedLines: [],
      policyClear: true, completedReview: false } }).reasons).toContainEqual(RED_TEAM_HOLDS['result-incomplete']);
    expect(redTeamOwedDecision({ ...pass(), seats: [...pass().seats, { valid: false }] }).reasons)
      .toContainEqual(RED_TEAM_HOLDS['seat-rows-invalid']);
  });
  it('exempts only a reviewable card-only head without seats or live work', () => {
    const card = { ...pass(), read: reviewedRead(head, ['backlog/123-card.md']), seats: [], result: null,
      scheduling: { skipCardOnly: true } };
    expect(redTeamOwedDecision(card)).toEqual({ owed: false, cleared: true, reasons: [] });
    expect(redTeamOwedDecision({ ...card, scheduling: { ...card.scheduling, scheduled: true } }).owed).toBe(false);
    for (const field of ['inFlight', 'queued', 'recorded']) {
      expect(redTeamOwedDecision({ ...card, scheduling: { ...card.scheduling, [field]: true } }).owed).toBe(true);
    }
    expect(redTeamOwedDecision({ ...card, scheduling: { skipCardOnly: false } }).owed).toBe(true);
  });
  it('rejects missing, empty, unscored and foreign-head reads', () => {
    for (const read of [undefined, { ...reviewedRead(head), diffText: '  ' },
      { ...reviewedRead(head), diffScored: false }, reviewedRead(fromRev)]) {
      expect(redTeamReadReviewable(read, head)).toBe(false);
      expect(redTeamOwedDecision({ ...pass(), read }).reasons).toContainEqual(RED_TEAM_HOLDS['unreviewable-read']);
    }
  });
  it('recorded execution needs both a publishable completed result and completed valid seat rows', () => {
    const recorded = { ...pass(), scheduling: { ...pass().scheduling, recorded: true } };
    expect(redTeamOwedDecision(recorded)).toEqual({ owed: true, cleared: true, reasons: [] });
    for (const over of [{ result: null, seats: [] }, { result: null }, { seats: [] },
      { result: { ...recorded.result, completedReview: false } }]) {
      const decision = redTeamOwedDecision({ ...recorded, ...over });
      expect(decision).toMatchObject({ owed: true, cleared: false });
      expect(decision.reasons).toContainEqual(RED_TEAM_HOLDS['result-incomplete']);
    }
  });
  it.each([undefined, null, 'scripts/source.mjs'])('missing or non-array rename sources are unreadable: %j', netRenameSources => {
    const read = { ...reviewedRead(head, ['backlog/123-card.md']), netRenameSources };
    expect(redTeamReadReviewable(read, head)).toBe(false);
    expect(redTeamOwedDecision({ ...pass(), read, seats: [], result: null }).reasons)
      .toContainEqual(RED_TEAM_HOLDS['unreviewable-read']);
    expect(redTeamReadReviewable({ ...read, netRenameSources: [] }, head)).toBe(true);
  });
  it('requires source clearance and the same non-null result id for carry', () => {
    const input = { ...pass(), seats: [], carry: { fromRev, proof: pass(fromRev) } };
    expect(redTeamOwedDecision(input).cleared).toBe(true);
    expect(redTeamOwedDecision({ ...input, result: { ...input.result, completedReview: false } }).cleared).toBe(false);
    for (const proof of [{ ...pass(fromRev), read: null }, { ...pass(fromRev), seats: [] },
      { ...pass(fromRev), result: parseRedTeamComment(completedComment(42, fromRev, [{
        summary: 'different result', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true,
      }]).body) }]) {
      expect(redTeamOwedDecision({ ...input, carry: { fromRev, proof } }).reasons).toContainEqual(RED_TEAM_HOLDS['carry-conflict']);
    }
  });
  it('uses a fixed blocking table and cleared is exactly absence of holds', () => {
    expect(Object.values(RED_TEAM_HOLDS).filter(h => !h.blocking).map(h => h.kind).sort()).toEqual(['pass-owed', 'pending-publish']);
    for (const input of [pass(), {}, { ...pass(), ok: false, reason: 'scan-capped' },
      { ...pass(), hasBreak: true }, { ...pass(), pendingPublish: true }, { ...pass(), carryConflict: true }]) {
      const d = redTeamOwedDecision(input);
      expect(d.cleared).toBe(d.reasons.length === 0);
      for (const hold of d.reasons) expect(hold.blocking).toBe(RED_TEAM_HOLDS[hold.kind].blocking);
    }
  });
});
