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
  for (const [name, delayed] of delayedRows) it(`ignores a ${name} when binding a new send-back`, () => {
    const events = [verdict('accepted', old), verdict('head-moved', head, { fromHead: old }), delayed, sentBack()];
    // The delayed row must not make a send-back of B bind to A (or C) and release immediately.
    expect(codes(events, head)).toContain('send-back');
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
  it('a review-run naming the superseded head binds the send-back to it too', () => {
    const events = [verdict('accepted', old), verdict('head-moved', head, { fromHead: old }),
      buildLedgerEvent({ repo, pr, at, source: 'test', type: 'review-run', phase: 'completed', posted: false, headSha: old }), sentBack()];
    expect(codes(events, old)).toContain('send-back');
    expect(codes(events, head)).toContain('send-back');
    expect(codes(events, next)).not.toContain('send-back');
  });
});
