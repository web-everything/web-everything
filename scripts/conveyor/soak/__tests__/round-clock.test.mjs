/**
 * @file round-clock.test.mjs — a soak round occupies the same virtual time on a fast and a slow host (main red
 * 2026-11-18, first red commit 325a7f76f: the long soak starved a different owed PR depending on host speed).
 */
import { describe, expect, it } from 'vitest';
import { ROUND_VIRTUAL_MS, advanceMsForRound } from '../round-clock.mjs';

/** Total virtual time a soak spends over `realRoundMs` wall-clock per round: real time passes on the clock, the
 *  end-of-round advance tops it up to the budget. */
function virtualElapsed(rounds, realRoundMs) {
  let virtual = 0;
  for (let i = 0; i < rounds; i += 1) virtual += realRoundMs + advanceMsForRound(realRoundMs);
  return virtual;
}

describe('advanceMsForRound', () => {
  it('tops a round up to exactly the virtual budget, so a fast and a slow host end every round at the same instant', () => {
    const fast = virtualElapsed(25, 23_000); // ~570 s soak
    const slow = virtualElapsed(25, 35_000); // ~870 s soak
    expect(fast).toBe(25 * ROUND_VIRTUAL_MS);
    expect(slow).toBe(fast);
  });

  it('never rewinds: a round slower than its budget overruns instead of moving the clock back', () => {
    expect(advanceMsForRound(ROUND_VIRTUAL_MS + 5_000)).toBe(0);
  });

  it('treats a garbage reading as no real time spent', () => {
    expect(advanceMsForRound(NaN)).toBe(ROUND_VIRTUAL_MS);
    expect(advanceMsForRound(-1)).toBe(ROUND_VIRTUAL_MS);
  });
});
