/** Daily lease-guarded pool trim, called by the existing health-watch tick.
 * Stamp attempts before subprocesses so failures/restarts cannot cause a tight retry loop.
 * Unknown state refuses maintenance; repair the named stamp before retrying.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { boundedText, loadHostOverloadSettings } from './host-overload-settings.mjs';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';

const DAY = 86400000;
const safeMessage = error => String(error?.message || error).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').slice(0, 500);

export function scheduledLaneMaintenance({
  root, poolDir, repoPath = null, max = null, dryRun = false, nowMs = Date.now(),
  exec = execFileSync, loadSettings = loadHostOverloadSettings, emitEvent = appendDaemonEvent,
  log = message => process.stderr.write(`${message}\n`),
} = {}) {
  if (dryRun) return { trim: null, skipped: true };
  let stamp;
  try {
    if (typeof poolDir !== 'string' || !poolDir) throw Error('pool path unavailable');
    stamp = join(poolDir, '.maintenance-stamp.json');
    const configured = loadSettings({ log }).settings.lanes.gc.schedule;
    if (!Number.isSafeInteger(configured) || configured < 60000) throw Error('invalid maintenance schedule');
    const interval = Math.max(DAY, configured);
    log(`lane maintenance: effective interval=${interval}ms (lanes.gc.schedule with 24h floor)`);
    return withFileLock(`${stamp}.lock`, () => {
      let previous;
      try {
        previous = JSON.parse(boundedText(stamp, 1024)).at;
        if (!Number.isSafeInteger(previous) || previous < 0 || previous > nowMs) throw Error('invalid maintenance stamp');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous !== undefined && nowMs - previous < interval) return { trim: null, skipped: true };
      writeJsonAtomic(stamp, { at: nowMs });
      const errors = [];
      const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' };
      const measure = () => {
        try {
          const out = String(exec('du', ['-sk', poolDir], { ...options, timeout: 60000 }));
          const match = out.match(/^(\d+)\s/);
          const bytes = match ? Number(match[1]) * 1024 : NaN;
          if (!Number.isSafeInteger(bytes)) throw Error('invalid du output');
          return bytes;
        } catch (error) { errors.push(`du: ${safeMessage(error)}`); return null; }
      };
      const cli = [join(root, 'scripts', 'lane-pool.mjs')];
      const selector = repoPath ? [`--repo=${repoPath}`] : [];
      const bytesBefore = measure();
      let trim = null;
      try {
        const args = [...cli, 'trim', '--json', ...selector];
        if (Number.isInteger(max) && max >= 0) args.push(`--max=${max}`);
        trim = JSON.parse(String(exec(process.execPath, args, options)));
        if (!Array.isArray(trim?.removed) || !trim.removed.every(Number.isSafeInteger)) throw Error('invalid trim report');
      } catch (error) { trim = null; errors.push(`trim: ${safeMessage(error)}`); }
      // Schedule only trim, which holds lane claims. GC's host lock does not exclude
      // concurrent lane acquisition, and no shared filesystem claim primitive is exposed.
      const bytesAfter = measure();
      const detail = { poolDir, lanesTrimmed: trim?.removed ?? null, bytesBefore, bytesAfter,
        bytesFreed: bytesBefore === null || bytesAfter === null ? null : Math.max(0, bytesBefore - bytesAfter), errors };
      try { Promise.resolve(emitEvent({ kind: 'lane-pool-maintenance', daemon: 'lane-pool-health-watch', detail })).catch(() => {}); }
      catch { /* Event storage must not fail the pass. */ }
      for (const error of errors) log(`lane maintenance: ${error}`);
      return { trim, detail };
    }, { timeoutMs: 0 });
  } catch (error) {
    log(`lane maintenance skipped: ${safeMessage(error)}; inspect/repair ${stamp || 'pool path/policy'} before retrying`);
    return { trim: null, skipped: true };
  }
}
