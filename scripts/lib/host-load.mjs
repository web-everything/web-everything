/** Shared admission for background work; operator interactive commands bypass this check.
 * No network endpoint: body size/rate/CSRF do not apply. Scan/GC triggers use host single-flight locks.
 */
import { createHash } from 'node:crypto';
import { loadavg, cpus, freemem } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { loadHostOverloadSettings, hostStateRoot, boundedText, DEFAULT_MIN_MEMORY_HEADROOM_MB } from './host-overload-settings.mjs';
/** Subprocess fixtures may supply a reading only under Vitest. Production always samples the host.
 * Keep the source injectable so tests can also prove the real-source fallback without sampling the host.
 */
export function readHostLoad({ env = process.env, load = loadavg } = {}) {
  if (env.VITEST === 'true' && env.WE_TEST_HOST_LOAD1 !== undefined) {
    const value = Number(env.WE_TEST_HOST_LOAD1);
    if (env.WE_TEST_HOST_LOAD1.trim() === '' || !Number.isFinite(value) || value < 0) throw Error('invalid test host load');
    return [value];
  }
  return load();
}
const darwinPages = (vm, name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?(?:\\s|$)`, 'm').exec(vm)?.[1] ?? NaN);
/** Parse macOS `vm_stat` + `sysctl vm.swapusage` into headroom MB: free + speculative + purgeable pages (never the
 *  inactive file cache) plus free swap. Pure. Throws on unparseable input (the caller fails closed). */
export function parseDarwinMemoryHeadroomMb(vmStat, swapUsage) {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = (name) => darwinPages(vmStat, name);
  const free = pages('free'); const spec = pages('speculative'); const purge = pages('purgeable');
  const swapFree = /free = ([\d.]+)M/.exec(swapUsage)?.[1];
  if (![page, free, spec, Number(swapFree)].every(Number.isFinite) || page <= 0) throw Error('unparseable vm_stat/swapusage');
  return ((free + spec + (Number.isFinite(purge) ? purge : 0)) * page) / 1048576 + Number(swapFree);
}
let probeLogged = false;
export function resetProbeLogForTests() { probeLogged = false; }
/** Bounded memory probes, strongest first; no swap credit when swap cannot be read. */
export function readHostMemoryHeadroom({ env = process.env, platform = process.platform, exec = execFileSync, free = freemem,
  log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const selected = (mb, probe) => {
    if (!Number.isFinite(mb) || mb < 0) throw Error('invalid host memory reading');
    if (!probeLogged) { log(`host memory probe: ${probe}`); probeLogged = true; }
    return { mb, probe };
  };
  if (env.VITEST === 'true' && env.WE_TEST_HOST_MEMORY_MB !== undefined) {
    const value = Number(env.WE_TEST_HOST_MEMORY_MB);
    if (env.WE_TEST_HOST_MEMORY_MB.trim() === '' || !Number.isFinite(value) || value < 0) throw Error('invalid test host memory');
    return selected(value, 'test');
  }
  if (platform === 'darwin') {
    const opts = { encoding: 'utf8', timeout: 5000 };
    const vm = () => exec('vm_stat', [], opts);
    // memory_pressure includes file cache, inflating headroom and bypassing the admission minimum.
    const probes = [
      ['vm_stat+swapusage', () => parseDarwinMemoryHeadroomMb(vm(), exec('sysctl', ['vm.swapusage'], opts))],
      ['vm_stat', () => parseDarwinMemoryHeadroomMb(vm(), 'free = 0M')],
      ['hw.memsize+vm_stat', () => {
        const bytes = Number(/^hw\.memsize:\s*(\d+)\s*$/.exec(exec('sysctl', ['hw.memsize'], opts))?.[1]);
        const output = vm();
        // Partial page-category sums omit compressor memory; only credit observed free-page bytes.
        const page = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
        const freeBytes = darwinPages(output, 'free') * page;
        if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(page) || page <= 0 || !Number.isFinite(freeBytes) || freeBytes > bytes) throw Error('unparseable hw.memsize/vm_stat');
        return freeBytes / 1048576;
      }],
    ];
    let failure;
    for (const [probe, read] of probes) {
      try { return selected(read(), probe); } catch (e) { failure = e; }
    }
    throw failure;
  }
  return selected(free() / 1048576, 'freemem');
}
/** Numeric compatibility wrapper for admission and existing callers. */
export function readHostMemoryHeadroomMb(options) {
  return readHostMemoryHeadroom(options).mb;
}
export function hostLoadAdmission({ policy, load = readHostLoad, cores = () => cpus().length, memory = readHostMemoryHeadroomMb, interactive = !!process.stdin.isTTY, env = process.env, log } = {}) {
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
  // Memory is checked only once load admits; unknown memory fails closed (wait), like unknown load.
  try {
    // A hand-built policy without the leaf takes the standard value; a loaded policy always carries it.
    const min = policy.settings.host.minMemoryHeadroomMb ?? DEFAULT_MIN_MEMORY_HEADROOM_MB;
    const mb = memory({ env, log });
    if (!Number.isFinite(mb) || mb < 0 || !Number.isFinite(min) || min <= 0) throw Error('unknown host memory');
    const reason = `host memory headroom ${Math.round(mb)}MB (free+swap); host.minMemoryHeadroomMb=${min} (${policy.sources?.['host.minMemoryHeadroomMb'] ?? 'standard'})`;
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
export function scheduledLaneGc(lanes, { stateRoot = hostStateRoot(), exec = execFileSync, admission = hostLoadAdmission,
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
        const key = digest(resolve(lane));
        const last = cursor[key];
        if (last !== undefined && (!Number.isFinite(last) || last > nowMs)) throw Error('unknown gc cursor');
        if (last !== undefined && nowMs - last < schedule) continue;
        const host = admission({ env, log, interactive });
        if (!host.admitted) { log(`gc skipped: ${host.reason}`); return { ran, reason: host.reason }; }
        try {
          exec('git', ['-c', 'gc.auto=0', '-c', 'gc.autoDetach=false', '-c', 'gc.pruneExpire=never', 'gc', '--no-detach'], { cwd: lane, timeout: 120000, stdio: 'pipe' });
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
