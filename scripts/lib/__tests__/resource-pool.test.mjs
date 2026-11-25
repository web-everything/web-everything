// @vitest-environment node
import { it, expect } from 'vitest';
import { grantDecision, budgetFromSnapshot, CLASSES } from '../resource-pool.mjs';
import { CAPACITY_LEAVES, validEnumValue } from '../operator-override-reader.mjs';
const base = { budget: 30, held: [], class: 4, size: 2 };
const h = (priority, size) => ({ class: priority, size, source: 'fixture' });
it('unknown evidence always holds', () => {
  for (const patch of [{ unknown: true }, { budget: undefined }, { held: undefined }, { held: [h(0, 1)] },
    { queuedDemand: null }, { queuedDemand: { 5: 1 } }, { held: [{ ...h(2, 1), source: '' }] }]) {
    expect(grantDecision({ ...base, ...patch })).toMatchObject({ decision: 'hold', unknown: true });
  }
});
it('never grants bounds outside integer 0..64 or inverted class ranges', () => {
  for (const bad of [-1, 65, Infinity, NaN, null, '4', 0.5, {}, []]) {
    for (const key of ['budget', 'builderFloor', 'size', 'class1Overdraw'])
      expect(grantDecision({ ...base, [key]: bad }).decision).toBe('hold');
    expect(grantDecision({ ...base, queuedDemand: { 2: bad } }).decision).toBe('hold');
    expect(grantDecision({ ...base, classes: { ...CLASSES, 2: { reserve: 1, max: bad } } }).decision).toBe('hold');
  }
  expect(grantDecision({ ...base, classes: { ...CLASSES, 2: { reserve: 9, max: 8 } } }).unknown).toBe(true);
});
it('grants in priority order after subtracting queued higher-class demand', () => {
  const request = { ...base, budget: 10, queuedDemand: { 1: 4, 2: 4, 3: 2 }, builderFloor: 0 };
  expect(grantDecision(request).decision).toBe('hold');
  expect(grantDecision({ ...request, class: 3 }).decision).toBe('grant');
  expect(grantDecision({ ...request, class: 2 }).decision).toBe('grant');
  expect(grantDecision({ ...request, class: 1 }).decision).toBe('grant');
});
it('honors class max including overdraw', () => {
  expect(grantDecision({ ...base, class: 2, held: [h(2, 8)] }).reason).toBe('class max');
  expect(grantDecision({ ...base, class: 1, size: 5 }).reason).toBe('class max');
});
it('protects the default 4-unit builderFloor, subtracting existing builder use', () => {
  expect(grantDecision({ ...base, budget: 5, class: 3 }).reason).toBe('builder floor');
  expect(grantDecision({ ...base, budget: 6, class: 3 }).decision).toBe('grant');
  expect(grantDecision({ ...base, budget: 6, class: 3, held: [h(4, 4)] }).decision).toBe('grant');
});
it('allows bounded class1 overdraw only for class1', () => {
  const request = { ...base, budget: 0, builderFloor: 0, class: 1 };
  expect(grantDecision(request).decision).toBe('grant');
  expect(grantDecision({ ...request, size: 3 }).decision).toBe('hold');
  expect(grantDecision({ ...request, class: 2 }).decision).toBe('hold');
});
it('class-1 overdraw grant refused when it would drop builders below the floor', () => {
  // budget 5, nothing held: a size-2 class-1 grant leaves 3 free < floor 4; overdraw must not hide that.
  expect(grantDecision({ ...base, budget: 5, class: 1 })).toMatchObject({ decision: 'hold', reason: 'builder floor' });
  expect(grantDecision({ ...base, budget: 6, class: 1 }).decision).toBe('grant');
  expect(grantDecision({ ...base, budget: 5, class: 1, size: 1 }).decision).toBe('grant');
  // overdraw still works once builders already hold the floor
  expect(grantDecision({ ...base, budget: 4, class: 1, held: [h(4, 4)] }).decision).toBe('grant');
  expect(grantDecision({ ...base, budget: 4, class: 1, size: 4, held: [h(4, 4)] }).decision).toBe('hold');
});
it('property: a grant never leaves builders (free + held builders) below the floor', () => {
  for (let budget = 0; budget <= 12; budget++) for (const cls of [1, 2, 3]) for (let size = 1; size <= 4; size++)
    for (let b = 0; b <= 6; b++) {
      const held = b ? [h(4, b)] : [];
      const d = grantDecision({ ...base, budget, class: cls, size, held });
      if (d.decision === 'grant' && b < 4) expect(b + (budget - b - size)).toBeGreaterThanOrEqual(4);
    }
});
it('never preempts or mutates holders when capacity shrinks below current usage', () => {
  const held = Object.freeze([Object.freeze(h(4, 10))]);
  expect(grantDecision({ ...base, held, budget: 0, class: 1 }).decision).toBe('hold');
  expect(held).toEqual([h(4, 10)]);
});
export const snapshot = () => ({ sampledAt: new Date(1000).toISOString(), freshUntil: new Date(3000).toISOString(),
  memory: { availableMb: 40000, floorMb: 4000, swapUsedPct: 10, swapGrowthMb: 0, pressureLevel: 1 }, cpu: { idlePct: 40 } });
it('computes memory and swap first, with CPU only as backstop and budget in 0..30', () => {
  const budget = s => budgetFromSnapshot(s, { nowMs: 2000 });
  expect(budget(snapshot()).units).toBe(30);
  const s = snapshot(); s.memory.availableMb = 10000; s.memory.swapGrowthMb = 1024;
  expect(budget(s).units).toBe(4);
  s.memory.swapGrowthMb = -1024;
  expect(budget(s).units).toBe(5);
  s.memory.availableMb = 0;
  expect(budget(s).units).toBe(0);
  s.memory.availableMb = 40000;
  for (const patch of [{ swapUsedPct: 80 }, { pressureLevel: 2 }]) expect(budget({ ...s, memory: { ...s.memory, ...patch } }).units).toBe(0);
  expect(budget({ ...s, cpu: { idlePct: 14 } }).units).toBe(0);
});
it('missing/null/malformed memory swap CPU or freshness evidence fails closed', () => {
  for (const key of ['availableMb', 'floorMb', 'swapUsedPct', 'swapGrowthMb', 'pressureLevel']) {
    for (const value of [undefined, null, NaN, '1']) {
      const s = snapshot(); s.memory[key] = value;
      expect(budgetFromSnapshot(s, { nowMs: 2000 }).unknown).toBe(true);
    }
  }
  for (const patch of [{ cpu: {} }, { cpu: { idlePct: 101 } }, { freshUntil: 'bad' },
    { freshUntil: new Date(1999).toISOString() }, { sampledAt: new Date(2001).toISOString() }])
    expect(budgetFromSnapshot({ ...snapshot(), ...patch }, { nowMs: 2000 }).unknown).toBe(true);
});
it('registers instant capacity bounds and the separate mode enum', () => {
  for (const [key, leaf] of Object.entries(CAPACITY_LEAVES).filter(([key]) => key.startsWith('resourcePool.'))) {
    expect(leaf.validate(0)).toBe(true); expect(leaf.validate(64)).toBe(true);
    for (const bad of [-1, 65, 0.5, NaN, '4']) expect(leaf.validate(bad), key).toBe(false);
  }
  for (const mode of ['off', 'shadow', 'enforce']) expect(validEnumValue('resourcePool.mode', mode)).toBe(true);
  expect(validEnumValue('resourcePool.mode', 'live')).toBe(false);
});

it('stale or overlong snapshot budgets never grant, even for class1 overdraw', () => {
  for (const patch of [
    { freshUntil: new Date(1999).toISOString() },
    { sampledAt: new Date(-400000).toISOString() },
    { freshUntil: new Date(400000).toISOString() },
  ]) {
    const budget = budgetFromSnapshot({ ...snapshot(), ...patch }, { nowMs: 2000 });
    expect(budget.unknown).toBe(true);
    expect(grantDecision({ ...base, class: 1, builderFloor: 0, budget: budget.units,
      unknown: budget.unknown })).toMatchObject({ decision: 'hold', unknown: true });
  }
});
