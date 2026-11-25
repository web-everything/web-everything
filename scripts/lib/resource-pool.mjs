/** R1094 S1a: pure observations only. Never preempt existing holders. */
export const CLASSES = Object.freeze({
  1: Object.freeze({ reserve: 2, max: 4, class1Overdraw: 2 }),
  2: Object.freeze({ reserve: 6, max: 8 }),
  3: Object.freeze({ reserve: 2, max: 6 }),
  4: Object.freeze({ reserve: 4, max: 64 }),
});
export const POOL_DEFAULTS = Object.freeze({ mode: 'shadow', builderFloor: 4, classes: CLASSES });
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const bound = n => Number.isInteger(n) && n >= 0 && n <= 64;
const validClass = n => [1, 2, 3, 4].includes(n);
export const validClasses = classes => [1, 2, 3, 4].every(c => bound(classes?.[c]?.reserve)
  && bound(classes?.[c]?.max) && classes[c].reserve <= classes[c].max) && bound(classes?.[1]?.class1Overdraw);
export function grantDecision({ budget, held, queuedDemand = {}, class: priority, size,
  classes = CLASSES, builderFloor = 4, class1Overdraw = classes?.[1]?.class1Overdraw,
  unknown = false } = {}) {
  const result = (decision, reason, unknown = false) => ({ decision, reason, unknown });
  if (unknown || !bound(budget) || !Array.isArray(held) || held.unknown || !validClass(priority)
    || !bound(size) || !size || !bound(builderFloor) || !bound(class1Overdraw) || !validClasses(classes)
    || held.some(h => !h || typeof h.source !== 'string' || !h.source.trim() || h.unknown
      || h.sourceOk === false || !validClass(h.class) || !bound(h.size) || !h.size)
    || !queuedDemand || typeof queuedDemand !== 'object' || Array.isArray(queuedDemand)
    || Object.entries(queuedDemand).some(([c, n]) => !validClass(Number(c)) || !bound(n)))
    return result('hold', 'unknown evidence; inspect named sources and rerun', true);
  const used = c => held.filter(h => h.class === c).reduce((n, h) => n + h.size, 0);
  if (used(priority) + size > classes[priority].max) return result('hold', 'class max');
  const free = budget - held.reduce((n, h) => n + h.size, 0);
  const higher = Object.entries(queuedDemand).filter(([c]) => Number(c) < priority).reduce((n, [, d]) => n + d, 0);
  const available = free - higher + (priority === 1 ? class1Overdraw : 0);
  // The floor is judged on real free capacity: class-1 overdraw must never be credited against builders.
  const floorNeed = builderFloor - used(4);
  if (priority !== 4 && floorNeed > 0 && free - higher - size < floorNeed) return result('hold', 'builder floor');
  return available >= size ? result('grant', 'capacity available') : result('hold', 'capacity or higher-class demand');
}
const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000;
/** One unit per GiB above the measured memory floor; swap growth reduces headroom.
 * Require every probe. Negative measured swap growth is valid and cannot increase budget. */
export function budgetFromSnapshot(s, { nowMs } = {}) {
  const m = s?.memory, cpu = s?.cpu;
  const sampled = Date.parse(s?.sampledAt), until = Date.parse(s?.freshUntil);
  if (!finite(nowMs) || !Number.isFinite(sampled) || !Number.isFinite(until)
    || sampled > nowMs || nowMs - sampled > MAX_SNAPSHOT_AGE_MS
    || until < sampled || until - sampled > MAX_SNAPSHOT_AGE_MS || nowMs > until
    || ![m?.availableMb, m?.floorMb, m?.swapUsedPct, cpu?.idlePct].every(finite)
    || !Number.isFinite(m?.swapGrowthMb) || m.swapUsedPct > 100 || cpu.idlePct > 100
    || ![1, 2, 4].includes(m.pressureLevel)) return { unknown: true };
  const memoryUnits = Math.max(0, Math.floor((m.availableMb - m.floorMb - Math.max(0, m.swapGrowthMb)) / 1024));
  const units = m.pressureLevel !== 1 || m.swapUsedPct >= 80 || cpu.idlePct < 15 ? 0 : Math.min(30, memoryUnits);
  return { unknown: false, units, basis: 'memory+swap first; CPU idle backstop' };
}
export function summarize(holders) {
  const classes = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const h of holders) classes[h.class] += h.size;
  return { 'studio.units': { held: holders.reduce((n, h) => n + h.size, 0), classes } };
}
export function digestLine({ summary = {}, budgets = {}, builderFloor = 4, unknown = false } = {}) {
  const r = summary['studio.units'];
  const show = n => unknown || !finite(n) ? '?' : n;
  return `pool studio ${show(r?.held)}/${show(budgets['studio.units'])}u · C2 ${show(r?.classes[2])} C3 ${show(r?.classes[3])} (floor ${builderFloor})`;
}
