import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { LEASE_FILENAME, renewedLease } from './lane-lease.mjs';

// Best effort, atomic renewal; resolve the git directory even from a lane subdirectory.
export function renewLaneLease({ cwd, run = (file, args, opts) => spawnSync(file, args, { ...opts, encoding: 'utf8', timeout: 5000 }), now = () => new Date(), fs = { writeFileSync, renameSync, rmSync } } = {}) {
  try {
    const gd = run('git', ['rev-parse', '--absolute-git-dir'], { cwd });
    if (gd.status !== 0) return false;
    const file = join(String(gd.stdout).trim(), LEASE_FILENAME);
    if (!existsSync(file)) return false;
    const next = renewedLease(JSON.parse(readFileSync(file, 'utf8')), now().toISOString());
    if (!next) return false;
    // Atomic temp+rename, the same shape as `we:scripts/lane-pool.mjs#writeLeaseAtomic`: a plain overwrite killed
    // between its truncate and its write leaves a torn lease, which every reader treats as NO lease — making this
    // lane reclaimable mid-landing, the very incident this renewal exists to prevent.
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return true;
  } catch { return false; }
}

export function startLaneLeaseHeartbeat({
  cwd, intervalMs = 60_000, renew = renewLaneLease,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try { Promise.resolve(renew({ cwd })).catch(() => {}); } catch { /* best effort */ }
  };
  tick();
  const timer = setIntervalFn(tick, intervalMs);
  timer?.unref?.();
  return { stop() { if (!stopped) { stopped = true; clearIntervalFn(timer); } } };
}
