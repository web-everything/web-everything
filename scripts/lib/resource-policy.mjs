/**
 * @file we:scripts/lib/resource-policy.mjs
 * @description Card xkuflno (epic x6woyws) — THE ONE RESOURCE POLICY BLOCK and the pure admission decision. PURE: no
 *   fs, no clock, no process. Thresholds come from CPU idle, NOT load average: macOS counts disk waits in the load
 *   average, which read 49–82 while the CPU was 37–46% idle. The IO half (snapshot read, policy-cascade file read,
 *   shadow log) is we:scripts/lib/resource-admission.mjs.
 */
// Calibrated (x9xkupj, slice 2) from 1261 sampler snapshots 2026-10-09 19:27–23:01 ET plus the shadow log:
// - CPU idle p5/p25/p50/p95 = 11/19/24/49%; load average 11–109 (never ≤ 9, ≤ 15 only 3% of samples). Every shadow
//   pair was old "hold" (load) vs new "admit" (CPU idle 14–49%). So rebuild-smoke keeps a 5% floor (admits 97%) and
//   load-flake-rearm a 20% floor (admits 68%): its re-dispatched fixer re-runs timing-sensitive tests.
// - maxDiskBusyPct stays null (record, never gate): disk read 100% busy in 100% of samples, CPU 45% idle included —
//   on this NVMe host busy% means "I/Os in flight", not saturation. A tool override or platform preference can set one.
// - Memory pressure read level 2 in every sample, so maxMemPressureLevel 2 admits it; only level 4 (critical) holds.
const kindPolicy = (cpu, cost = 'heavy') => Object.freeze({ class: cost, minCpuIdlePct: cpu,
  maxMemPressureLevel: 2, maxDiskBusyPct: null, waitMinutes: 2 });
// Fixes tolerate busier CPUs; timing-sensitive flake re-verification needs a quiet host.
// Light preparation does no heavy local work; critical memory pressure still holds it.
export const RESOURCE_POLICY_STANDARD = Object.freeze({
  build: kindPolicy(15), prepare: kindPolicy(5, 'light'), fix: kindPolicy(8),
  'ci-heal': kindPolicy(8), review: kindPolicy(10), 'rebuild-smoke': kindPolicy(5),
  'load-flake-rearm': kindPolicy(20), light: kindPolicy(5, 'light'), staleGraceMs: 0,
});
export const RESOURCE_POLICY_KINDS = Object.freeze(Object.keys(RESOURCE_POLICY_STANDARD).filter(k => k !== 'staleGraceMs'));
const kinds = RESOURCE_POLICY_KINDS;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = v => Number.isFinite(v) && v >= 0;
const percent = v => nonnegative(v) && v <= 100;
const validators = {
  class: v => v === 'heavy' || v === 'light', minCpuIdlePct: percent,
  maxMemPressureLevel: v => [1, 2, 4].includes(v),
  maxDiskBusyPct: v => v === null || percent(v),
  maxHeavySlotsHeldPct: v => v === null || percent(v), waitMinutes: nonnegative,
};
export function isValidPolicyLayer(layer) {
  if (!object(layer)) return false;
  return Object.entries(layer).every(([key, value]) => {
    if (key === 'staleGraceMs') return nonnegative(value);
    return kinds.includes(key) && object(value) &&
      Object.entries(value).every(([field, v]) => Object.hasOwn(validators, field) && validators[field](v));
  });
}
/** Pure merge; malformed layers are ignored as a whole, never partially applied. */
export function resolveResourcePolicy({ standard = RESOURCE_POLICY_STANDARD, platform, tool } = {}) {
  const policy = Object.fromEntries(kinds.map(k => [k, { ...RESOURCE_POLICY_STANDARD[k] }]));
  policy.staleGraceMs = RESOURCE_POLICY_STANDARD.staleGraceMs;
  for (const layer of [standard, platform, tool]) {
    if (!isValidPolicyLayer(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'staleGraceMs') policy[key] = value;
      else Object.assign(policy[key], value);
    }
  }
  return policy;
}
const finite = v => Number.isFinite(v) ? v : null;
/** Pure decision: loadAvg1 is comparison evidence ONLY, never a condition. */
export function decideAdmission({ kind, snapshot, policy = RESOURCE_POLICY_STANDARD, nowMs } = {}) {
  const resolved = resolveResourcePolicy({ tool: policy });
  const rule = kinds.includes(kind) ? resolved[kind] : resolved.build;
  // An unknown kind remains heavy even if a tool reclassifies build.
  const cost = kinds.includes(kind) ? rule.class : 'heavy';
  const inputs = { cpuIdlePct: finite(snapshot?.cpu?.idlePct), memPressureLevel: finite(snapshot?.memory?.pressureLevel),
    diskBusyPct: finite(snapshot?.disk?.busyPct), loadAvg1: finite(snapshot?.cpu?.loadAvg?.[0]) };
  const sampledAt = Date.parse(snapshot?.sampledAt);
  const freshUntil = Date.parse(snapshot?.freshUntil);
  const snapshotAge = Number.isFinite(sampledAt) ? Math.max(0, Math.round((nowMs - sampledAt) / 1000)) : null;
  const unknownFields = [
    inputs.cpuIdlePct === null ? 'cpu idle unknown' : null,
    inputs.memPressureLevel === null ? 'memory pressure unknown' : null,
    inputs.diskBusyPct === null ? 'disk busy unknown' : null,
    inputs.loadAvg1 === null ? 'load average unknown (comparison only)' : null,
  ].filter(Boolean);
  const result = (verdict, reason, unknown = false) => ({ kind, verdict,
    reason: unknown ? reason : [reason, ...unknownFields].join('; '),
    projectedWaitMinutes: verdict === 'admit' ? 0 : rule.waitMinutes, snapshotAge, unknown, inputs });
  if (!snapshot || !Number.isFinite(sampledAt) || !Number.isFinite(freshUntil)) return result(cost === 'heavy' ? 'hold' : 'admit', 'snapshot-missing', true);
  if (nowMs > freshUntil + resolved.staleGraceMs) return result(cost === 'heavy' ? 'hold' : 'admit', 'snapshot-stale (age ' + snapshotAge + 's)', true);
  if (inputs.memPressureLevel !== null && inputs.memPressureLevel > rule.maxMemPressureLevel)
    return result('hold', 'memory pressure ' + inputs.memPressureLevel + ' > ' + rule.maxMemPressureLevel);
  if (inputs.cpuIdlePct !== null && inputs.cpuIdlePct < rule.minCpuIdlePct)
    return result('wait', 'cpu idle ' + inputs.cpuIdlePct + '% < ' + rule.minCpuIdlePct + '%');
  if (inputs.diskBusyPct !== null && rule.maxDiskBusyPct !== null && inputs.diskBusyPct > rule.maxDiskBusyPct)
    return result('wait', 'disk busy ' + inputs.diskBusyPct + '% > ' + rule.maxDiskBusyPct + '%');
  const held = snapshot.heavySlots?.held; const cap = snapshot.heavySlots?.cap;
  if (rule.maxHeavySlotsHeldPct != null) {
    if (Number.isFinite(held) && Number.isFinite(cap) && cap > 0) {
      const pct = held / cap * 100;
      if (pct > rule.maxHeavySlotsHeldPct) return result('wait', 'heavy slots held ' + pct.toFixed(1) + '% > ' + rule.maxHeavySlotsHeldPct + '%');
    } else unknownFields.push('heavy slots unknown');
  }
  return result('admit', inputs.cpuIdlePct === null ? 'admitted with unavailable probes' :
    'cpu idle ' + inputs.cpuIdlePct + '% ≥ ' + rule.minCpuIdlePct + '%');
}
