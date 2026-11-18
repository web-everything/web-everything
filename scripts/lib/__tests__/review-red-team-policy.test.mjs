// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RED_TEAM_HOLDS, redTeamOwedDecision, redTeamReadReviewable } from '../review-red-team-policy.mjs';
import { parseRedTeamComment } from '../red-team-gate.mjs';
import { reviewedRead, completedSeat, completedComment, exemptInput, completedRuns, runIdentity } from './fixtures/red-team-owed.mjs';

const head = 'a'.repeat(40), fromRev = 'b'.repeat(40);
const pass = (rev = head) => ({ head: rev, missingInputs: [], read: reviewedRead(rev), runs: completedRuns(),
  seats: [{ ...completedSeat(rev), valid: true }], result: parseRedTeamComment(completedComment(42, rev).body),
  scheduling: { scheduled: true, inFlight: false, queued: false, skipCardOnly: true, commentsReadable: true, settingsReadable: true } });
describe('redTeamOwedDecision', () => {
  it('clears only a completed result, scored head-bound diff, and completed valid seat together', () => {
    expect(redTeamOwedDecision(pass())).toEqual({ owed: true, cleared: true, reasons: [] });
    for (const over of [{ result: null }, { seats: [] }, { seats: [{ ...completedSeat(head), status: 'error', valid: true }] },
      { result: { ...pass().result, rev: fromRev } }, { result: { ...pass().result, completedReview: false } }]) {
      expect(redTeamOwedDecision({ ...pass(), ...over }).cleared).toBe(false);
    }
  });
  it('canonical audit B: a completed result and seat cannot clear unreadable comments and settings', () => {
    const input = pass(); input.scheduling.commentsReadable = false; input.scheduling.settingsReadable = false;
    expect(redTeamOwedDecision(input)).toMatchObject({ owed: true, cleared: false });
    expect(redTeamOwedDecision(input).reasons).toContainEqual(RED_TEAM_HOLDS['evidence-unknown']);
  });
  it.each(['commentsReadable', 'settingsReadable'])('completed-pass clearance needs explicit %s=true', key => {
    for (const value of [undefined, null, false, 'true', 1, {}]) {
      const input = pass();
      if (value === undefined) delete input.scheduling[key]; else input.scheduling[key] = value;
      expect(redTeamOwedDecision(input), `${key}=${JSON.stringify(value)}`).toMatchObject({ owed: true, cleared: false });
    }
  });
  it.each(['queued', 'inFlight'])('canonical audit C: %s work holds despite an earlier completed result and seat', key => {
    for (const value of [true, undefined, null, 'false', 0]) {
      const input = pass();
      if (value === undefined) delete input.scheduling[key]; else input.scheduling[key] = value;
      expect(redTeamOwedDecision(input)).toMatchObject({ owed: true, cleared: false });
      expect(redTeamOwedDecision(input).reasons).toContainEqual(RED_TEAM_HOLDS['pass-owed']);
      const carried = { ...pass(), seats: [], carry: { ...runIdentity, fromRev, proof: { ...input, head: fromRev,
        read: reviewedRead(fromRev), result: pass(fromRev).result, seats: pass(fromRev).seats } } };
      expect(redTeamOwedDecision(carried).cleared).toBe(false);
    }
  });
  it.each([
    [true, false, true], [false, true, true], [true, true, true], [false, false, true],
    [undefined, false, true], [false, undefined, true], ['false', false, true], [false, null, true],
  ])('pass-owed is always blocking for inFlight=%j queued=%j', (inFlight, queued, blocking) => {
    const input = { ...pass(), result: null, seats: [], scheduling: { ...pass().scheduling, inFlight, queued } };
    const reasons = redTeamOwedDecision(input).reasons;
    expect(reasons.find(hold => hold.kind === 'pass-owed')).toMatchObject({ kind: 'pass-owed', blocking });
    const publishing = redTeamOwedDecision({ ...input, pendingPublish: true });
    expect(publishing.reasons.find(hold => hold.kind === 'pending-publish').blocking).toBe(false);
    expect(publishing.reasons.find(hold => hold.kind === 'pass-owed').blocking).toBe(blocking);
  });
  it('a publishable policy-clear never pays execution debt, and one bad row poisons a completed pass', () => {
    expect(redTeamOwedDecision({ ...pass(), result: { ...pass().result, shapedLines: [],
      policyClear: true, completedReview: false } }).reasons).toContainEqual(RED_TEAM_HOLDS['result-incomplete']);
    expect(redTeamOwedDecision({ ...pass(), seats: [...pass().seats, { valid: false }] }).reasons)
      .toContainEqual(RED_TEAM_HOLDS['seat-rows-invalid']);
  });
  it('exempts only a reviewable card-only head without seats or live work', () => {
    const card = exemptInput(head);
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
    const input = { ...pass(), runs: { ...completedRuns(), carry: [{ ...runIdentity, outcome: 'complete' }] }, seats: [], carry: { ...runIdentity, fromRev, proof: pass(fromRev) } };
    expect(redTeamOwedDecision(input).cleared).toBe(true);
    expect(redTeamOwedDecision({ ...input, result: { ...input.result, completedReview: false } }).cleared).toBe(false);
    for (const proof of [{ ...pass(fromRev), read: null }, { ...pass(fromRev), seats: [] },
      { ...pass(fromRev), result: parseRedTeamComment(completedComment(42, fromRev, [{
        summary: 'different result', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true,
      }]).body) }]) {
      expect(redTeamOwedDecision({ ...input, carry: { fromRev, proof } }).reasons).toContainEqual(RED_TEAM_HOLDS['carry-conflict']);
    }
  });
  it.each([{ blocked: true }, { storedVerdict: 'changes' }])('recorded break %j survives exemption and incomplete proof; a completed pass resolves it', recorded => {
    const card = { ...exemptInput(head), ...recorded };
    expect(redTeamOwedDecision(card).reasons).toContainEqual(RED_TEAM_HOLDS.break);
    expect(redTeamOwedDecision({ ...pass(), ...recorded })).toMatchObject({ owed: true, cleared: true });
    expect(redTeamOwedDecision({ ...pass(), ...recorded, seats: [] }).reasons).toContainEqual(RED_TEAM_HOLDS.break);
    expect(redTeamOwedDecision({ ...pass(), ...recorded, hasBreak: true }).reasons).toContainEqual(RED_TEAM_HOLDS.break);
    expect(redTeamOwedDecision({ ...card, breakResolved: true })).toMatchObject({ owed: false, cleared: true });
    const stillOwed = redTeamOwedDecision({ ...pass(), ...recorded, result: null, breakResolved: true });
    expect(stillOwed.cleared).toBe(false); // Resolution never pays execution debt.
  });
  it.each(['comment', 'seats', 'execution', 'verdict', 'carry'])('amendment 3: %s requires the latest shared run identity and determinate append order', key => {
    const make = () => {
      const input = pass();
      if (key === 'carry') {
        input.seats = [];
        input.runs.carry = [{ ...runIdentity, outcome: 'complete' }];
        input.carry = { ...runIdentity, fromRev, proof: pass(fromRev) };
      }
      return input;
    };
    expect(redTeamOwedDecision(make()).cleared).toBe(true);
    const newerFailure = make();
    newerFailure.runs[key].push({ runId: 'newer-failed-run', order: 1, outcome: 'break' });
    expect(redTeamOwedDecision(newerFailure).reasons).toContainEqual(RED_TEAM_HOLDS.break);
    for (const corrupt of [row => { delete row.runId; }, row => { delete row.order; },
      row => { row.order = '0'; }, row => { row.order = -1; }]) {
      const input = make(); corrupt(input.runs[key][0]);
      expect(redTeamOwedDecision(input).reasons).toContainEqual(RED_TEAM_HOLDS['evidence-unknown']);
    }
    const conflictingId = make(); conflictingId.runs[key][0].runId = 'other-run-same-position';
    expect(redTeamOwedDecision(conflictingId).reasons).toContainEqual(RED_TEAM_HOLDS['evidence-unknown']);
    for (const records of [
      [{ runId: 'other', order: 0, outcome: 'complete' }], // Equal positions cannot name different runs.
      [{ runId: 'other', order: 1, outcome: 'complete' }, { ...runIdentity, outcome: 'complete' }], // Reversed append order.
    ]) {
      const input = make(); input.runs[key].push(...records);
      expect(redTeamOwedDecision(input).reasons).toContainEqual(RED_TEAM_HOLDS['evidence-unknown']);
    }
  });
  it('carry propagates a newer source failure as break and missing source identity as unknown', () => {
    const source = pass(fromRev);
    source.runs.execution.push({ runId: 'newer-failed-run', order: 1, outcome: 'break' });
    const input = { ...pass(), seats: [], runs: { ...completedRuns(), carry: [{ ...runIdentity, outcome: 'complete' }] },
      carry: { ...runIdentity, fromRev, proof: source } };
    expect(redTeamOwedDecision(input).reasons).toContainEqual(RED_TEAM_HOLDS.break);
    delete source.runs.execution[1].runId;
    expect(redTeamOwedDecision(input).reasons).toContainEqual(RED_TEAM_HOLDS['evidence-unknown']);
  });
  it('explicit resolution releases same-run changes but never a newer changes verdict', () => {
    const input = { ...pass(), breakResolved: true };
    input.runs.verdict[0].outcome = 'changes';
    input.runs.seats[0].outcome = 'changes';
    expect(redTeamOwedDecision(input).cleared).toBe(true);
    input.runs.verdict.push({ runId: 'newer-changes-run', order: 1, outcome: 'changes' });
    expect(redTeamOwedDecision(input).reasons).toContainEqual(RED_TEAM_HOLDS.break);
  });
  it('completed proof cannot clear an omitted input-completeness attestation', () => {
    const input = pass(); delete input.missingInputs;
    expect(redTeamOwedDecision(input).reasons).toContainEqual(expect.objectContaining({ kind: 'evidence-unknown', blocking: true }));
  });
  it('uses fixed hold kinds with only pending-publish non-blocking; cleared is exactly absence of holds', () => {
    expect(Object.values(RED_TEAM_HOLDS).filter(h => !h.blocking).map(h => h.kind).sort()).toEqual(['pending-publish']);
    for (const input of [pass(), {}, { ...pass(), ok: false, reason: 'scan-capped' },
      { ...pass(), hasBreak: true }, { ...pass(), pendingPublish: true }, { ...pass(), carryConflict: true }]) {
      const d = redTeamOwedDecision(input);
      expect(d.cleared).toBe(d.reasons.length === 0);
      for (const hold of d.reasons) expect(hold.blocking).toBe(RED_TEAM_HOLDS[hold.kind].blocking);
    }
  });
});
