import { describe, expect, it } from 'vitest';
import { buildLedgerEvent, buildVerdictRecord, observedLedgerHead } from '../verdict-ledger.mjs';
import { derivePrState } from '../pr-state.mjs';

const repo = 'example/repo', pr = 1, at = '2026-10-17T12:00:00.000Z';
const old = 'a'.repeat(40), head = 'b'.repeat(40), next = 'c'.repeat(40);
const verdict = (kind, headSha, extra = {}) => buildVerdictRecord({ repo, pr, at, source: 'test', verdict: kind, headSha, ...extra });
const event = (type, extra = {}) => buildLedgerEvent({ repo, pr, at, source: 'test', type, ...extra });
const held = (events, sha) => derivePrState(events, {
  repo, pr, now: at, head: { sha }, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [],
}).holds.some(hold => hold.code === 'send-back');

describe('send-back recovery when a head observation append was missed', () => {
  for (const [type, extra] of [
    ['review-run', { phase: 'completed', posted: false }],
    ['referral', { findingKeys: ['finding'] }],
    ['review-exempt', { basis: 'no review owed' }],
  ]) {
    it(`retains a fresh ${type} head after an older verdict`, () => {
      const events = [verdict('accepted', old), event(type, { headSha: head, ...extra }), event('send-back', { cause: 'changes' })];
      expect(held(events, head)).toBe(true);
      expect(held(events, next)).toBe(false);
      // Such an event is a send-back witness, not an authoritative lifecycle observation for the planner.
      expect(observedLedgerHead(events)).toBe(old);
    });
    it(`ignores a delayed ${type} for a known superseded head`, () => {
      const events = [verdict('accepted', old), verdict('head-moved', head, { fromHead: old }),
        event(type, { headSha: old, ...extra }), event('send-back', { cause: 'changes' })];
      expect(held(events, head)).toBe(true);
      expect(held(events, next)).toBe(false);
    });
  }
});
