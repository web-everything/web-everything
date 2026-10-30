/** Shared admission for background work; operator interactive commands bypass this check.
 * Structured memory readings prefer macOS pressure: warn/critical hold; normal requires
 * measured reclaimable headroom (including inactive pages) to meet the configured floor.
 * Pressure failure falls back to pages + free swap, pages alone, then os.freemem with provenance.
 * The numeric compatibility reader retains the original headroom probes.
 * Unavailable memory and measured low headroom refuse admission. Malformed readings,
 * non-denial probe errors and legacy numeric-reader failures also fail closed.
 * No network endpoint: body size/rate/CSRF do not apply. Scan/GC triggers use host single-flight locks.
 */
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import { mkdirSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as childProcess from 'node:child_process';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { loadHostOverloadSettings, hostStateRoot, boundedText, DEFAULT_MIN_MEMORY_HEADROOM_MB } from './host-overload-settings.mjs';
import { LEASE_FILENAME } from './lane-lease.mjs';

// GC has no reason to reclaim even a stale lease. Unknown markers/IO refuse work too.
function gcLeaseProtected(lane) {
  try { lstatSync(join(lane, '.git', LEASE_FILENAME)); return true; }
  catch (error) { return error.code !== 'ENOENT'; }
}
/** Subprocess fixtures may supply a reading only under Vitest. Production always samples the host.
 * Keep the source injectable so tests can also prove the real-source fallback without sampling the host.
 */
export function readHostLoad({ env = process.env, load = os.loadavg } = {}) {
  if (env.VITEST === 'true' && env.WE_TEST_HOST_LOAD1 !== undefined) {
    const value = Number(env.WE_TEST_HOST_LOAD1);
    if (env.WE_TEST_HOST_LOAD1.trim() === '' || !Number.isFinite(value) || value < 0) throw Error('invalid test host load');
    return [value];
  }
  return load();
}
/** Parse macOS `vm_stat` + `sysctl vm.swapusage` into headroom MB: free + speculative + purgeable pages (never the
 *  inactive file cache) plus free swap. Pure. Throws on unparseable input. */
export function parseDarwinMemoryHeadroomMb(vmStat, swapUsage) {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = (name) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? NaN);
  const free = pages('free'); const spec = pages('speculative'); const purge = pages('purgeable');
  const swapFree = /free = ([\d.]+)M/.exec(swapUsage)?.[1];
  if (![page, free, spec].every(Number.isFinite) || swapFree === undefined) throw Error('unparseable vm_stat/swapusage');
  return ((free + spec + (Number.isFinite(purge) ? purge : 0)) * page) / 1048576 + Number(swapFree);
}
/** Measured reclaimable MB under normal pressure: legacy headroom plus inactive pages.
 * Pure; incomplete or invalid evidence throws rather than implying unlimited memory. */
export function parseDarwinReclaimableMemoryMb(vmStat, swapUsage) {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const inactive = Number(/^Pages inactive:\s+(\d+)\.?\s*$/m.exec(vmStat)?.[1] ?? NaN);
  const headroom = parseDarwinMemoryHeadroomMb(vmStat, swapUsage);
  const mb = headroom + inactive * page / 1048576;
  if (!Number.isFinite(page) || page <= 0 || !Number.isFinite(inactive)
    || !Number.isFinite(headroom) || headroom < 0 || !Number.isFinite(mb) || mb < 0) {
    throw Error('unparseable reclaimable memory');
  }
  return mb;
}
/** Parse the macOS pressure sysctl's exact integer value. Pure; unknown levels throw. */
export function parseDarwinMemoryPressureLevel(text) {
  if (typeof text !== 'string') throw Error('unparseable memory pressure level');
  const level = { 1: 'normal', 2: 'warn', 4: 'critical' }[text.trim()];
  if (!['normal', 'warn', 'critical'].includes(level)) throw Error('unparseable memory pressure level');
  return level;
}
function isMemoryProbeDenied(error) {
  if (error?.code === 'ETIMEDOUT' || error?.message === 'ETIMEDOUT') return false;
  return ['EPERM', 'EACCES', 'ENOENT'].includes(error?.code)
    || /operation not permitted|permission denied|not permitted/i.test(error?.message ?? '');
}
function readFreeMemoryReading(free) {
  let mb;
  try { mb = free() / 1048576; }
  catch { return { mb: null, source: 'unknown' }; }
  if (!Number.isFinite(mb)) return { mb: null, source: 'unknown' };
  if (mb < 0) throw Error('invalid free memory');
  return { mb, source: 'os.freemem' };
}
/** Pressure failure falls back to headroom; invalid headroom and non-denial errors still throw. */
export function readHostMemoryReading(options = {}) {
  return readMemoryReading(options, true);
}
function readMemoryReading({ env = process.env, platform = process.platform, exec = childProcess.execFileSync, free = os.freemem } = {}, probePressure = false) {
  if (env.VITEST === 'true' && env.WE_TEST_HOST_MEMORY_MB !== undefined) {
    const value = Number(env.WE_TEST_HOST_MEMORY_MB);
    if (env.WE_TEST_HOST_MEMORY_MB.trim() === '' || !Number.isFinite(value) || value < 0) throw Error('invalid test host memory');
    return { mb: value, source: 'test-env' };
  }
  if (platform === 'darwin') {
    const opts = { encoding: 'utf8', timeout: 5000 };
    let level;
    if (probePressure) {
      try {
        level = parseDarwinMemoryPressureLevel(exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], opts));
      } catch {
        // Unavailable or unknown pressure must still pass the existing headroom checks.
      }
      if (level === 'warn' || level === 'critical') return { mb: 0, source: 'memory-pressure', level };
    }
    let vm;
    try {
      vm = exec('vm_stat', [], opts);
    } catch (e) {
      if (!isMemoryProbeDenied(e)) throw e;
      return readFreeMemoryReading(free);
    }
    const pagesMb = parseDarwinMemoryHeadroomMb(vm, 'free = 0M');
    if (!Number.isFinite(pagesMb) || pagesMb < 0) throw Error('invalid page headroom');
    let swap;
    try { swap = exec('sysctl', ['vm.swapusage'], opts); }
    catch (e) {
      if (!isMemoryProbeDenied(e)) throw e;
      return { mb: pagesMb, source: 'vm_stat' };
    }
    const mb = level === 'normal' ? parseDarwinReclaimableMemoryMb(vm, swap) : parseDarwinMemoryHeadroomMb(vm, swap);
    if (!Number.isFinite(mb) || mb < 0) throw Error('invalid swap headroom');
    if (level === 'normal') return { mb, source: 'memory-pressure', level };
    return { mb, source: 'vm_stat+swap' };
  }
  return readFreeMemoryReading(free);
}
/** Numeric compatibility reader: unavailable memory is NaN; invalid readings still throw. */
export function readHostMemoryHeadroomMb(options = {}) {
  return readMemoryReading(options).mb ?? NaN;
}
export function hostLoadAdmission({ policy, load = readHostLoad, cores = () => os.cpus().length, memory,
  memoryReading = memory ? (options) => ({ mb: memory(options), source: 'injected' }) : readHostMemoryReading,
  interactive = !!process.stdin.isTTY, env = process.env, log } = {}) {
  if (interactive) return { admitted: true, reason: 'operator interactive command' };
  let loadVerdict;
  try {
    policy ??= loadHostOverloadSettings({ env, log });
    const limit = policy.settings.host.maxLoadPerCore;
    const l = load()[0]; const c = cores();
    if (!Number.isFinite(l) || l < 0 || !Number.isFinite(c) || c <= 0 || !Number.isFinite(limit) || limit <= 0) throw Error('unknown host load');
    const ratio = l / c;
    loadVerdict = { admitted: ratio <= limit, reason: `host load ${l.toFixed(2)}/${c}=${ratio.toFixed(2)}; host.maxLoadPerCore=${limit} (${policy.sources['host.maxLoadPerCore']})` };
  } catch (e) { return { admitted: false, reason: `host load unknown: ${e.message}` }; }
  if (!loadVerdict.admitted) return loadVerdict;
  // Memory is checked only once load admits; unavailable readings fail closed.
  try {
    // A hand-built policy without the leaf takes the standard value; a loaded policy always carries it.
    const min = policy.settings.host.minMemoryHeadroomMb ?? DEFAULT_MIN_MEMORY_HEADROOM_MB;
    if (!Number.isFinite(min) || min <= 0) throw Error('invalid host memory threshold');
    const { mb, source, level } = memoryReading({ env });
    if (!Number.isFinite(mb) || mb < 0) throw Error('unknown host memory');
    const description = source === 'memory-pressure'
      ? `host memory pressure ${level}; reclaimable headroom ${Math.round(mb)}MB`
      : `host memory headroom ${Math.round(mb)}MB (free+swap)`;
    const reason = `${description}; host.minMemoryHeadroomMb=${min} (${policy.sources?.['host.minMemoryHeadroomMb'] ?? 'standard'}); source=${source}`;
    return mb >= min ? { admitted: true, reason: `${loadVerdict.reason}; ${reason}` } : { admitted: false, reason };
  } catch (e) { return { admitted: false, reason: `host memory unknown: ${e.message}` }; }
}
export function hostSingleFlight(name, fn, { stateRoot = hostStateRoot() } = {}) {
  mkdirSync(stateRoot, { recursive: true });
  try { return withFileLock(join(stateRoot, `${name}.lock`), fn, { timeoutMs: 0 }); }
  catch (e) { if (e.message.startsWith('withFileLock:')) throw Error(`${name} busy; refusing concurrent run`); throw e; }
}
/** Demand-driven schedule: the maintenance command may be called each scheduler tick; only a due pass runs.
 * One host lock covers every pool and every git invocation, including after a restart. GC never detaches.
 */
export function scheduledLaneGc(lanes, { stateRoot = hostStateRoot(), exec = childProcess.execFileSync, admission = hostLoadAdmission,
  schedule, interactive = false, nowMs = Date.now(), log = (m) => process.stderr.write(`${m}\n`), env = process.env } = {}) {
  try {
    schedule ??= loadHostOverloadSettings({ env, log }).settings.lanes.gc.schedule;
    return hostSingleFlight('gc', () => {
      if (!Number.isSafeInteger(schedule) || schedule < 60000) throw Error('invalid gc schedule');
      const file = join(stateRoot, 'gc-cursor.json');
      let cursor = {};
      try { cursor = JSON.parse(boundedText(file)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw Error('unknown gc cursor');
      let ran = false;
      let failures = 0;
      for (const lane of lanes) {
        if (gcLeaseProtected(lane)) { log(`gc skipped leased/unreadable lane: ${lane}`); continue; }
        const key = digest(resolve(lane));
        const last = cursor[key];
        if (last !== undefined && (!Number.isFinite(last) || last > nowMs)) throw Error('unknown gc cursor');
        if (last !== undefined && nowMs - last < schedule) continue;
        const host = admission({ env, log, interactive });
        if (!host.admitted) { log(`gc skipped: ${host.reason}`); return { ran, reason: host.reason }; }
        if (gcLeaseProtected(lane)) { log(`gc skipped leased/unreadable lane: ${lane}`); continue; }
        try {
          const args = ['-c', 'gc.auto=0', '-c', 'gc.autoDetach=false', '-c', 'gc.pruneExpire=never', 'gc', '--no-detach'];
          const options = { cwd: lane, timeout: 120000, stdio: 'pipe' };
          try { exec('git', args, options); } catch (e) {
            if (e.status !== 129 || !/unknown option [`']no-detach'/.test(String(e.stderr))) throw e;
            // Git 2.43 has no detach option: explicit (non-auto) gc already runs in the foreground.
            exec('git', args.slice(0, -1), options);
          }
        } catch (e) {
          // A damaged or slow clone must not starve the rest of the pool. Leave it due for retry.
          failures++;
          log(`gc failed for ${lane}: ${e.message}`);
          continue;
        }
        cursor[key] = nowMs;
        // Match writeJsonAtomic's indentation and trailing newline, including at the read limit.
        if (Buffer.byteLength(`${JSON.stringify(cursor, null, 2)}\n`) > 256 * 1024) throw Error('gc cursor too large');
        writeJsonAtomic(file, cursor);
        ran = true;
      }
      return { ran, ...(failures ? { reason: `${failures} lane gc run(s) failed` } : !ran ? { reason: 'gc schedule not due' } : {}) };
    }, { stateRoot });
  } catch (e) { log(`gc skipped: ${e.message}`); return { ran: false, reason: e.message }; }
}
export const digest = (s) => createHash('sha256').update(s).digest('hex');
