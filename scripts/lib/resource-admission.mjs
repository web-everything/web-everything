/**
 * @file we:scripts/lib/resource-admission.mjs
 * One pure resource policy and best-effort IO for shadow comparisons. Thresholds
 * come from CPU idle, NOT load average: macOS disk waits inflate load with idle CPU.
 * Cascade: standard → Platform Forever preference → tool override, per field.
 * This library returns observations only; callers retain their existing gates.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

// ── SNAPSHOT STORAGE. Lives HERE (the light reader every gate imports), not in the sampler: the sampler pulls in
// we:scripts/readiness/heavy-admission.mjs for its slot count, and heavy-admission imports this file for its
// shadow call — keeping storage here keeps that import one-way.
export function resourcePaths(root = resolveCoordinationRoot()) {
  const dir = join(root, 'resource');
  return { dir, snapshot: join(dir, 'snapshot.json'), history: join(dir, 'history.jsonl'), shadow: join(dir, 'shadow.jsonl') };
}
/** Bound by BYTES (one stat per append), never by re-reading the file each time: the sampler appends every ~10 s. */
export const RESOURCE_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** Serialize append/trim so concurrent shadow callers cannot lose a row during rotation. */
export function appendResourceLog(path, row, { maxBytes = RESOURCE_LOG_MAX_BYTES } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  withFileLock(path + '.lock', () => {
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
    if (statSync(path).size <= maxBytes) return;
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    writeFileSync(path, lines.slice(-Math.max(1, Math.floor(lines.length / 2))).join('\n') + '\n', 'utf8');
  }, { timeoutMs: 500 });
}
/** The snapshot itself is the contract; history is best-effort evidence and never fails the write. */
export function writeSnapshot(snapshot, { root } = {}) {
  const paths = resourcePaths(root);
  mkdirSync(paths.dir, { recursive: true });
  writeJsonAtomic(paths.snapshot, snapshot);
  try { appendResourceLog(paths.history, snapshot); } catch { /* history is evidence only */ }
}
export function readSnapshot({ root } = {}) {
  try { return JSON.parse(readFileSync(resourcePaths(root).snapshot, 'utf8')); } catch { return null; }
}

// maxDiskBusyPct defaults to null (record, never gate): on this NVMe host the disk reads 100% busy (several I/Os
// in flight) on an ordinary afternoon with the CPU 45% idle, so a disk threshold needs calibrating from the shadow
// log first (slice 2) — a tool override or platform preference can set one now.
const kindPolicy = (cpu, cost = 'heavy') => Object.freeze({ class: cost, minCpuIdlePct: cpu,
  maxMemPressureLevel: 2, maxDiskBusyPct: null, waitMinutes: 2 });
// Fixes tolerate busier CPUs; timing-sensitive flake re-verification needs a quiet host.
// Light preparation does no heavy local work; critical memory pressure still holds it.
export const RESOURCE_POLICY_STANDARD = Object.freeze({
  build: kindPolicy(15), prepare: kindPolicy(5, 'light'), fix: kindPolicy(8),
  'ci-heal': kindPolicy(8), review: kindPolicy(10), 'rebuild-smoke': kindPolicy(5),
  'load-flake-rearm': kindPolicy(20), light: kindPolicy(5, 'light'), staleGraceMs: 0,
});
const kinds = Object.keys(RESOURCE_POLICY_STANDARD).filter(k => k !== 'staleGraceMs');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = v => Number.isFinite(v) && v >= 0;
const percent = v => nonnegative(v) && v <= 100;
const validators = {
  class: v => v === 'heavy' || v === 'light', minCpuIdlePct: percent,
  maxMemPressureLevel: v => [1, 2, 4].includes(v),
  maxDiskBusyPct: v => v === null || percent(v),
  maxHeavySlotsHeldPct: v => v === null || percent(v), waitMinutes: nonnegative,
};
function validLayer(layer) {
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
    if (!validLayer(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'staleGraceMs') policy[key] = value;
      else Object.assign(policy[key], value);
    }
  }
  return policy;
}
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function loadResourcePolicy({ env = process.env, repoRoot = REPO_ROOT, home = homedir() } = {}) {
  const sources = { platform: null, tool: null };
  const readLayer = (source, path) => {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (!object(file)) throw Error('expected an object');
      if (!Object.hasOwn(file, 'resourceAdmission')) return undefined;
      if (!validLayer(file.resourceAdmission)) throw Error('invalid resourceAdmission policy');
      sources[source] = path;
      return file.resourceAdmission;
    } catch (error) {
      if (error?.code !== 'ENOENT') (sources.errors ??= []).push({ source, path, error: String(error?.message ?? error) });
      return undefined;
    }
  };
  const platform = readLayer('platform', env.WE_PLATFORM_PREFERENCES || join(home, '.claude', 'platform-preferences.json'));
  const tool = readLayer('tool', join(repoRoot, 'scripts', 'dispatch-settings.json'));
  return { policy: resolveResourcePolicy({ platform, tool }), sources };
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
function audit(root, row) {
  try { appendResourceLog(resourcePaths(root).shadow, row); } catch { /* Observability must not change a gate. */ }
}
function auditRow({ gate, kind, oldVerdict, oldReason, nowMs }, decision) {
  return { at: new Date(nowMs).toISOString(), gate, kind, old: { verdict: oldVerdict, reason: oldReason },
    new: { verdict: decision.verdict, reason: decision.reason, snapshotAge: decision.snapshotAge, unknown: decision.unknown },
    agree: oldVerdict === decision.verdict };
}
export function admit({ kind, env = process.env, nowMs = Date.now(), root, policy } = {}) {
  let decision;
  try {
    root ??= resolveCoordinationRoot({ env });
    decision = decideAdmission({ kind, snapshot: readSnapshot({ root }), policy: policy ?? loadResourcePolicy({ env }).policy, nowMs });
  } catch {
    decision = decideAdmission({ kind, snapshot: null, nowMs });
  }
  // Unknown is always audited, including direct callers and WE_RESOURCE_SHADOW=off.
  if (decision.unknown) {
    try { audit(root, auditRow({ gate: 'resource-admission', kind, oldVerdict: null, oldReason: null, nowMs }, decision)); } catch { /* best effort */ }
  }
  return decision;
}
/** Return comparison evidence only. An off switch skips all reads and logging. */
export function shadowAdmission({ gate, kind, oldVerdict, oldReason, env = process.env, nowMs = Date.now(), root, log = line => process.stderr.write(line) } = {}) {
  // Either the caller's env or this process's env can switch it off: gates often pass a hand-built env, and a test
  // suite stubs only process.env — neither must leak shadow rows into the real coordination root.
  if (env.WE_RESOURCE_SHADOW === 'off' || process.env.WE_RESOURCE_SHADOW === 'off') return undefined;
  const decision = admit({ kind, env, nowMs, root });
  try {
    root ??= resolveCoordinationRoot({ env });
    audit(root, auditRow({ gate, kind, oldVerdict, oldReason, nowMs }, decision));
  } catch { /* best effort */ }
  try {
    log('resource-shadow gate=' + gate + ' kind=' + kind + ' old verdict: ' + oldVerdict + ' (' + oldReason +
      ') | new verdict: ' + decision.verdict + ' (' + decision.reason + ', snapshot age ' + decision.snapshotAge + 's)\n');
  } catch { /* A closed stderr or failing logger must not affect admission. */ }
  return decision;
}
