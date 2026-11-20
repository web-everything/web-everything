// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { grantDecision, budgetFromSnapshot, digestLine, summarize, CLASSES } from './resource-pool.mjs';
import { CAPACITY_LEAVES, failClosedCapacity } from './operator-override-reader.mjs';
const base = { budget: 30, held: [], class: 4, size: 2 };
const h = (priority, size) => ({ class: priority, size, source: 'fixture' });
const snapshot = (memory = {}, cpu = {}) => ({ sampledAt: new Date(1000).toISOString(), freshUntil: new Date(3000).toISOString(),
  memory: { availableMb: 40000, floorMb: 4096, swapUsedPct: 10, swapGrowthMb: 0, pressureLevel: 1, ...memory },
  cpu: { idlePct: 80, ...cpu }, errors: [] });
describe('shadow grant arithmetic', () => {
  it.each([
    ['free capacity', {}, 'grant'],
    ['higher-class queued demand blocks builders', { budget: 10, queuedDemand: { 2: 9 } }, 'hold'],
    ['lower-class demand does not block review', { class: 2, queuedDemand: { 4: 100 } }, 'grant'],
    ['class maximum', { class: 3, held: [h(3, 6)] }, 'hold'],
    ['class1 overdraw', { budget: 4, held: [h(4, 4)], class: 1, size: 2 }, 'grant'],
    ['class1 overdraw bound', { budget: 4, held: [h(4, 4)], class: 1, size: 3 }, 'hold'],
    ['other classes cannot overdraw', { budget: 4, held: [h(4, 4)], class: 2 }, 'hold'],
    ['builder floor protects unused builder units', { budget: 5, class: 3 }, 'hold'],
    ['builder can consume its floor', { budget: 14, size: 4 }, 'grant'],
    ['occupied builders satisfy floor', { budget: 14, held: [h(4, 4)], class: 3 }, 'grant'],
    ['shrink does not preempt holders', { budget: 1, held: [h(4, 6)] }, 'hold'],
    ['unknown budget fails closed', { budget: { unknown: true } }, 'unknown'],
    ['unknown source fails closed', { unknown: true }, 'unknown'],
    ['unnamed holder source fails closed', { held: [{ class: 2, size: 1 }] }, 'unknown'],
    ['unknown holder fails closed', { held: [{ ...h(2, 1), unknown: true }] }, 'unknown'],
    ['invalid queue fails closed', { queuedDemand: { 2: NaN } }, 'unknown'],
    ['missing size fails closed', { size: undefined }, 'unknown'],
    ['oversized request is held', { size: 1000 }, 'hold'],
  ])('%s', (_, patch, decision) => {
    const input = { ...base, ...patch }, before = structuredClone(input);
    expect(grantDecision(input).decision).toBe(decision);
    expect(input).toEqual(before);
  });
  it.each([
    ['builder floor and higher reserves coexist', { budget: 12, class: 3, builderFloor: 4 }, 'hold'],
    ['builder floor plus higher reserves exact boundary', { budget: 14, class: 3, builderFloor: 4 }, 'grant'],
    ['C2 preserves C1 reserve', { class: 2, budget: 7, size: 6 }, 'hold'],
    ['C2 at reserve boundary', { class: 2, budget: 8, size: 6 }, 'grant'],
    ['C3 preserves C1 and C2', { class: 3, budget: 9 }, 'hold'],
    ['C3 at reserve boundary', { class: 3, budget: 10 }, 'grant'],
    ['builders preserve all higher reserves', { budget: 14, size: 14 }, 'hold'],
    ['builders can consume remaining four units', { budget: 14, size: 4 }, 'grant'],
    ['partially occupied higher reserves', { budget: 14, held: [h(1, 1), h(2, 3)], size: 5 }, 'hold'],
    ['partial reserve exact boundary', { budget: 14, held: [h(1, 1), h(2, 3)], size: 4 }, 'grant'],
    ['excess occupancy cannot cancel another reserve', { budget: 14, held: [h(1, 4)], size: 3 }, 'hold'],
    ['fully occupied reserves', { budget: 14, held: [h(1, 2), h(2, 6), h(3, 2)], size: 4 }, 'grant'],
    ['configured reserves', { budget: 14, classes: { ...CLASSES, 2: { reserve: 8, max: 8 } }, size: 3 }, 'hold'],
    ['missing reserve closes evidence', { classes: { ...CLASSES, 1: { max: 4 } } }, 'unknown'],
    ['malformed reserve closes evidence', { classes: { ...CLASSES, 2: { reserve: -1, max: 8 } } }, 'unknown'],
    ['queue demand also protects capacity', { budget: 14, size: 4, queuedDemand: { 1: 1 } }, 'hold'],
  ])('%s', (_, patch, expected) => {
    expect(grantDecision({ ...base, builderFloor: 0, ...patch }).decision).toBe(expected);
  });
  it('all new instant leaves have bounded validators and safe fallback directions', () => {
    for (const [key, leaf] of Object.entries(CAPACITY_LEAVES).filter(([k]) => k.startsWith('resourcePool.'))) {
      expect(leaf.validate(65)).toBe(false); expect(leaf.validate(-1)).toBe(false);
      expect(leaf.validate('4')).toBe(false); expect(leaf.validate(leaf.failClosedFallback)).toBe(true);
      const protectedFloor = key.endsWith('Floor') || key.endsWith('reserve');
      expect(leaf.direction).toBe(protectedFloor ? 'threshold' : 'cap');
      expect(failClosedCapacity(key, protectedFloor ? 0 : 64, { log: () => {} })).toBe(leaf.failClosedFallback);
    }
    expect(CAPACITY_LEAVES['resourcePool.mode']).toBeUndefined();
    expect(CLASSES[2]).toEqual({ reserve: 6, max: 8 });
  });
});
describe('memory and swap budget with CPU backstop', () => {
  it('caps memory headroom at 30 units', () => expect(budgetFromSnapshot(snapshot(), { nowMs: 2000 }).studio.units).toBe(30));
  it('swap growth reduces headroom before CPU is considered', () => expect(budgetFromSnapshot(snapshot({ availableMb: 12288, swapGrowthMb: 2048 }), { nowMs: 2000 }).studio.units).toBe(6));
  it.each([{ swapUsedPct: 80 }, { pressureLevel: 2 }])('pressure stops new grants: %j', m => expect(budgetFromSnapshot(snapshot(m), { nowMs: 2000 }).studio.units).toBe(0));
  it('CPU idle is a backstop', () => expect(budgetFromSnapshot(snapshot({}, { idlePct: 10 }), { nowMs: 2000 }).studio.units).toBe(0));
  it.each([null, {}, snapshot({ swapUsedPct: null }), snapshot({ availableMb: null }), snapshot({ swapUsedPct: 101 })])('missing evidence is unknown: %j', s => expect(budgetFromSnapshot(s, { nowMs: 2000 })).toEqual({ unknown: true }));
  it('stale and missing clock evidence fail closed', () => {
    for (const nowMs of [3001, undefined]) expect(budgetFromSnapshot(snapshot(), { nowMs })).toEqual({ unknown: true });
  });
});
it('digest is a single line with resource and class totals and unknowns', () => {
  const holders = [h(1, 2), h(2, 6), h(3, 8), h(4, 6)].map(r => ({ ...r, resource: 'studio.units' }));
  const summary = { ...summarize(holders), 'forge.slots': { held: 9 }, 'provider.codex': { held: 61 } };
  expect(digestLine({ summary, budgets: { 'studio.units': 30, 'forge.slots': 14, 'provider.codex': 80 }, queuedDemand: { 3: 3, 4: 5 } }))
    .toBe('pool studio 22/30u · C1 2 C2 6 C3 8 C4 6 (floor 4) · wait C3:3 C4:5 · forge 9/14 · codex 61/80');
  expect(digestLine({ unknown: true })).toContain('studio ?/?u');
  expect(digestLine()).not.toMatch(/[\r\n]/);
});

it('uses resource-status freshness at the exact expiry boundary and with grace', () => {
  expect(budgetFromSnapshot(snapshot(), { nowMs: 3000 }).unknown).toBe(false);
  expect(budgetFromSnapshot(snapshot(), { nowMs: 3500, policy: { staleGraceMs: 1000 } }).unknown).toBe(false);
  expect(budgetFromSnapshot(snapshot(), { nowMs: 500 }).unknown).toBe(false);
});
it('does not treat unrelated sampler probe errors as missing budget evidence', () => {
  const s = snapshot(); s.errors = ['disk probe unavailable']; delete s.memory.swapGrowthMb;
  expect(budgetFromSnapshot(s, { nowMs: 2000 }).studio.units).toBe(30);
  s.memory.swapGrowthMb = null;
  expect(budgetFromSnapshot(s, { nowMs: 2000 }).unknown).toBe(true);
});
