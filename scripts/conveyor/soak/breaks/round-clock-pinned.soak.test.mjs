/**
 * @file breaks/round-clock-pinned.soak.test.mjs — `runSoak({ pinRoundClock: true })` really pins the round (main red
 * 2026-11-18, first red commit 325a7f76f: the long soak starved a different owed PR depending on host speed). Round 0 is
 * made deliberately slow in wall-clock terms; the pinned soak must still start round 1 exactly one round budget
 * (3 virtual minutes) after round 0, while the old `advance('3m')` would land a full wall-clock round later.
 *
 * The time is read the way the daemons and the lane pool read it: from a CHILD node process started with the world's
 * env (the sim clock preload in `NODE_OPTIONS`), not from the test's own process. A child that ignored the advance
 * would read ~0 virtual time between rounds and fail the lower bound. The default fleet is seeded, so the daemons tick
 * over real PRs, and the run's own report (fatal, violations, tick count) must be clean.
 */
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { runSoak } from '../soak.mjs';
import { ROUND_VIRTUAL_MS } from '../round-clock.mjs';

const SLOW_ROUND_MS = 4_000;

/** `Date.now()` as a daemon child process sees it under this world's sim clock. */
function childNow(w) {
  return Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(Date.now()))'], {
    env: { ...process.env, ...w.env }, encoding: 'utf8', timeout: 30_000,
  }));
}

async function roundStarts({ pinRoundClock }) {
  const starts = [];
  const report = await runSoak({
    name: `round-clock-${pinRoundClock ? 'pinned' : 'fixed-advance'}`, rounds: 2, daemons: ['review'], mainEvery: 0, churnEvery: 0,
    pinRoundClock, log: () => {},
    perRound: async (w, round) => {
      starts.push(childNow(w));
      if (round === 0) await new Promise((resolve) => setTimeout(resolve, SLOW_ROUND_MS)); // a slow host
    },
  });
  // The run itself must have completed cleanly: a crash, timeout or invariant failure in round 1 may not pass.
  expect(report.fatal).toBeNull();
  expect(report.ticks.length).toBe(2);
  expect(report.violations).toEqual([]);
  return starts;
}

it('a pinned soak starts every round one virtual round budget after the last, however slow the round was', async () => {
  const [r0, r1] = await roundStarts({ pinRoundClock: true });
  // Within half the slow round of one budget: the two reads sit a few ms apart in wall-clock terms, not 4 s.
  expect(Math.abs(r1 - r0 - ROUND_VIRTUAL_MS)).toBeLessThan(SLOW_ROUND_MS / 2);
}, 600_000);

it('the unpinned soak drifts by the round\'s wall-clock time (the behaviour pinRoundClock removes)', async () => {
  const [r0, r1] = await roundStarts({ pinRoundClock: false });
  expect(r1 - r0).toBeGreaterThanOrEqual(ROUND_VIRTUAL_MS + SLOW_ROUND_MS);
}, 600_000);
