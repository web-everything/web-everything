/** Runner-code freshness policy; independent of dispatch synchronization. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultPoolRoot } from '../lib/lane-pool-paths.mjs';
import { isLeaseStale } from '../lib/lane-lease.mjs';
import { laneGitHardeningEnv, scrubInheritedGitEnv } from '../lib/lane-git-hardening.mjs';
import { isReadOnlyOperation } from './registry.mjs';

export const FRESHNESS_TTL = 5 * 60_000;
export const FRESHNESS_REF = 'refs/remotes/origin/main';
export const FRESHNESS_CACHE = 'operation-runner-freshness.json';
export const requiresFreshRunner = (declaration) => declaration.name === 'verify' || !isReadOnlyOperation(declaration);

/** All IO is injectable. Resolve the loaded module, never the operation's target or caller cwd. */
export function assertRunnerFreshness({ declaration, moduleUrl, zeroWrites = false }, {
  env = process.env, now = Date.now, filesystem = fs,
  // Waiting for Git alone does not wait for maintenance it detaches after a fetch.
  git = (args, cwd) => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
    cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...laneGitHardeningEnv(scrubInheritedGitEnv(env)), GIT_OPTIONAL_LOCKS: '0' },
  }),
  diagnostic = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  let root = dirname(fileURLToPath(moduleUrl));
  let head = 'unknown';
  let behind = null;
  let uncertainty = '';
  let pinnedRunner = false;
  const readGit = (args) => {
    const result = String(git(args, root)).trim();
    if (!result && args[0] !== 'fetch') throw new Error(`empty Git response: ${args.join(' ')}`);
    return result;
  };
  try {
    root = filesystem.realpathSync(readGit(['rev-parse', '--show-toplevel']));
    let lane = false;
    try {
      const pool = filesystem.realpathSync(defaultPoolRoot(root, env));
      const parts = relative(pool, root).split(sep);
      lane = parts.length === 2 && parts[0] !== '..' && parts[0] !== '' && /^lane-\d+$/.test(parts[1]);
    } catch { /* A missing pool grants no exemption. */ }
    if (lane && declaration.name === 'open-pr') {
      // Read the lease even when attached: attachment cannot bypass a recorded pin.
      pinnedRunner = true;
      const leasePath = resolve(root, readGit(['rev-parse', '--git-path', '.lane-lease']));
      const lease = JSON.parse(filesystem.readFileSync(leasePath, 'utf8'));
      if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw new Error('invalid runner lease; reacquire the lane');
      let attached = '';
      try { attached = readGit(['symbolic-ref', '--quiet', '--short', 'HEAD']); }
      catch (error) { if (error.status !== 1) throw error; }
      if (!attached || lease?.at !== undefined || lease?.branch !== undefined) {
        if (!lease || typeof lease !== 'object' || typeof lease.session !== 'string' || !lease.session
          || !Number.isFinite(Date.parse(lease.acquiredAt)) || Date.parse(lease.acquiredAt) > now()
          || (lease.renewedAt !== undefined && (!Number.isFinite(Date.parse(lease.renewedAt)) || Date.parse(lease.renewedAt) > now()))
          || (lease.ttlMinutes !== undefined && (!Number.isFinite(lease.ttlMinutes) || lease.ttlMinutes <= 0))
          || lease.reserved || isLeaseStale(lease, now())
          || typeof lease.at !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/.test(lease.at)
          || typeof lease.branch !== 'string' || !lease.branch.startsWith('lane/')) throw new Error('missing or invalid pinned runner lease; reacquire the lane');
        if (attached) throw new Error('pinned runner HEAD is attached; reacquire the lane');
        git(['check-ref-format', `refs/heads/${lease.branch}`], root);
        head = readGit(['rev-parse', '--verify', 'HEAD']);
        if (head !== lease.at) throw new Error('pinned runner lease at differs from HEAD; reacquire the lane');
        const target = `refs/remotes/origin/${lease.branch}`;
        readGit(['fetch', '--quiet', 'origin', `+refs/heads/${lease.branch}:${target}`]);
        let symbolic = false;
        try { git(['symbolic-ref', '-q', target], root); symbolic = true; }
        catch (error) { if (error.status !== 1) throw error; }
        if (symbolic) throw new Error('pinned runner tracking ref is symbolic; reacquire the lane');
        if (readGit(['rev-parse', '--verify', target]) !== lease.at) throw new Error('pinned runner branch tip moved; reacquire the lane');
      }
    }
    if (lane || env.WE_DAEMON_MANAGED_CLONE === '1') return { exempt: true };
    head = readGit(['rev-parse', '--verify', 'HEAD']);
    const remote = readGit(['remote', 'get-url', 'origin']);
    const gitDir = resolve(root, readGit(['rev-parse', '--absolute-git-dir']));
    const cachePath = join(gitDir, FRESHNESS_CACHE);
    let ref = '';
    try { ref = readGit(['rev-parse', '--verify', FRESHNESS_REF]); } catch { /* fetch may create it */ }
    let cache;
    try { cache = JSON.parse(filesystem.readFileSync(cachePath, 'utf8')); } catch { /* cache miss */ }
    const time = now();
    const valid = cache && cache.remote === remote && ref && cache.ref === ref
      && Number.isFinite(cache.time) && cache.time <= time && time - cache.time < FRESHNESS_TTL;
    if (!valid) {
      if (zeroWrites) uncertainty = 'fetch cache unavailable or expired; read-only inspection did not fetch';
      else {
        readGit(['fetch', '--quiet', 'origin', `+refs/heads/main:${FRESHNESS_REF}`]);
        ref = readGit(['rev-parse', '--verify', FRESHNESS_REF]);
        const temp = `${cachePath}.${randomUUID()}.tmp`;
        try {
          filesystem.writeFileSync(temp, JSON.stringify({ remote, ref, time: now() }));
          filesystem.renameSync(temp, cachePath);
        } finally { filesystem.rmSync(temp, { force: true }); }
      }
    }
    const count = readGit(['rev-list', '--count', `HEAD..${FRESHNESS_REF}`]);
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw new Error('malformed behind count');
    behind = Number(count);
  } catch (error) {
    uncertainty = String(error?.message ?? error).replace(/\s+/g, ' ');
  }
  if (pinnedRunner && uncertainty) throw new Error(`Refusing open-pr pinned runner: ${uncertainty}; reacquire the lane.`);
  const detail = `${declaration.name}: runner ${root}; HEAD ${head}; ${FRESHNESS_REF}: `
    + (behind === null ? 'unknown count' : `${behind} commits behind`)
    + (uncertainty ? `; freshness uncertain: ${uncertainty}` : '');
  if (env.WE_OPERATION_ALLOW_STALE === '1') {
    diagnostic(`WE_OPERATION_ALLOW_STALE=1 override: ${detail}`);
    return { behind, uncertainty, overridden: true };
  }
  if (behind > 0 || uncertainty || behind === null) {
    if (requiresFreshRunner(declaration)) throw new Error(`Refusing ${detail}; run from a lane.`);
    diagnostic(`Warning: ${detail}; run from a lane.`);
  }
  return { behind, uncertainty };
}
