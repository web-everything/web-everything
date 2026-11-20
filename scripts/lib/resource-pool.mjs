import { decideAdmission } from './resource-policy.mjs';
/** R1094 S1: pure shadow arithmetic. No acquisition, release, preemption, or clock reads. */
export const CLASSES = Object.freeze({
  1: Object.freeze({ reserve: 2, max: 4, class1Overdraw: 2 }),
  2: Object.freeze({ reserve: 6, max: 8 }),
  3: Object.freeze({ reserve: 2, max: 6 }),
  4: Object.freeze({ reserve: 4, max: 64 }),
});
export const HOLDER_WEIGHTS = Object.freeze({ fix: 2, blocker: 2, review: 1, redTeam: 1,
  build: 2, heavy: 1, forge: 1, lane: 1 });
export const POOL_DEFAULTS = Object.freeze({ mode: 'shadow', builderFloor: 4, classes: CLASSES });
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const validClass = n => Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 4;
const result = (decision, reason) => ({ decision, reason, unknown: decision === 'unknown' });

/** held is a COMPLETE inventory for ONE resource. Callers must propagate source unknowns. */
export function grantDecision({ budget, held, queuedDemand = {}, class: priority, size,
  classes = CLASSES, builderFloor = 4, class1Overdraw = classes?.[1]?.class1Overdraw ?? 0,
  unknown = false } = {}) {
  if (unknown || budget?.unknown || !finite(budget) || !Array.isArray(held) || held.unknown
    || !validClass(priority) || !finite(size) || size === 0 || !finite(builderFloor) || !finite(class1Overdraw)
    || held.some(h => typeof h.source !== 'string' || !h.source.trim() || h.unknown || h.sourceOk === false || !validClass(h.class) || !finite(h.size))
    || !queuedDemand || typeof queuedDemand !== 'object' || Array.isArray(queuedDemand)
    || Object.entries(queuedDemand).some(([c, n]) => !validClass(c) || !finite(n))
    || !finite(classes?.[priority]?.max)
    || [1, 2, 3, 4].some(c => !finite(classes?.[c]?.reserve) || !finite(classes?.[c]?.max) || classes[c].reserve > classes[c].max)) return result('unknown', 'incomplete pool evidence');
  const total = held.reduce((n, h) => n + h.size, 0);
  const own = held.filter(h => Number(h.class) === Number(priority)).reduce((n, h) => n + h.size, 0);
  if (own + size > classes[priority].max) return result('hold', 'class max');
  const free = budget - total;
  const higher = Object.entries(queuedDemand).filter(([c]) => Number(c) < Number(priority)).reduce((n, [, d]) => n + d, 0);
  const unmetReserve = [1, 2, 3].filter(c => c < Number(priority)).reduce((n, c) =>
    n + Math.max(0, classes[c].reserve - held.filter(h => Number(h.class) === c).reduce((sum, h) => sum + h.size, 0)), 0);
  const builders = held.filter(h => Number(h.class) === 4).reduce((n, h) => n + h.size, 0);
  // The floor belongs to builders: other classes cannot consume its unoccupied portion.
  const overdraw = Number(priority) === 1 ? class1Overdraw : 0;
  if (Number(priority) !== 4 && free + overdraw - higher - unmetReserve - size < Math.max(0, builderFloor - builders)) return result('hold', 'builder floor');
  return free + overdraw - higher - unmetReserve >= size ? result('grant', 'capacity available') : result('hold', 'capacity, higher-class reserves or demand');
}

/** 1 unit = 1 GiB memory headroom above the measured floor, capped at the legacy 30u envelope.
 * Swap growth consumes headroom; >=80% swap or warning pressure stops new grants.
 * CPU idle <15% is a backstop, never a substitute for missing memory/swap evidence.
 * nowMs is injected to keep this module pure; missing clock evidence fails closed too. */
export function budgetFromSnapshot(snapshot, { nowMs, policy } = {}) {
  const s = snapshot, m = s?.memory, cpu = s?.cpu;
  const freshness = decideAdmission({ kind: 'build', snapshot: s, nowMs, policy });
  // Older sampler snapshots omit the optional swap-growth probe; absence means no measured growth.
  const swapGrowthMb = m?.swapGrowthMb === undefined ? 0 : m.swapGrowthMb;
  if (!finite(nowMs) || freshness.unknown
    || ![m?.availableMb, m?.floorMb, m?.swapUsedPct, swapGrowthMb, cpu?.idlePct].every(finite)
    || m.swapUsedPct > 100 || cpu.idlePct > 100 || ![1, 2, 4].includes(m.pressureLevel)) return { unknown: true };
  const memoryUnits = Math.max(0, Math.floor((m.availableMb - m.floorMb - swapGrowthMb) / 1024));
  const units = m.pressureLevel !== 1 || m.swapUsedPct >= 80 || cpu.idlePct < 15 ? 0 : Math.min(30, memoryUnits);
  return { unknown: false, studio: { units }, basis: 'memory+swap; CPU idle backstop' };
}

export function summarize(holders = []) {
  const resources = {};
  for (const h of holders) {
    const r = resources[h.resource] ??= { held: 0, classes: { 1: 0, 2: 0, 3: 0, 4: 0 }, unknown: false };
    if (h.unknown || !validClass(h.class) || !finite(h.size)) { r.unknown = true; continue; }
    r.held += h.size; r.classes[h.class] += h.size;
  }
  return resources;
}
const shown = n => finite(n) ? String(n) : '?';
export function digestLine({ summary = {}, budgets = {}, queuedDemand = {}, builderFloor = 4, unknown = false } = {}) {
  const r = summary['studio.units'];
  const count = key => unknown || r?.unknown ? '?' : shown(r?.classes?.[key]);
  const pair = resource => `${unknown || summary[resource]?.unknown ? '?' : shown(summary[resource]?.held)}/${shown(budgets[resource])}`;
  const wait = Object.entries(queuedDemand).filter(([, n]) => n > 0).map(([c, n]) => `C${c}:${shown(n)}`).join(' ') || (unknown ? '?' : 'none');
  return `pool studio ${pair('studio.units')}u · C1 ${count(1)} C2 ${count(2)} C3 ${count(3)} C4 ${count(4)} (floor ${shown(builderFloor)}) · wait ${wait} · forge ${pair('forge.slots')} · codex ${pair('provider.codex')}`;
}
