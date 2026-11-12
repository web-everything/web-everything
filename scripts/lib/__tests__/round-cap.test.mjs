import { describe, it, expect } from 'vitest';
import { resolveRoundCap, effectiveRoundCap } from '../round-cap.mjs';
import { resolveRoundCap as coreResolve } from '../../conveyor/reconcile-core.mjs';
import { buildGateComment } from '../../operations/red-team-gate-apply.mjs';
import { GATE_OUTCOMES } from '../red-team-gate.mjs';

describe('card 8062: one shared round-cap resolver', () => {
  it('defaults to the shared negotiation cap and honours the env setting', () => {
    expect(resolveRoundCap({})).toBe(5);
    expect(resolveRoundCap({ WE_REVIEW_ROUND_CAP: '7' })).toBe(7);
    expect(resolveRoundCap({ WE_REVIEW_ROUND_CAP: '0' })).toBe(5);
    expect(resolveRoundCap({ WE_REVIEW_ROUND_CAP: 'x' })).toBe(5);
  });
  it('every reader returns the same cap for the same settings', () => {
    for (const env of [{}, { WE_REVIEW_ROUND_CAP: '9' }, { WE_REVIEW_ROUND_CAP: '-1' }]) {
      expect(coreResolve(env)).toBe(resolveRoundCap(env));
    }
  });
  it('applies a per-PR extension on top of the same base', () => {
    const env = { WE_REVIEW_ROUND_CAP: '6' };
    expect(effectiveRoundCap({ env, grants: [{ by: 2, at: 'x' }] })).toBe(8);
    expect(effectiveRoundCap({ env, grants: [{ by: 1, at: 'x' }], roundAt: () => 10 })).toBe(11);
  });
  it('the red-team gate takes its default cap from the resolver, not a fixed 5', () => {
    const prev = process.env.WE_REVIEW_ROUND_CAP;
    process.env.WE_REVIEW_ROUND_CAP = '8';
    try {
      const body = buildGateComment({ pr: 1, head: 'abc', outcome: GATE_OUTCOMES.ROUND_CAP, plan: { sendBack: [{ index: 1 }], card: [], advisory: [] }, round: 8 });
      expect(body).toContain('round cap (8)');
    } finally { if (prev === undefined) delete process.env.WE_REVIEW_ROUND_CAP; else process.env.WE_REVIEW_ROUND_CAP = prev; }
  });
});
