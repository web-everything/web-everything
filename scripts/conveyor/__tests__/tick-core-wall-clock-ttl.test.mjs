/** #3383 — Guard TTLs are wall-clock when a guard carries `spawnedAt`: hook ticks arrive at a variable rate. */
import { describe, it, expect } from 'vitest';
import {
  guardTtlElapsed, TTL_MS_PER_TICK, retireBuildGuards, retirePrepareGuards, retireFixGuards, retireCiHealGuards,
  planPrepareSpawns, planFixSpawns, planCiHealSpawns, planTick, DEFAULT_BUILD_TTL_TICKS, DEFAULT_FIX_TTL_TICKS,
} from '../tick-core.mjs';

const T0 = 10_000_000;
const buildGuard = { num: 5, lane: 2, spawnedTick: 0, spawnedAt: T0 };

describe('guardTtlElapsed', () => {
  it('one TTL tick is worth the resident runner\'s 120 s interval', () => expect(TTL_MS_PER_TICK).toBe(120_000));
  it('a BURST of ticks (many ticks, little wall time) does not expire a guard early', () => {
    expect(guardTtlElapsed(buildGuard, { tick: 10, now: T0 + 3 * 60_000, ttlTicks: 3 })).toBe(false);
  });
  it('a SPARSE tick (one tick, much wall time) expires a guard on time', () => {
    expect(guardTtlElapsed(buildGuard, { tick: 1, now: T0 + 3 * TTL_MS_PER_TICK, ttlTicks: 3 })).toBe(true);
    expect(guardTtlElapsed(buildGuard, { tick: 1, now: T0 + 3 * TTL_MS_PER_TICK - 1, ttlTicks: 3 })).toBe(false);
  });
  it('a guard with no wall-clock stamp, or a caller with no clock, keeps the original tick-count rule', () => {
    expect(guardTtlElapsed({ spawnedTick: 0 }, { tick: 3, now: T0, ttlTicks: 3 })).toBe(true);
    expect(guardTtlElapsed({ spawnedTick: 0 }, { tick: 2, now: T0, ttlTicks: 3 })).toBe(false);
    expect(guardTtlElapsed(buildGuard, { tick: 3, now: null, ttlTicks: 3 })).toBe(true);
    expect(guardTtlElapsed({}, { tick: 4, ttlTicks: 3 })).toBe(false); // no stamp at all: age 0
  });
  it('a clock that went backwards past the stamp falls back to the tick count, never a negative age', () => {
    expect(guardTtlElapsed(buildGuard, { tick: 3, now: T0 - 1_000_000, ttlTicks: 3 })).toBe(true);
    expect(guardTtlElapsed(buildGuard, { tick: 1, now: T0 - 1_000_000, ttlTicks: 3 })).toBe(false);
  });
});

describe('the four retire functions use it', () => {
  const idle = { tick: 9, ttlTicks: 3 };
  it('build', () => {
    const args = { lanes: [], queue: [{ num: 5, buildQueued: true }], ...idle };
    expect(retireBuildGuards([buildGuard], { ...args, now: T0 + 60_000 }).live).toHaveLength(1);
    expect(retireBuildGuards([buildGuard], { ...args, now: T0 + 3 * TTL_MS_PER_TICK }).retired).toEqual([{ num: 5, lane: 2, reason: 'ttl', note: true }]);
    expect(retireBuildGuards([{ ...buildGuard, spawnedAt: undefined }], { ...args, now: T0 + 60_000 }).retired).toHaveLength(1); // legacy: ticks
  });
  it('prepare (only while no PR has ever appeared)', () => {
    const g = { num: 8, kind: 'prepare', lane: 3, spawnedTick: 0, spawnedAt: T0, sawPr: false };
    const args = { unshaped: [{ num: 8 }], prs: [], tick: 9, ttlTicks: 5 };
    expect(retirePrepareGuards([g], { ...args, now: T0 + 60_000 }).live).toHaveLength(1);
    expect(retirePrepareGuards([g], { ...args, now: T0 + 5 * TTL_MS_PER_TICK }).live).toHaveLength(0);
  });
  it('fix', () => {
    const g = { pr: 40, num: 4, lane: 1, spawnedTick: 0, spawnedAt: T0, claimed: false };
    const prs = [{ num: 4, prNumber: 40, state: 'OPEN', labels: ['review:changes'] }];
    expect(retireFixGuards([g], { prs, lanes: [], tick: 9, now: T0 + 60_000, ttlTicks: DEFAULT_FIX_TTL_TICKS }).live).toHaveLength(1);
    expect(retireFixGuards([g], { prs, lanes: [], tick: 9, now: T0 + 5 * TTL_MS_PER_TICK, ttlTicks: DEFAULT_FIX_TTL_TICKS }).retired[0]).toMatchObject({ reason: 'ttl-unclaimed' });
  });
  it('ci-heal', () => {
    const g = { pr: 41, num: 4, lane: 1, spawnedTick: 0, spawnedAt: T0 };
    const prs = [{ num: 4, prNumber: 41, state: 'OPEN', labels: [], ci: 'failed' }];
    const live = (now) => retireCiHealGuards([g], { prs, tick: 9, now, ttlTicks: 5 });
    expect(live(T0 + 60_000).live.length + live(T0 + 60_000).retired.length).toBe(1);
    expect(live(T0 + 5 * TTL_MS_PER_TICK).live).toHaveLength(0);
  });
});

describe('guards are stamped with the wall clock only when a clock is given', () => {
  it('prepare, fix and ci-heal spawns', () => {
    expect(planPrepareSpawns({ unshaped: [{ num: 8 }], availableLanes: [3], tick: 4, now: T0 }).newGuards).toEqual([{ num: 8, kind: 'prepare', lane: 3, spawnedTick: 4, spawnedAt: T0, sawPr: false }]);
    expect(planPrepareSpawns({ unshaped: [{ num: 8 }], availableLanes: [3], tick: 4 }).newGuards).toEqual([{ num: 8, kind: 'prepare', lane: 3, spawnedTick: 4, sawPr: false }]);
    const prs = [{ num: 4, prNumber: 40, state: 'OPEN', labels: ['review:changes'] }];
    expect(planFixSpawns({ prs, launchedNums: [4], availableLanes: [1], tick: 2, now: T0 }).newGuards).toEqual([{ pr: 40, num: 4, lane: 1, spawnedTick: 2, spawnedAt: T0, claimed: false }]);
    expect(planFixSpawns({ prs, launchedNums: [4], availableLanes: [1], tick: 2 }).newGuards[0]).not.toHaveProperty('spawnedAt');
  });
  it('planTick stamps new build guards and never re-stamps a durable-floor guard on re-synthesis', () => {
    const state = { queue: [{ num: 5, buildQueued: true }], prs: [], lanes: [], needsSlice: [], decisions: [] };
    const first = planTick({ state, plan: { launch: [{ num: 5, lane: 2 }] }, freeLanes: [2], bookkeeping: { tick: 0 }, now: T0 });
    expect(first.nextState.buildGuards).toEqual([{ num: 5, lane: 2, spawnedTick: 0, spawnedAt: T0 }]);
    // Durable floor: a listed session with no in-session guard. First seen at T0+1s, kept sticky afterwards.
    const dur = (bookkeeping, now) => planTick({ state: { queue: [], prs: [], lanes: [], needsSlice: [], decisions: [] }, plan: { launch: [] }, freeLanes: [],
      liveAgentSessions: [{ name: 'conveyor-9' }], bookkeeping, now }).nextState.buildGuards;
    const g1 = dur({ tick: 1 }, T0 + 1000);
    expect(g1).toEqual([{ num: '9', lane: null, spawnedTick: 1, spawnedAt: T0 + 1000 }]);
    expect(dur({ tick: 2, buildGuards: g1 }, T0 + 500_000)).toEqual(g1);
  });
  it('a burst of ticks does not retire a fresh build guard that a bare tick count would have', () => {
    const state = { queue: [{ num: 5, buildQueued: true }], prs: [], lanes: [], needsSlice: [], decisions: [] };
    let bookkeeping = planTick({ state, plan: { launch: [{ num: 5, lane: 2 }] }, freeLanes: [2], bookkeeping: { tick: 0 }, now: T0 }).nextState;
    for (let i = 1; i <= DEFAULT_BUILD_TTL_TICKS + 2; i += 1) {
      const out = planTick({ state, plan: { launch: [] }, freeLanes: [], bookkeeping, now: T0 + i * 5_000 }); // ticks 5 s apart
      expect(out.nextState.buildGuards).toHaveLength(1);
      bookkeeping = out.nextState;
    }
  });
});
