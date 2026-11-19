import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { readLiveCwds, pidsWithCwdIn } from './lane-salvage.mjs';
import { laneGitConfigArgs, laneGitHardeningEnv, scrubGitLocationEnv } from './lane-git-hardening.mjs';

export function journalLiveProcessRefusal(dir, livePids, journal) {
  if (!livePids?.length) return false;
  journal(dir, { action: 'reclaim-refused-live-process', livePids,
    reason: `live process cwd inside lane (pids: ${livePids.join(', ')})` });
  return true;
}

export function staleTakeoverHasLiveProcesses(dir, { readCwds = readLiveCwds, journal = () => {} } = {}) {
  let cwds;
  try { cwds = readCwds(); } catch { cwds = null; }
  if (cwds == null) {
    journal(dir, { action: 'reclaim-refused-live-process',
      reason: 'live process cwd probe unreadable (lsof); restore the probe before retrying takeover' });
    return true;
  }
  return journalLiveProcessRefusal(dir, pidsWithCwdIn(cwds, dir), journal);
}

// Liveness prevents reclamation; it does not confer ownership.
export function holderPidAlive(lease, { kill = process.kill, host = hostname() } = {}) {
  if (lease?.host && lease.host !== host) return null;
  if (!Number.isSafeInteger(lease?.pid) || lease.pid <= 0) return false;
  try { kill(lease.pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : error?.code === 'EPERM' ? true : null; }
}

export function laneReclaimDecision({ pidAlive = false, dirty = null } = {}) {
  if (pidAlive !== false) return { safe: false, reason: 'stale-but-live' };
  if (dirty !== false) return { safe: false, reason: 'stale-but-dirty' };
  return { safe: true, reason: null };
}

export function probeLaneReclaim(dir, lease, { run = spawnSync, ...pidOptions } = {}) {
  const pidAlive = holderPidAlive(lease, pidOptions);
  if (pidAlive !== false) return laneReclaimDecision({ pidAlive });
  let dirty = null;
  try {
    const result = run('git', [...laneGitConfigArgs(), 'status', '--porcelain', '--untracked-files=all'], {
      cwd: dir, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env: laneGitHardeningEnv({ ...scrubGitLocationEnv(process.env), GIT_OPTIONAL_LOCKS: '0' }),
    });
    if (result.status === 0 && typeof result.stdout === 'string') dirty = result.stdout.length > 0;
  } catch { /* unreadable evidence refuses; repair the git probe before retrying */ }
  return laneReclaimDecision({ pidAlive, dirty });
}
