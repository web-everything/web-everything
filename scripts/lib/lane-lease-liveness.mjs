import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { readLiveCwds, pidsWithCwdIn } from './lane-salvage.mjs';
import { laneGitConfigArgs, laneGitHardeningEnv, scrubGitRepoEnv, LANE_CONFIG_LIST_ARGS, laneFilterDrivers } from './lane-git-hardening.mjs';
import { record } from './proc-identity.mjs';
import { wellFormedConfigList, wellFormedStageList } from './health-watch-lane-scan.mjs';

// Boot UUID stays stable across DHCP hostname changes. Failure leaves legacy
// hostname-only evidence in place; a foreign or unreadable host still refuses.
export function laneHostBootId() {
  return record(process.pid).identity?.bootId ?? null;
}

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
export function holderPidAlive(lease, { kill = process.kill, host = hostname(), bootId } = {}) {
  if (lease?.host && lease.host !== host) {
    const currentBoot = bootId === undefined && lease.hostBootId ? laneHostBootId() : bootId;
    if (typeof lease.hostBootId !== 'string' || !lease.hostBootId || typeof currentBoot !== 'string'
        || lease.hostBootId.toLowerCase() !== currentBoot.toLowerCase()) return null;
  }
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
  const status = probeLaneStatus(dir, { run });
  return laneReclaimDecision({ pidAlive, dirty: status === null ? null : status.length > 0 });
}

// Shared with the reaper's earlier branch corroboration, which also runs before scrub.
export function probeLaneStatus(dir, { run = spawnSync } = {}) {
  try {
    const options = {
      cwd: dir, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env: laneGitHardeningEnv({ ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' }),
    };
    // Status applies clean/process filters even with the hardening pins. Read config
    // (including local/worktree includes) without executing drivers, then refuse
    // lane-defined commands before touching worktree content. Dry-run stays read-only.
    const config = run('git', [...laneGitConfigArgs(), ...LANE_CONFIG_LIST_ARGS], options);
    if (config.error || config.status !== 0 || typeof config.stdout !== 'string'
        || !wellFormedConfigList(config.stdout) || laneFilterDrivers(config.stdout).length > 0) return null;
    // Status recurses into submodules whose config was not covered by the read
    // above. Refuse gitlinks until their work can be inspected separately.
    const staged = run('git', [...laneGitConfigArgs(), 'ls-files', '--stage', '-z'], options);
    if (staged.error || staged.status !== 0 || typeof staged.stdout !== 'string'
        || !wellFormedStageList(staged.stdout)
        || staged.stdout.split('\0').some(entry => entry.startsWith('160000 '))) return null;
    const result = run('git', [...laneGitConfigArgs(), 'status', '--porcelain', '--untracked-files=all'], options);
    if (!result.error && result.status === 0 && typeof result.stdout === 'string') return result.stdout;
  } catch { /* unreadable evidence refuses; repair the git probe before retrying */ }
  return null;
}
