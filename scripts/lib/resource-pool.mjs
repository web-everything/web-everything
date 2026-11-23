const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
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
