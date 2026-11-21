/** Runner-code freshness policy; independent of dispatch synchronization. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultPoolRoot } from '../lib/lane-pool-paths.mjs';
import { isLeaseStale } from '../lib/lane-lease.mjs';
import { laneGitHardeningEnv, scrubInheritedGitEnv, scrubRiskyLaneConfig, SAFE_REMOTE_URL_RE } from '../lib/lane-git-hardening.mjs';
import { isReadOnlyOperation } from './registry.mjs';

export const FRESHNESS_TTL = 5 * 60_000;
export const FRESHNESS_REF = 'refs/remotes/origin/main';
export const FRESHNESS_CACHE = 'operation-runner-freshness.json';
export const requiresFreshRunner = (declaration) => declaration.name === 'verify' || !isReadOnlyOperation(declaration);

/** All IO is injectable. Resolve the loaded module, never the operation's target or caller cwd. */
export function assertRunnerFreshness({ declaration, moduleUrl, zeroWrites = false }, {
  env = process.env, now = Date.now, filesystem = fs,
  // Waiting for Git alone does not wait for maintenance it detaches after a fetch.
  // `protocol.ext.allow=never` beats a lane-set `always` for an `ext::` URL or `remote.origin.vcs=ext`.
  git = (args, cwd, { credentialPins = true } = {}) => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.ext.allow=never', ...args], {
    cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...laneGitHardeningEnv(scrubInheritedGitEnv(env), { credentialPins }), GIT_OPTIONAL_LOCKS: '0' },
  }),
  // The lane-pool transport cleanup: removes lane-set url.*.insteadOf, includes, helpers and non-origin remotes.
  scrubConfig = (dir) => scrubRiskyLaneConfig(dir),
  diagnostic = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  let root = dirname(fileURLToPath(moduleUrl));
  let head = 'unknown';
  let behind = null;
  let uncertainty = '';
  let pinnedRunner = false;
  // Keep credentials disabled during discovery. Only a resolved non-lane checkout
  // may use the operator's credential helper for its freshness fetch.
  let credentialPins = true;
  const readGit = (args) => {
    const result = String(git(args, root, { credentialPins })).trim();
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
    credentialPins = lane;
    if (lane && declaration.name === 'open-pr') {
      // Unreadable detached evidence must fail closed, but ordinary attached lanes
      // retain their exemption without requiring a lease.
      pinnedRunner = true;
      let attached = '';
      try { attached = readGit(['symbolic-ref', '--quiet', '--short', 'HEAD']); }
      catch (error) { if (error.status !== 1) throw error; }
      let lease;
      try {
        const leasePath = resolve(root, readGit(['rev-parse', '--git-path', '.lane-lease']));
        lease = JSON.parse(filesystem.readFileSync(leasePath, 'utf8'));
        if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw new Error('invalid runner lease; reacquire the lane');
      } catch (error) {
        if (attached) return { exempt: true };
        throw error;
      }
      // Attachment must not bypass a recorded pin; detachment alone is not a pin.
      if (lease.at !== undefined || lease.branch !== undefined) {
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
        // Same transport hardening as lane-pool's own fetches: scrub lane-owned transport config first, and
        // name the upload-pack on the command line because a lane-set remote.origin.uploadpack beats any -c.
        const { kept = [] } = scrubConfig(root) ?? {};
        // Origin keys the scrub keeps: upload-pack is overridden below; push keys never reach a fetch.
        // A kept vcs/proxy (or any failed removal) could still redirect the fetch, so it refuses.
        // The scrub also keeps an origin URL outside https/ssh (a local-path or file:// pool). Allow only those
        // known transports, judged on EVERY value in EVERY scope: any other `<scheme>://` or `<helper>::`
        // runs a remote helper, and a worktree-scope value can reset the local list.
        const originUrlSafe = () => String(git(['config', '--get-all', 'remote.origin.url'], root, { credentialPins }))
          .split('\n').filter(Boolean).every(url => SAFE_REMOTE_URL_RE.test(url) || /^(\/|file:\/\/)/i.test(url));
        const unsafe = kept.filter(key => !/^remote\.origin\.(uploadpack|receivepack|pushurl)$/i.test(key)
          && !(/^remote\.origin\.url$/i.test(key) && originUrlSafe()));
        if (unsafe.length) throw new Error(`lane transport config could not be scrubbed (${unsafe.length} key(s)); reacquire the lane`);
        readGit(['fetch', '--upload-pack=git-upload-pack', '--quiet', 'origin', `+refs/heads/${lease.branch}:${target}`]);
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
