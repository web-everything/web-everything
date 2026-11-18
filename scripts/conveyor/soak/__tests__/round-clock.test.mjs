/**
 * @file round-clock.test.mjs — a soak round occupies the same virtual time on a fast and a slow host (main red
 * 2026-11-18, first red commit 325a7f76f: the long soak starved a different owed PR depending on host speed).
 * Drives the production round clock over the REAL sim clock (`sim/clock.mjs`) with an injected wall clock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSimClock } from '../../__tests__/sim/clock.mjs';
import { REPO_ROOT } from '../shard-files.mjs';
import { CHILD_CLOCK_TOLERANCE_MS, ROUND_VIRTUAL_MS, advanceMsForRound, checkChildClock, createRoundClock } from '../round-clock.mjs';

/** Run `rounds` rounds that each take `realRoundMs` of wall-clock time; return the virtual instant after each. */
function virtualInstants(rounds, realRoundMs, { pinned }) {
  const wall = { t: 1_000_000_000_000 };
  const sim = createSimClock({});
  const real = wall; // the sim clock reads real + offset; the injected wall clock stands in for real
  const virtualNow = () => real.t + sim.offsetMs();
  const pin = createRoundClock(sim, () => wall.t);
  pin.begin();
  const start = virtualNow();
  const ends = [];
  for (let i = 0; i < rounds; i += 1) {
    wall.t += realRoundMs; // the round's ticks and sessions run
    if (pinned) pin.endRound(); else sim.advance('3m');
    ends.push(virtualNow() - start);
  }
  return ends;
}

describe('round clock', () => {
  it('ends every round at the same virtual instant on a fast and a slow host', () => {
    const fast = virtualInstants(25, 23_000, { pinned: true }); // ~570 s soak
    const slow = virtualInstants(25, 35_000, { pinned: true }); // ~870 s soak
    expect(slow).toEqual(fast);
    expect(fast.map((v, i) => v - (i + 1) * ROUND_VIRTUAL_MS)).toEqual(Array(25).fill(0));
  });

  it('the old fixed 3m advance drifts with host speed (the bug this pins)', () => {
    const fast = virtualInstants(25, 23_000, { pinned: false });
    const slow = virtualInstants(25, 35_000, { pinned: false });
    expect(slow[24]).toBeGreaterThan(fast[24]);
  });

  it('never rewinds: a round slower than its budget overruns instead of moving the clock back', () => {
    expect(advanceMsForRound(ROUND_VIRTUAL_MS + 5_000)).toBe(0);
  });

  it('rejects a broken wall-clock reading instead of guessing', () => {
    expect(() => advanceMsForRound(NaN)).toThrow(TypeError);
    expect(() => advanceMsForRound(Infinity)).toThrow(TypeError);
    expect(() => advanceMsForRound(-1)).toThrow(TypeError);
  });

  it('reports an overrun instead of silently running on a host too slow to pin', () => {
    const wall = { t: 0 };
    const advances = [];
    const pin = createRoundClock({ advance: (ms) => advances.push(ms) }, () => wall.t);
    pin.begin();
    wall.t += ROUND_VIRTUAL_MS + 5_000;
    expect(pin.endRound()).toEqual({ overrunMs: 5_000 });
    wall.t += 1_000;
    expect(pin.endRound()).toEqual({ overrunMs: 0 });
    expect(advances).toEqual([0, ROUND_VIRTUAL_MS - 1_000]);
  });

  it('charges the time the advance itself takes to the next round, so a slow advance is compensated, not leaked', () => {
    const wall = { t: 0 };
    const advances = [];
    const SLOW_ADVANCE_MS = 2_000;
    const pin = createRoundClock({ advance: (ms) => { advances.push(ms); wall.t += SLOW_ADVANCE_MS; } }, () => wall.t);
    pin.begin();
    wall.t += 10_000;
    pin.endRound(); // round 0: 10 s of work, then a 2 s advance
    wall.t += 8_000; // round 1's own work
    pin.endRound(); // round 1 is timed from before the 2 s advance: 10 s
    expect(advances).toEqual([ROUND_VIRTUAL_MS - 10_000, ROUND_VIRTUAL_MS - 10_000]);
  });

  it('fails closed when a child process does not see the parent\'s virtual time (a preload that read offset 0)', () => {
    const parentNowMs = 1_000_000_000_000 + ROUND_VIRTUAL_MS;
    const child = (now) => () => String(now);
    expect(checkChildClock({ env: {}, parentNowMs, exec: child(parentNowMs + 40) }).ok).toBe(true);
    const ignored = checkChildClock({ env: {}, parentNowMs, exec: child(parentNowMs - ROUND_VIRTUAL_MS) });
    expect(ignored.ok).toBe(false);
    expect(ignored.skewMs).toBe(ROUND_VIRTUAL_MS);
    expect(ROUND_VIRTUAL_MS).toBeGreaterThan(CHILD_CLOCK_TOLERANCE_MS);
    expect(checkChildClock({ env: {}, parentNowMs, exec: child('garbage') }).ok).toBe(false);
  });

  it('requires begin() before endRound()', () => {
    expect(() => createRoundClock({ advance() {} }).endRound()).toThrow(/before begin/);
  });

  it('is what the long soak uses: runSoak builds the round clock only for pinRoundClock, and run.mjs sets it', () => {
    const soak = readFileSync(join(REPO_ROOT, 'scripts/conveyor/soak/soak.mjs'), 'utf8');
    const run = readFileSync(join(REPO_ROOT, 'scripts/conveyor/soak/run.mjs'), 'utf8');
    expect(soak).toMatch(/pinRoundClock \? createRoundClock\(/);
    expect(soak).toMatch(/roundClock\.endRound\(\)/);
    expect(run).toMatch(/runSoak\(\{[^}]*pinRoundClock: true/);
  });
});
