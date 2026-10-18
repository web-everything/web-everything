/** Shared admission for background work; operator interactive commands bypass this check.
 * No network endpoint: body size/rate/CSRF do not apply. Scan/GC triggers use host single-flight locks.
 */
import { createHash } from 'node:crypto';
import { loadavg, cpus } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { loadHostOverloadSettings, hostStateRoot, boundedText } from './host-overload-settings.mjs';
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
export function hostLoadAdmission({ policy, load = readHostLoad, cores = () => cpus().length, interactive = !!process.stdin.isTTY, env = process.env, log } = {}) {
  if (interactive) return { admitted: true, reason: 'operator interactive command' };
  try {
    policy ??= loadHostOverloadSettings({ env, log });
    const limit = policy.settings.host.maxLoadPerCore;
    const l = load()[0]; const c = cores();
    if (!Number.isFinite(l) || l < 0 || !Number.isFinite(c) || c <= 0 || !Number.isFinite(limit) || limit <= 0) throw Error('unknown host load');
    const ratio = l / c;
    return { admitted: ratio <= limit, reason: `host load ${l.toFixed(2)}/${c}=${ratio.toFixed(2)}; host.maxLoadPerCore=${limit} (${policy.sources['host.maxLoadPerCore']})` };
  } catch (e) { return { admitted: false, reason: `host load unknown: ${e.message}` }; }
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
      for (const lane of lanes) {
        const key = digest(resolve(lane));
        const last = cursor[key];
        if (last !== undefined && (!Number.isFinite(last) || last > nowMs)) throw Error('unknown gc cursor');
        if (last !== undefined && nowMs - last < schedule) continue;
        const host = admission({ env, log, interactive });
        if (!host.admitted) { log(`gc skipped: ${host.reason}`); return { ran, reason: host.reason }; }
        exec('git', ['-c', 'gc.auto=0', '-c', 'gc.autoDetach=false', '-c', 'gc.pruneExpire=never', 'gc', '--no-detach'], { cwd: lane, timeout: 120000, stdio: 'pipe' });
        cursor[key] = nowMs;
        // Match writeJsonAtomic's indentation and trailing newline, including at the read limit.
        if (Buffer.byteLength(`${JSON.stringify(cursor, null, 2)}\n`) > 256 * 1024) throw Error('gc cursor too large');
        writeJsonAtomic(file, cursor);
        ran = true;
      }
      return { ran, ...(!ran ? { reason: 'gc schedule not due' } : {}) };
    }, { stateRoot });
  } catch (e) { log(`gc skipped: ${e.message}`); return { ran: false, reason: e.message }; }
}
export const digest = (s) => createHash('sha256').update(s).digest('hex');
