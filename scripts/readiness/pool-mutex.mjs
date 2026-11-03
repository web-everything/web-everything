import {mkdirSync, rmdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {probePidLiveness} from './pid-liveness.mjs';

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = ms => Atomics.wait(sleeper, 0, 0, ms);
function processStart(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)],
      {encoding: 'utf8', timeout: 1000, maxBuffer: 4096}).trim() || null;
  } catch { return null; }
}
function readOwner(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Pool-wide sync exclusion for remote slot acquisition and slot-lock reaping.
 * Unknown/unreadable ownership stays locked; callers skip this pass on mutex-busy.
 * spinClock and spinSleep are test seams; elapsed waits use a monotonic clock independently of lease time.
 * Recovery uses a separate mkdir guard, never automatically reaped. A crashed recovery guard fails
 * closed: an operator must verify no recovery is running before removing .pool-mutex.recovery.
 */
export function withPoolMutex(root, fn, {clock = Date.now, liveness = probePidLiveness,
  selfPid = process.pid, waitMs = 2000, spinClock = () => performance.now(), spinSleep = sleep,
  onRecovery = () => {} /* TEST-ONLY interleaving seam: judged/unlinked while recovery guard is held */} = {}) {
  mkdirSync(root, {recursive: true});
  const file = join(root, '.pool-mutex'), start = spinClock();
  for (;;) {
    let fd;
    try { fd = openSync(file, 'wx'); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    if (fd !== undefined) {
      const owner = {pid: selfPid, startedAt: null, at: clock()};
      try {
        owner.startedAt = processStart(selfPid);
        writeFileSync(fd, JSON.stringify(owner));
        return {ok: true, value: fn()};
      } finally {
        closeSync(fd);
        const current = readOwner(file);
        if (current?.pid === owner.pid && current?.at === owner.at) unlinkSync(file);
      }
    }
    const owner = readOwner(file);
    if (Number.isInteger(owner?.pid) && owner.pid > 0 && liveness(owner.pid, selfPid) === 'dead') {
      // Only one recoverer may judge and unlink at a time. Comparing identity without this guard
      // would let a delayed recoverer unlink the next holder after another recoverer already won.
      const recovery = `${file}.recovery`;
      let held = false, removed = false;
      try { mkdirSync(recovery); held = true; }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      if (held) {
        try {
          const latest = readOwner(file);
          if (latest?.pid === owner.pid && latest?.at === owner.at
            && liveness(latest.pid, selfPid) === 'dead') {
            onRecovery('judged');
            try { unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
            removed = true;
            onRecovery('unlinked');
          }
        } finally { rmdirSync(recovery); }
      }
      if (removed) continue;
    }
    const remaining = waitMs - (spinClock() - start);
    if (!(remaining > 0)) return {ok: false, reason: 'mutex-busy'};
    spinSleep(Math.min(5, remaining));
  }
}
