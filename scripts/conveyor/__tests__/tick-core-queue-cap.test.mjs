/**
 * @file scripts/conveyor/__tests__/tick-core-queue-cap.test.mjs
 * @description Card xkyw1x4 — `planTick`'s `queue-cap` gate: admission by PROJECTED heavy-test queue time, beside
 *   #4076's `load-cap`. Pure — the queue baseline is a plain object (the shape `heavy-admission.mjs queue-status
 *   --json` prints), never a real read.
 */
import { describe, it, expect } from 'vitest';
import { createQueueBudget } from '../../readiness/heavy-queue-projection.mjs';
import { planTick, freshSpawnDemandMinutes, applyQueueCapToPrepareSpawns } from '../tick-core.mjs';

/** A busy queue: 2 slots, 50 slot-minutes already on the way (e.g. 2 full suites + a waiter + pending). */
const busy = (backlogMinutes = 50) => ({
  slots: 2, backlogMinutes, maxWaitMinutes: 30, arrivalWindowMinutes: 10,
  standardMinutes: { selected: 3, FULL: 18, standards: 0.25, files: 1.5, other: 5 },
});
const changesPr = (pr, num) => ({ num, prNumber: pr, state: 'OPEN', labels: ['review:changes'] });
const redPr = (pr, num) => ({ num, prNumber: pr, state: 'OPEN', ci: 'fail', labels: ['ready-to-merge'] });

describe('planTick — queue-cap (xkyw1x4): admit only while the projected heavy-test wait stays ≤ 30m', () => {
  it('no baseline (omitted / null) — changes nothing, exactly like the pre-xkyw1x4 tick', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    expect(out.decisions.queueAdmission).toBeNull();
    expect(out.decisions.notes.some((n) => n.kind === 'queue-cap')).toBe(false);
  });

  it('4 builds launched in quick succession: each sees the ones before it, and the one that would pass 30m is held', () => {
    // size 1 builds cost one fix-sized unit (3.25m) each: (50 + 3.25n) / 2 → 26.63, 28.25, 29.88, 31.5.
    const out = planTick({
      state: { queue: [10, 11, 12, 13].map((num) => ({ num, buildQueued: true })), lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }, { num: 11, lane: 5 }, { num: 12, lane: 6 }, { num: 13, lane: 7 }] },
      freeLanes: [4, 5, 6, 7],
      bookkeeping: { tick: 0 },
      config: { maxConcurrentLanes: 50 },
      queueAdmission: busy(),
      itemSizes: { 10: 1, 11: 1, 12: 1, 13: 1 },
    });
    expect(out.decisions.spawnBuilds.map((l) => l.num)).toEqual([10, 11, 12]);
    expect(out.decisions.suppressedBuilds).toEqual([
      { num: 13, lane: 7, by: 'queue-cap', projectedMinutes: 31.5, demandMinutes: 3.25 },
    ]);
    expect(out.decisions.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'queue-cap', num: 13, text: expect.stringContaining('projected heavy-test wait 31.5m > 30m') }),
    ]));
    // A held build records no guard — it is simply re-offered next tick.
    expect(out.nextState.buildGuards.map((g) => g.num)).toEqual([10, 11, 12]);
    expect(out.decisions.queueAdmission).toMatchObject({ maxWaitMinutes: 30, backlogMinutes: 50, slots: 2 });
  });

  it('a big build is held but the small fix after it still fits — greedy, and the fix gets the lane back', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], prs: [changesPr(99, 40)], lanes: [], needsSlice: [], decisions: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0, launchedNums: [40] },
      config: { maxConcurrentLanes: 50 },
      queueAdmission: busy(),
      itemSizes: { 10: 8 }, // 13m → (50+13)/2 = 31.5 → held
    });
    expect(out.decisions.spawnBuilds).toEqual([]);
    expect(out.decisions.suppressedBuilds).toEqual([expect.objectContaining({ num: 10, by: 'queue-cap' })]);
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 4 }]); // (50+3.25)/2 = 26.63 → admitted
  });

  it('fix and CI-heal spawns are held too when the queue is already long; the lanes stay free and no attempt is burned', () => {
    const out = planTick({
      state: { queue: [], prs: [changesPr(99, 40), redPr(98, 41)], lanes: [], needsSlice: [], decisions: [] },
      plan: { launch: [] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0, launchedNums: [40, 41], ciHealAttempts: { 98: 1 } },
      queueAdmission: busy(58), // (58 + 3.25) / 2 = 30.63 → every new fix-sized dispatch is held
    });
    expect(out.decisions.spawnFixes).toEqual([]);
    expect(out.decisions.spawnCiHeals).toEqual([]);
    expect(out.nextState.fixGuards).toEqual([]);
    expect(out.nextState.ciHealGuards).toEqual([]);
    expect(out.nextState.ciHealAttempts).toEqual({ 98: 1 }); // planCiHealSpawns' plan-time bump is undone
    const notes = out.decisions.notes.filter((n) => n.kind === 'queue-cap');
    expect(notes.map((n) => n.pr)).toEqual([99, 98]);
    expect(notes[0].text).toMatch(/fix PR #99 .* queue-cap \(projected heavy-test wait 30\.63m > 30m/);
  });

  it('a bypassed or unreadable baseline fails open — everything is admitted', () => {
    for (const queueAdmission of [{ bypassed: 'off', slots: 2 }, { bypassed: 'error' }, {}]) {
      const out = planTick({
        state: { queue: [], prs: [changesPr(99, 40)], lanes: [], needsSlice: [], decisions: [] },
        plan: { launch: [] }, freeLanes: [5], bookkeeping: { tick: 0, launchedNums: [40] }, queueAdmission,
      });
      expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 5 }]);
    }
  });

  it('load-cap wins first: a load-held build never reaches the queue gate (no double note)', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4], bookkeeping: { tick: 0 }, config: { maxConcurrentLanes: 50 },
      loadAdmission: { held: true, load1: 20, cores: 12, perCore: 1.67, maxPerCore: 1.5 },
      queueAdmission: busy(80),
    });
    expect(out.decisions.suppressedBuilds).toEqual([{ num: 10, lane: 4, by: 'load-cap' }]);
    expect(out.decisions.notes.some((n) => n.kind === 'queue-cap')).toBe(false);
  });
});

describe('freshSpawnDemandMinutes — this conveyor\'s own spawns the baseline cannot see yet', () => {
  const now = Date.parse('2026-09-25T21:00:00.000Z');
  const q = busy();
  it('counts a guard spawned within the arrival window whose lane is not leased yet', () => {
    const guards = {
      build: [{ num: 10, lane: 4, spawnedAt: now - 60_000 }],
      fix: [{ pr: 99, num: 40, lane: 5, spawnedAt: now - 2 * 60_000 }],
      ciHeal: [],
    };
    expect(freshSpawnDemandMinutes(guards, { lanes: [], now, queueAdmission: q, itemSizes: { 10: 3 } })).toBe(6.5 + 3.25);
  });
  it('skips a guard whose lane is already leased (the baseline counts it) or that is past the window', () => {
    const guards = {
      build: [{ num: 10, lane: 4, spawnedAt: now - 60_000 }],
      fix: [{ pr: 99, num: 40, lane: 5, spawnedAt: now - 30 * 60_000 }],
      ciHeal: [{ pr: 98, num: 41, lane: null, spawnedAt: now }],
    };
    expect(freshSpawnDemandMinutes(guards, { lanes: [{ lane: 4, num: 10 }], now, queueAdmission: q })).toBe(0);
  });
  it('a fresh guard pushes a later spawn in the SAME tick over the line', () => {
    const out = planTick({
      // #10 is still in the cleared queue and its lane is not leased — its build session has not claimed yet.
      state: { queue: [{ num: 10, buildQueued: true }], prs: [changesPr(99, 40)], lanes: [], needsSlice: [], decisions: [] },
      plan: { launch: [] },
      freeLanes: [6],
      now,
      bookkeeping: { tick: 3, launchedNums: [40], buildGuards: [{ num: 10, lane: 4, spawnedTick: 2, spawnedAt: now - 60_000 }] },
      queueAdmission: busy(52), // alone: (52 + 3.25)/2 = 27.63 → admitted; with the fresh size-3 build (+6.5): 30.88 → held
      itemSizes: { 10: 3 },
    });
    expect(out.decisions.spawnFixes).toEqual([]);
    expect(out.decisions.notes.some((n) => n.kind === 'queue-cap' && n.pr === 99)).toBe(true);
  });
});


describe('prepare queue-cap — shared with builds, fixes and CI heals', () => {
  const input = {
    state: { queue: [], lanes: [], prs: [] },
    plan: { launch: [], held: [{ num: 77, reason: 'needs-prepare' }] },
    freeLanes: [4], bookkeeping: { tick: 0 },
  };
  it('holds a needs-prepare item near the maximum without consuming its guard or lane', () => {
    const out = planTick({ ...input, queueAdmission: busy(58) });
    expect(out.decisions.spawnPrepareItems).toEqual([]);
    expect(out.nextState.prepareGuards).toEqual([]);
    expect(out.nextState.launchedNums).not.toContain('77');
    expect(out.decisions.queueCapHeld.prepare).toEqual([{ num: 77, lane: 4, kind: 'prepare-item', projectedMinutes: 30.63, demandMinutes: 3.25 }]);
    expect(out.decisions.notes).toContainEqual(expect.objectContaining({ kind: 'queue-cap', num: 77, prepareKind: 'prepare-item', text: expect.stringContaining('prepare (prepare-item) #77') }));
  });
  it('a held prepare returns its only lane to a smaller fix', () => {
    const out = planTick({
      ...input, state: { ...input.state, prs: [changesPr(99, 40)] }, bookkeeping: { tick: 0, launchedNums: [40] },
      queueAdmission: { ...busy(54), dispatchMinutes: { prepare: 7.1 } },
    });
    expect(out.decisions.spawnPrepareItems).toEqual([]);
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 4 }]);
    expect(out.nextState.prepareGuards).toEqual([]);
  });
  it('spawns as before with a roomy budget or explicit exemption', () => {
    for (const queueAdmission of [busy(0), { ...busy(100), prepareAdmission: 'exempt' }]) {
      const out = planTick({ ...input, queueAdmission });
      expect(out.decisions.spawnPrepareItems).toEqual([{ num: 77, lane: 4 }]);
      expect(out.nextState.prepareGuards).toEqual([expect.objectContaining({ num: 77, lane: 4, kind: 'prepare-item' })]);
      expect(out.decisions.queueCapHeld.prepare).toEqual([]);
    }
  });
  it('a prepare sees the build demand already admitted in the same tick', () => {
    const out = planTick({ ...input,
      state: { ...input.state, queue: [{ num: 10, buildQueued: true }] },
      plan: { ...input.plan, launch: [{ num: 10, lane: 5 }] }, freeLanes: [4, 5],
      queueAdmission: busy(54), itemSizes: { 10: 1 },
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 5 }]);
    expect(out.decisions.spawnPrepareItems).toEqual([]);
    expect(out.decisions.queueCapHeld.prepare).toHaveLength(1);
  });
  it('filters every prepare list, dropping a held spawn\'s guard by num (a scope spawn\'s guard kind is `prepare`), without mutating the input', () => {
    const prep = {
      scopeSpawns: [{ num: 1, lane: 4 }], decisionSpawns: [{ num: 2, lane: 5 }],
      investigationSpawns: [{ num: 3, lane: 6 }], itemPrepareSpawns: [{ num: 4, lane: 7 }],
      newGuards: [
        { num: 1, kind: 'prepare' }, { num: 2, kind: 'prepare-decision' },
        { num: 3, kind: 'investigate' }, { num: 4, kind: 'prepare-item' },
      ], consumedLanes: [4, 5, 6, 7], notes: [],
    };
    for (const budget of [null, createQueueBudget(null)]) expect(applyQueueCapToPrepareSpawns(prep, budget)).toEqual({ prep, held: [] });
    const out = applyQueueCapToPrepareSpawns(prep, createQueueBudget(busy(54)));
    expect(out.prep.scopeSpawns).toEqual([{ num: 1, lane: 4 }]);
    expect(out.prep.decisionSpawns).toEqual([]);
    expect(out.prep.investigationSpawns).toEqual([]);
    expect(out.prep.itemPrepareSpawns).toEqual([]);
    expect(out.held.map((h) => h.kind)).toEqual(['prepare-decision', 'investigate', 'prepare-item']);
    expect(out.prep.newGuards).toEqual([{ num: 1, kind: 'prepare' }]);
    expect(out.prep.consumedLanes).toEqual([4]);
    expect(prep.consumedLanes).toEqual([4, 5, 6, 7]);
    expect(prep.newGuards).toHaveLength(4);
  });
  it('charges fresh prepare guards by measured demand, excluding leased and expired guards', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const guards = { prepare: [
      { num: 1, lane: 4, kind: 'prepare-item', spawnedAt: now - 60_000 },
      { num: 2, lane: 5, spawnedAt: now - 60_000 },
      { num: 3, lane: 6, kind: 'investigate', spawnedAt: now - 60_000 },
      { num: 4, lane: 7, kind: 'prepare-scope', spawnedAt: now - 11 * 60_000 },
    ] };
    const options = { now, lanes: [{ lane: 6 }], queueAdmission: { ...busy(), dispatchMinutes: { prepare: 7.1 } } };
    expect(freshSpawnDemandMinutes(guards, options)).toBe(14.2);
    expect(freshSpawnDemandMinutes(guards, { ...options, queueAdmission: { ...options.queueAdmission, prepareAdmission: 'exempt' } })).toBe(0);
  });
});
