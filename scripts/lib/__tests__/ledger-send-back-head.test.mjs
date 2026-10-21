import { describe, expect, it } from 'vitest';
import { buildLedgerEvent, buildVerdictRecord } from '../verdict-ledger.mjs';
import { derivePrState } from '../pr-state.mjs';

const repo = 'example/repo', pr = 1, at = '2026-10-17T12:00:00.000Z';
const old = 'a'.repeat(40), head = 'b'.repeat(40), next = 'c'.repeat(40);
const verdict = (kind, headSha, extra = {}) => buildVerdictRecord({
  repo, pr, at, source: 'test', verdict: kind, headSha, ...extra,
});
const sentBack = () => buildLedgerEvent({ repo, pr, at, source: 'test', type: 'send-back', cause: 'changes' });
const codes = (events, sha) => derivePrState(events, {
  repo, pr, now: at, head: { sha }, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [],
}).holds.map(hold => hold.code);

describe('send-back binds to the applied head before its append', () => {
  const delayedRows = [
    ['superseded acceptance', verdict('accepted', old)],
    ['abbreviated superseded restamp', verdict('restamped', old.slice(0, 7))],
    ['stale snapshot hold', verdict('changes', old)],
    ['delayed transition', verdict('head-moved', next, { fromHead: old })],
    ['headless park', verdict('human', null)],
  ];
  for (const [name, delayed] of delayedRows) it(`a ${name} never moves the binding of a new send-back off B`, () => {
    const events = [verdict('accepted', old), verdict('head-moved', head, { fromHead: old }), delayed, sentBack()];
    // The delayed row must not make a send-back of B bind to A (or C) instead of B and release immediately.
    expect(codes(events, head)).toContain('send-back');
    // A was reviewed before the send-back, and a row naming it may be a fresh review after a force-push back, so A is held too.
    expect(codes(events, old)).toContain('send-back');
    const moved = [...events, verdict('head-moved', next, { fromHead: head })];
    expect(codes(moved, next)).not.toContain('send-back');
    expect(derivePrState([...moved, verdict('accepted', next)], {
      repo, pr, now: at, head: { sha: next }, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [],
    }).clears).toBe(true);
    // A subsequent send-back binds to C; a delayed acceptance at B cannot release it.
    expect(codes([...moved, verdict('accepted', head), sentBack()], next)).toContain('send-back');
  });
});

describe('send-back after a force-push back to a superseded head whose observation append missed', () => {
  const clears = (events, sha) => derivePrState(events, {
    repo, pr, now: at, head: { sha }, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [],
  });
  // A fresh changes(A) after A→B reads exactly like a delayed one, so the send-back holds at both A and B.
  it('holds at the reviewed head A, and a later observation and acceptance of A without a push cannot release it', () => {
    const events = [verdict('accepted', old), verdict('head-moved', head, { fromHead: old }), verdict('changes', old), sentBack()];
    expect(codes(events, old)).toContain('send-back');
    const caughtUp = [...events, verdict('head-moved', old, { fromHead: head }), verdict('accepted', old)];
    const state = clears(caughtUp, old);
    expect(state.holds.map(h => h.code)).toContain('send-back');
    expect(state.clears).toBe(false);
    // The next push after the rejection releases it.
    expect(codes([...caughtUp, verdict('head-moved', next, { fromHead: old })], next)).not.toContain('send-back');
  });
  it('a delayed transition appended after the fresh review does not move the binding past it', () => {
    const events = [verdict('accepted', old), verdict('head-moved', head, { fromHead: old }), verdict('changes', old),
      verdict('head-moved', next, { fromHead: head }), sentBack()];
    expect(codes(events, old)).toContain('send-back');
    expect(codes(events, next)).toContain('send-back');
  });
  it('a revert to an earlier reviewed head after a send-back stays held until a new head is pushed', () => {
    const events = [verdict('accepted', old), verdict('head-moved', head, { fromHead: old }), verdict('changes', head), sentBack(),
      verdict('head-moved', old, { fromHead: head }), verdict('accepted', old)];
    expect(codes(events, old)).toContain('send-back');
    expect(codes([...events, verdict('head-moved', next, { fromHead: old })], next)).not.toContain('send-back');
  });
  it('a review-run naming the superseded head binds the send-back to it too', () => {
    const events = [verdict('accepted', old), verdict('head-moved', head, { fromHead: old }),
      buildLedgerEvent({ repo, pr, at, source: 'test', type: 'review-run', phase: 'completed', posted: false, headSha: old }), sentBack()];
    expect(codes(events, old)).toContain('send-back');
    expect(codes(events, head)).toContain('send-back');
    expect(codes(events, next)).not.toContain('send-back');
  });
});

describe('send-back that records the head its writer sent back', () => {
  const recorded = sha => buildLedgerEvent({ repo, pr, at, source: 'test', type: 'send-back', cause: 'changes', headSha: sha });
  const state = (events, sha) => derivePrState(events, {
    repo, pr, now: at, head: { sha }, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [],
  });
  it('binds to the recorded head when its observation arrives only after the send-back', () => {
    // B was pushed and sent back before any ledger row named it; the late head-moved and acceptance of B do not release it.
    const events = [verdict('accepted', old), recorded(head), verdict('head-moved', head, { fromHead: old }), verdict('accepted', head)];
    const s = state(events, head);
    expect(s.holds.map(h => h.code)).toContain('send-back');
    expect(s.clears).toBe(false);
    expect(codes([...events, verdict('head-moved', next, { fromHead: head })], next)).not.toContain('send-back');
  });
  it('binds to the recorded head when the only later row is a fresh acceptance of it', () => {
    const events = [verdict('accepted', old), recorded(head), verdict('accepted', head)];
    expect(state(events, head).clears).toBe(false);
  });
  it('a recorded head is normalized, a legacy row records none, and a non-SHA head is refused', () => {
    expect(recorded(` ${head.toUpperCase()} `).headSha).toBe(head);
    expect(sentBack().headSha).toBeUndefined();
    expect(() => recorded('not-a-sha')).toThrow(/invalid send-back event/);
  });
});
