/**
 * @file we:scripts/lib/heavy-admission-resources.mjs
 * @description heavy-admission's resource verdict: CPU idle %, free memory % and swap % from the SAME shared
 *   resource snapshot the fix-dispatch daemon reads (resource-admission.mjs / resource-policy.mjs), instead of the
 *   macOS load average (which counts disk-waiting threads: load 30 at 70% idle CPU refused six test runs for 30+ min).
 *   PURE. Thresholds are the existing cascade's standard values: CPU idle floor and memory-pressure ceiling from
 *   RESOURCE_POLICY_STANDARD (kind `build`), free-memory and swap HOLD lines from RESOURCE_GATE_STANDARD.fixCap
 *   (lowerBelowMemFreePct, lowerAboveSwapUsedPct). Fails closed: anything unreadable returns `verdict: null`
 *   (unknown), and the caller keeps the legacy load verdict. It never raises a slot cap; it only answers "is the host busy".
 */
import { decideAdmission } from './resource-policy.mjs';
import { RESOURCE_GATE_STANDARD } from './resource-gate.mjs';

export const HEAVY_ADMISSION_GATES = Object.freeze(['load', 'shadow', 'resources']);
export const HEAVY_RESOURCE_KIND = 'build';
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function resourceVerdict({ snapshot, nowMs = Date.now(), policy, gate = RESOURCE_GATE_STANDARD.fixCap } = {}) {
  const memFreePct = fin(snapshot?.memory?.freePct);
  const swapUsedPct = fin(snapshot?.memory?.swapUsedPct);
  const cpuIdlePct = fin(snapshot?.cpu?.idlePct);
  const minMem = gate.lowerBelowMemFreePct; const maxSwap = gate.lowerAboveSwapUsedPct;
  const sources = `cpu idle/mem pressure: resource-policy standard (${HEAVY_RESOURCE_KIND}); mem free >= ${minMem}% and swap <= ${maxSwap}%: resource-gate standard`;
  const pressureLevel = fin(snapshot?.memory?.pressureLevel);
  const base = { cpuIdlePct, memFreePct, swapUsedPct, pressureLevel, sources };
  let d;
  try { d = decideAdmission({ kind: HEAVY_RESOURCE_KIND, snapshot, ...(policy ? { policy } : {}), nowMs }); }
  catch (e) { return { ...base, verdict: null, reason: `resource verdict unavailable: ${String(e?.message ?? e).split('\n')[0]}` }; }
  // Stricter-only: an observed breach defers even when another field is missing (audit 2026-10-20).
  if (!d.unknown && d.verdict !== 'admit') return { ...base, verdict: 'defer', reason: d.reason };
  if (memFreePct !== null && memFreePct < minMem) return { ...base, verdict: 'defer', reason: `mem free ${memFreePct}% < ${minMem}%` };
  if (swapUsedPct !== null && swapUsedPct > maxSwap) return { ...base, verdict: 'defer', reason: `swap used ${swapUsedPct}% > ${maxSwap}%` };
  if (d.unknown || cpuIdlePct === null || memFreePct === null || swapUsedPct === null || pressureLevel === null) {
    return { ...base, verdict: null, reason: d.unknown ? d.reason : 'resource snapshot incomplete (cpu idle, mem free, swap or pressure missing)' };
  }
  return { ...base, verdict: 'admit', reason: d.reason };
}

/** The one log line, on every decision (and whenever the pair of verdicts changes while waiting). */
export function shadowLine({ gate = 'shadow', gateSource = 'standard', legacy, legacyReason, res }) {
  return `heavy-admission shadow: legacy=${legacy} (${legacyReason}) new=${res.verdict ?? 'unknown (legacy obeyed)'} (cpu idle ${res.cpuIdlePct ?? '?'}%, mem free ${res.memFreePct ?? '?'}%, swap ${res.swapUsedPct ?? '?'}%, mem pressure ${res.pressureLevel ?? '?'}; ${res.reason}; ${res.sources}) [heavyAdmission.gate=${gate} (${gateSource})]`;
}

/** Combine per gate mode. Unknown new verdict always falls back to legacy (fail closed). */
export function effectiveVerdict({ gate, legacy, res }) {
  if (gate === 'resources' && res.verdict) return res.verdict;
  return legacy;
}
