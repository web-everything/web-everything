/**
 * @file scripts/conveyor/pool-exhaustion.mjs
 * @description Say WHY the lane pool is exhausted, once per episode, instead of a dispatcher silently
 *   deferring work tick after tick ("review owed, but no acquirable lane this tick" — 2026-09-27, reviews for
 *   #2768 #2770 #2772 #2778 #2779 blocked with zero acquirable lanes in a 90-lane pool).
 *
 *   The one line names the breakdown an operator needs to act: how many lanes are leased (and how many of
 *   those leases belong to a holder that is no longer a live `claude agents` session or is TTL-stale), how
 *   many are unleased but dirty, and how many are unleased and clean-but-behind/unavailable.
 *
 * PURE CORE: {@link summarizePoolExhaustion}, {@link formatPoolExhaustion}. IO: {@link makePoolExhaustionLogger}.
 */
import { cachedClaudeAgents } from '../lib/claude-agents-cache.mjs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLeaseStale } from '../lib/lane-lease.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DONE = new Set(['done', 'failed', 'stopped', 'completed', 'killed']);

/**
 * PURE. `lanes` is `lane-pool.mjs status --json`'s `lanes`; `agents` is `claude agents --json` (or `null` when
 * unreadable — then dead-holder counting reports `null`, never a guess).
 */
export function summarizePoolExhaustion({ lanes = [], agents = null, nowMs, ttlMs } = {}) {
  const existing = lanes.filter((l) => l && l.exists !== false);
  const live = agents ? new Set(agents.filter((a) => a && !DONE.has(a.state)).map((a) => a.sessionId).filter(Boolean)) : null;
  const liveCwds = agents ? agents.filter((a) => a && !DONE.has(a.state) && a.cwd).map((a) => String(a.cwd)) : [];
  let leased = 0; let leasedStale = 0; let leasedDeadHolder = 0; let dirtyUnleased = 0; let cleanUnleased = 0;
  for (const l of existing) {
    if (l.leased || l.lease) {
      leased++;
      const lease = l.lease || {};
      if (isLeaseStale(lease, nowMs, ttlMs)) { leasedStale++; continue; }
      if (live) {
        const ids = [lease.ownerSession, lease.workerSession].filter(Boolean);
        const inLane = liveCwds.some((c) => c === l.path || c.startsWith(`${l.path}/`));
        if (!inLane && ids.length && !ids.some((id) => live.has(id))) leasedDeadHolder++;
      }
    } else if (l.clean === false) dirtyUnleased++;
    else cleanUnleased++;
  }
  return { total: existing.length, leased, leasedStale, leasedDeadHolder: live ? leasedDeadHolder : null, dirtyUnleased, cleanUnleased };
}

/** PURE: the one log line. */
export function formatPoolExhaustion(repo, s, deferred) {
  const dead = s.leasedDeadHolder === null ? '? (claude agents unreadable)' : String(s.leasedDeadHolder);
  return `pool exhausted: ${repo} — 0 acquirable of ${s.total}; ${s.leased} leased (${dead} by dead holders, ${s.leasedStale} TTL-stale), ` +
    `${s.dirtyUnleased} dirty unleased, ${s.cleanUnleased} clean unleased; deferring ${deferred} dispatch(es) until lanes free up ` +
    '(reclaim: lane-pool-health-watch salvage-then-reclaim; lease-reaper for dead holders)';
}

/**
 * IO: a stateful logger — logs {@link formatPoolExhaustion} ONCE when a repo's pool first reads exhausted,
 * stays quiet while it stays exhausted, and re-arms once `recovered(repo)` is called.
 */
export function makePoolExhaustionLogger({
  log = (line) => process.stderr.write(`${line}\n`),
  readStatus = defaultReadStatus, readAgents = defaultReadAgents, nowMs = () => Date.now(), ttlMs = 4 * 60 * 60 * 1000,
} = {}) {
  const exhausted = new Set();
  return {
    exhausted({ repo, lanePoolRepo = null, deferred = 0 }) {
      if (exhausted.has(repo)) return false;
      exhausted.add(repo);
      let line;
      try {
        const status = readStatus({ lanePoolRepo });
        line = formatPoolExhaustion(repo, summarizePoolExhaustion({ lanes: status?.lanes ?? [], agents: readAgents(), nowMs: nowMs(), ttlMs }), deferred);
      } catch (e) {
        line = `pool exhausted: ${repo} — 0 acquirable; deferring ${deferred} dispatch(es) (breakdown unavailable: ${String(e?.message || e).split('\n')[0]})`;
      }
      log(line);
      return true;
    },
    recovered(repo) { exhausted.delete(repo); },
  };
}

function defaultReadStatus({ lanePoolRepo = null } = {}) {
  const argv = [join(REPO_ROOT, 'scripts', 'lane-pool.mjs'), 'status', '--json'];
  if (lanePoolRepo) argv.push(`--repo=${lanePoolRepo}`);
  return JSON.parse(execFileSync('node', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 120_000, killSignal: 'SIGKILL' }));
}

function defaultReadAgents() {
  try {
    const parsed = JSON.parse(cachedClaudeAgents({ fetch: () => execFileSync('claude', ['agents', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }) }));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
