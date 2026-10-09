/**
 * @file we:scripts/lib/resource-sampler.mjs
 * Shared shadow facts: macOS load includes disk waits, so CPU availability uses time
 * deltas. Pure parsers precede injectable IO. Nothing samples at import time.
 */
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceFor } from './lane-pool-paths.mjs';
import { admissionStatus, admissionLockRoot, resolveCap } from '../readiness/heavy-admission.mjs';

const round = n => Math.round(n * 10) / 10;
const finite = n => Number.isFinite(n) ? n : null;
// Resolved lazily (see we:scripts/lib/resource-admission.mjs#loadResourcePolicy for why).
const repoRoot = () => fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

export function cpuIdlePctFromTimes(prevCpus, nextCpus) {
  if (!Array.isArray(prevCpus) || !Array.isArray(nextCpus) || prevCpus.length !== nextCpus.length) return null;
  let idle = 0; let total = 0;
  for (let i = 0; i < nextCpus.length; i++) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const delta = nextCpus[i]?.times?.[key] - prevCpus[i]?.times?.[key];
      if (!Number.isFinite(delta) || delta < 0) return null;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  return total > 0 ? round(idle / total * 100) : null;
}
export function parseIoregDiskStats(text) {
  const sums = {};
  for (const key of ['Total Time (Read)', 'Total Time (Write)', 'Bytes (Read)', 'Bytes (Write)']) {
    const escaped = key.replace(/[()]/g, '\\$&');
    const matches = [...String(text).matchAll(new RegExp('"' + escaped + '"\\s*=\\s*(\\d+)', 'g'))];
    if (!matches.length) return null;
    sums[key] = matches.reduce((sum, match) => sum + Number(match[1]), 0);
  }
  return { totalTimeNs: sums['Total Time (Read)'] + sums['Total Time (Write)'], bytesRead: sums['Bytes (Read)'], bytesWritten: sums['Bytes (Write)'] };
}
export function diskFromDeltas(prev, next, elapsedMs) {
  if (!prev || !next || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const deltas = ['totalTimeNs', 'bytesRead', 'bytesWritten'].map(key =>
    Number.isFinite(prev[key]) && Number.isFinite(next[key]) ? next[key] - prev[key] : NaN);
  if (deltas.some(n => !Number.isFinite(n) || n < 0)) return null;
  // ioreg's Total Time sums every request's service time, so overlapping requests make it exceed wall time:
  // the raw ratio is the average number of I/Os in flight (`ioDepth`), and busyPct is that ratio capped at 100.
  const ioDepth = deltas[0] / (elapsedMs * 1e6);
  return { busyPct: round(Math.min(100, ioDepth * 100)), ioDepth: round(ioDepth),
    readMBps: round(deltas[1] / (elapsedMs * 1000)), writeMBps: round(deltas[2] / (elapsedMs * 1000)) };
}
export function parsePsCpu(text) {
  return String(text).split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(line);
    return m ? [{ pid: Number(m[1]), pcpu: Number(m[2]), comm: m[3] }] : [];
  });
}
export const fseventsCpuPct = procs => round(procs.filter(p => basename(p.comm) === 'fseventsd').reduce((sum, p) => sum + p.pcpu, 0));
export function countAgentSessions(procs) {
  const claude = procs.filter(p => basename(p.comm) === 'claude').length;
  const codex = procs.filter(p => basename(p.comm) === 'codex').length;
  return { claude, codex, total: claude + codex };
}
export function memoryPressureLevel(text) {
  const value = String(text).trim();
  return /^(1|2|4)$/.test(value) ? Number(value) : null;
}
export function buildSnapshot({ sampledAtMs, intervalMs, cpuIdlePct, cores, loadAvg, memPressureLevel, memFreePct, disk, fseventsdCpuPct, heavySlots, agentSessions, laneCount, errors = [] }) {
  return { schema: 'resource-snapshot/1', sampledAt: new Date(sampledAtMs).toISOString(),
    freshUntil: new Date(sampledAtMs + 3 * intervalMs).toISOString(), intervalMs,
    cpu: { idlePct: finite(cpuIdlePct), cores: finite(cores), loadAvg: [0, 1, 2].map(i => finite(loadAvg?.[i])) },
    memory: { pressureLevel: finite(memPressureLevel), freePct: finite(memFreePct) },
    disk: { busyPct: finite(disk?.busyPct), ioDepth: finite(disk?.ioDepth), readMBps: finite(disk?.readMBps), writeMBps: finite(disk?.writeMBps) },
    // macOS exposes no public fsevents backlog counter.
    fsevents: { fseventsdCpuPct: finite(fseventsdCpuPct), backlog: null },
    heavySlots: heavySlots ?? null,
    agentSessions: agentSessions ?? { claude: null, codex: null, total: null }, laneCount: finite(laneCount), errors };
}
// `checkoutRoot` is the REAL checkout (the daemon clone), never this module's own location: a job on the job model
// runs from a pinned code snapshot outside the workspace, where neither the lane pool nor the slot locks live.
function defaultHeavySlots(checkoutRoot = repoRoot()) {
  // Reuse we:scripts/readiness/heavy-admission.mjs; heavy capacity excludes its separate fast lane.
  const cap = resolveCap();
  const status = admissionStatus({ lockRoot: admissionLockRoot(checkoutRoot), cap });
  return { held: status.heldCount, cap };
}
function defaultCountLanes(checkoutRoot = repoRoot()) {
  const pool = join(workspaceFor(checkoutRoot), '.lanes');
  return readdirSync(pool, { withFileTypes: true }).filter(d => d.isDirectory()).reduce((sum, d) =>
    sum + readdirSync(join(pool, d.name), { withFileTypes: true }).filter(l => l.isDirectory() && l.name.startsWith('lane-')).length, 0);
}
/** Initial delta is unknown; cadence defaults to 10s until two sampling times exist. */
export function createSampler({ exec = execFileSync, cpus = os.cpus, loadavg = os.loadavg, freemem = os.freemem,
  totalmem = os.totalmem, checkoutRoot = repoRoot(), readHeavySlots = () => defaultHeavySlots(checkoutRoot),
  countLanes = () => defaultCountLanes(checkoutRoot), now = Date.now } = {}) {
  let previousCpus = null; let previousDisk = null; let previousTime = null;
  return { sample() {
    const errors = [];
    const probe = (name, fn) => {
      try { return fn(); } catch (error) { errors.push({ probe: name, error: String(error?.message ?? error) }); return null; }
    };
    const sampledAtMs = probe('now', () => { const n = now(); if (!Number.isFinite(n)) throw Error('invalid clock'); return n; }) ?? Date.now();
    const intervalMs = previousTime !== null && sampledAtMs > previousTime ? sampledAtMs - previousTime : 10000;
    const run = (command, args) => exec(command, args, { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
    const nextCpus = probe('cpus', cpus);
    const cpuIdlePct = probe('cpuIdlePct', () => cpuIdlePctFromTimes(previousCpus, nextCpus));
    const nextDisk = probe('disk', () => {
      const value = parseIoregDiskStats(run('ioreg', ['-c', 'IOBlockStorageDriver', '-r', '-w', '0', '-d', '1']));
      if (!value) throw Error('unrecognized ioreg statistics'); return value;
    });
    const disk = diskFromDeltas(previousDisk, nextDisk, sampledAtMs - previousTime);
    const memPressureLevel = probe('memPressureLevel', () => {
      const value = memoryPressureLevel(run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']));
      if (value === null) throw Error('unrecognized memory pressure'); return value;
    });
    const memFreePct = probe('memFreePct', () => {
      const free = freemem(); const total = totalmem();
      if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) throw Error('invalid memory totals');
      return round(free / total * 100);
    });
    const procs = probe('ps', () => parsePsCpu(run('ps', ['-A', '-o', 'pid=,pcpu=,comm='])));
    const snapshot = buildSnapshot({ sampledAtMs, intervalMs, cpuIdlePct, cores: nextCpus?.length,
      loadAvg: probe('loadavg', loadavg), memPressureLevel, memFreePct, disk,
      fseventsdCpuPct: procs === null ? null : fseventsCpuPct(procs),
      agentSessions: procs === null ? null : countAgentSessions(procs),
      heavySlots: probe('heavySlots', readHeavySlots), laneCount: probe('laneCount', countLanes), errors });
    previousCpus = nextCpus; previousDisk = nextDisk; previousTime = sampledAtMs;
    return snapshot;
  } };
}
// Storage is owned by the reader library (see its header for why); re-exported for the sampler's callers.
export { resourcePaths, appendResourceLog, writeSnapshot, readSnapshot } from './resource-admission.mjs';
