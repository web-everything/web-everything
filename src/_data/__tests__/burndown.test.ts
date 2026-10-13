// Guards the burndown's accounting invariants — NOT magic numbers (the backlog
// changes daily). The point of this file: prove that however the backlog grows,
// every unit of scope is counted exactly once (no double-counting) and the
// series/rates reconcile. See src/_data/burndown.js + docs/agent/backlog-workflow.md.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const computeBurndown = require('../burndown.js');
const loadBacklog = require('../backlog.js');

const FIB = new Set([1, 2, 3, 5, 8, 13]);
const bd = computeBurndown();
const items = loadBacklog();
const sized = items.filter((i: any) => i.status !== 'closed' && typeof i.size === 'number' && FIB.has(i.size));

describe('backlog burndown — accounting invariants', () => {
  it('totals to the sum of every item size (each unit of scope counted once)', () => {
    const sum = sized.reduce((s: number, i: any) => s + i.size, 0);
    expect(bd.points.total).toBe(sum);
  });

  it('only stories and epics may carry points — a task is never sized', () => {
    for (const i of items) if (i.kind === 'task') expect(i.size).toBeUndefined();
  });

  it('no double-count: a sized (unstoried) epic has no sized child', () => {
    const sizedKids = new Map<string, number>();
    for (const i of items)
      if (i.parent != null && typeof i.size === 'number')
        sizedKids.set(String(i.parent), (sizedKids.get(String(i.parent)) || 0) + 1);
    for (const i of items)
      if (i.kind === 'epic' && typeof i.size === 'number')
        expect(sizedKids.get(i.num) || 0).toBe(0);
  });

  it('completed = sum of resolved sized items, and remaining = total − done', () => {
    const done = sized
      .filter((i: any) => i.status === 'resolved' && i.dateResolved)
      .reduce((s: number, i: any) => s + i.size, 0);
    expect(bd.points.done).toBe(done);
    expect(bd.points.remaining).toBe(bd.points.total - bd.points.done);
  });

  it('the final daily point reconciles scope / done / remaining', () => {
    const last = bd.series.daily[bd.series.daily.length - 1];
    expect(last.scope).toBe(bd.points.total);
    expect(last.done).toBe(bd.points.done);
    expect(last.remaining).toBe(last.scope - last.done);
  });

  it('every series point keeps remaining = scope − done and is monotonic', () => {
    for (const g of ['daily', 'weekly', 'monthly'] as const) {
      let prevScope = -1, prevDone = -1;
      for (const p of bd.series[g]) {
        expect(p.remaining).toBe(p.scope - p.done);
        expect(p.scope).toBeGreaterThanOrEqual(prevScope); // cumulative — never decreases
        expect(p.done).toBeGreaterThanOrEqual(prevDone);
        prevScope = p.scope; prevDone = p.done;
      }
    }
  });

  it('net burn rate = completion − intake, and diverging ⇔ net ≤ 0', () => {
    expect(bd.rates.net.day).toBeCloseTo(bd.rates.completion.day - bd.rates.intake.day, 9);
    expect(bd.diverging).toBe(bd.rates.net.day <= 0);
    expect(!!bd.clearDateNet).toBe(!bd.diverging); // a clear-date only when converging
  });
});
