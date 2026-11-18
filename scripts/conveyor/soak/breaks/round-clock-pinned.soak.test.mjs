/**
 * @file breaks/round-clock-pinned.soak.test.mjs — `runSoak({ pinRoundClock: true })` really pins the round (main red 2026-11-18, first
 * red commit 325a7f76f: the long soak starved a different owed PR depending on host speed). Round 0 is made deliberately
 * slow in wall-clock terms; the pinned soak must still start round 1 exactly one round budget (3 virtual minutes) after
 * round 0, while the old `advance('3m')` would land a full wall-clock round later.
 */
import { expect, it } from 'vitest';
import { runSoak } from '../soak.mjs';
import { ROUND_VIRTUAL_MS } from '../round-clock.mjs';

const SLOW_ROUND_MS = 4_000;

async function roundStarts({ pinRoundClock }) {
  const starts = [];
  await runSoak({
    name: `round-clock-${pinRoundClock ? 'pinned' : 'fixed-advance'}`, rounds: 2, daemons: ['review'], mainEvery: 0, churnEvery: 0,
    fleet: false, pinRoundClock, log: () => {},
    perRound: async (w, round) => {
      starts.push(w.clock.now());
      if (round === 0) await new Promise((resolve) => setTimeout(resolve, SLOW_ROUND_MS)); // a slow host
    },
  });
  return starts;
}

it('a pinned soak starts every round one virtual round budget after the last, however slow the round was', async () => {
  const [r0, r1] = await roundStarts({ pinRoundClock: true });
  const gap = r1 - r0;
  expect(gap).toBeGreaterThanOrEqual(ROUND_VIRTUAL_MS);
  expect(gap).toBeLessThan(ROUND_VIRTUAL_MS + SLOW_ROUND_MS / 2);
}, 600_000);

it('the unpinned soak drifts by the round\'s wall-clock time (the behaviour pinRoundClock removes)', async () => {
  const [r0, r1] = await roundStarts({ pinRoundClock: false });
  expect(r1 - r0).toBeGreaterThanOrEqual(ROUND_VIRTUAL_MS + SLOW_ROUND_MS);
}, 600_000);
