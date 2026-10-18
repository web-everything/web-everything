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
