#!/usr/bin/env node
/**
 * @file lane-git-diet.mjs
 * @description One-time, idempotent cleanup of bloated lane `.git` dirs (see `./lib/lane-git-diet.mjs` for why; rules in `./lib/lane-git-diet-cleanup.mjs`).
 *
 *   node scripts/lane-git-diet.mjs                      # DRY RUN over every lane in the web-everything pool
 *   node scripts/lane-git-diet.mjs --apply --lanes=5,7  # act on those lanes only (an explicit list is required)
 *   flags: --pool=<web-everything|frontierui|plateau-app>  --pool-root=<dir>  --scan-root=<dir>  --json
 *          --gc-timeout-ms=N  --prune-expire=<git date, default 1.hour.ago>
 *
 * Eligibility (`cleanupEligibility`): a real, non-symlinked `<pool>/lane-N` with its own `.git` dir, NO lease
 * marker, no git lock file, no other repository borrowing its objects (alternates under --scan-root/* and the pool
 * root), and no `gc.recentObjectsHook`. Per eligible lane, on --apply:
 *   0. CLAIM the lane: write its lease marker with O_EXCL (the same move as `lane-pool trim`), so a concurrent
 *      acquirer sees a live lease and moves on, and we never act on a lane someone else just took;
 *   1. apply the diet config (negative `^refs/heads/ops/*` refspec + unpackLimit=1);
 *   2. delete the stale `refs/remotes/origin/ops/*` tracking refs (readers re-fetch them explicitly by name);
 *   3. `git gc --prune=<1.hour.ago>` with reflog expiry and worktree pruning OFF: only objects unreachable from every
 *      ref, reflog, index and HEAD, and older than the grace window, are dropped (the old ledger blobs);
 *   4. drop the claim marker (only if it is still ours).
 * Never `reset`, `clean` or `checkout`; never a working-tree write. Never the primary checkout, `~/workspace/wev-*`,
 * or `.lanes/we-drain-daemon`. Git runs with GIT_DIR-style overrides scrubbed and the lane hardening pins applied.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LEASE_FILENAME } from './lib/lane-lease.mjs';
import { laneGitHardeningEnv } from './lib/lane-git-hardening.mjs';
import { applyLaneDietConfig } from './lib/lane-git-diet.mjs';
import {
  cleanupEligibility, CLEANUP_POOLS, formatBytes, parseCountObjects, projectedFreedBytes,
} from './lib/lane-git-diet-cleanup.mjs';

const flags = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) { process.stderr.write(`unexpected argument: ${a}\n`); process.exit(2); }
  return [m[1], m[2] ?? true];
}));
const KNOWN = new Set(['apply', 'lanes', 'pool', 'pool-root', 'scan-root', 'json', 'gc-timeout-ms', 'prune-expire']);
const unknown = Object.keys(flags).filter((f) => !KNOWN.has(f));
if (unknown.length) { process.stderr.write(`unknown flag(s): ${unknown.map((f) => `--${f}`).join(', ')}\n`); process.exit(2); }

const APPLY = flags.apply === true;
const POOL = typeof flags.pool === 'string' ? flags.pool : 'web-everything';
if (!CLEANUP_POOLS.includes(POOL)) { process.stderr.write(`--pool must be one of ${CLEANUP_POOLS.join(', ')}\n`); process.exit(2); }
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const POOL_ROOT = real(typeof flags['pool-root'] === 'string' ? flags['pool-root'] : join(homedir(), 'workspace', '.lanes'));
const SCAN_ROOT = real(typeof flags['scan-root'] === 'string' ? flags['scan-root'] : join(homedir(), 'workspace'));
if (!POOL_ROOT || !SCAN_ROOT) { process.stderr.write('pool root / scan root does not exist\n'); process.exit(2); }
const GC_TIMEOUT_MS = Number(flags['gc-timeout-ms']) || 900_000;
const PRUNE_EXPIRE = typeof flags['prune-expire'] === 'string' ? flags['prune-expire'] : '1.hour.ago';
const ONLY = typeof flags.lanes === 'string' ? new Set(flags.lanes.split(',').map((s) => Number(s.trim())).filter(Number.isInteger)) : null;
if (APPLY && !ONLY) { process.stderr.write('--apply needs an explicit --lanes=N,M list (the full apply is the operator\'s call)\n'); process.exit(2); }

// Git env: no inherited repo redirection, plus the lane hardening pins (no fsmonitor/hooks run from lane config).
const GIT_ENV = laneGitHardeningEnv(Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/.test(k))));
const git = (dir, args, timeout = 120_000) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 * 1024 * 1024 });
const leaseFile = (dir) => join(dir, '.git', LEASE_FILENAME);
const readLease = (dir) => { try { return JSON.parse(readFileSync(leaseFile(dir), 'utf8')); } catch { return existsSync(leaseFile(dir)) ? { unreadable: true } : null; } };
const LOCK_NAMES = ['index.lock', 'HEAD.lock', 'packed-refs.lock', 'gc.pid', 'shallow.lock', 'config.lock'];
const locksIn = (dir) => LOCK_NAMES.filter((f) => existsSync(join(dir, '.git', f)));
const duBytes = (p) => { try { return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8', timeout: 300_000 }).split(/\s+/)[0]) * 1024; } catch { return NaN; } };
const opsRefs = (dir) => git(dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/ops/']).split('\n').filter(Boolean);
const gcHooks = (dir) => { try { return git(dir, ['config', '--get-all', 'gc.recentObjectsHook']).split('\n').filter(Boolean); } catch (e) { if (e.status === 1) return []; throw e; } };

// Who borrows whose objects: every `objects/info/alternates` under <scan-root>/* and <pool-root>/*/*.
function borrowerMap() {
  const map = new Map();
  const candidates = [];
  const kids = (d) => { try { return readdirSync(d).map((n) => join(d, n)); } catch { return []; } };
  candidates.push(...kids(SCAN_ROOT), ...kids(real(tmpdir()) || tmpdir()));
  for (const pool of kids(POOL_ROOT)) candidates.push(...kids(pool));
  for (const repo of candidates) {
    for (const objects of [join(repo, '.git', 'objects'), join(repo, 'objects')]) {
      let text;
      try { text = readFileSync(join(objects, 'info', 'alternates'), 'utf8'); } catch { continue; }
      for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
        const target = real(isAbsolute(line) ? line : resolve(objects, line));
        if (!target) continue;
        if (!map.has(target)) map.set(target, []);
        map.get(target).push(repo);
      }
    }
  }
  return map;
}
const BORROWERS = borrowerMap();
// Every path the cleanup writes through (config, refs, HEAD, reflogs, the lease marker) — none may be a symlink.
const GIT_WRITE_PATHS = ['config', 'config.worktree', 'packed-refs', 'refs', 'refs/remotes', 'refs/remotes/origin', 'refs/remotes/origin/ops', 'logs', 'logs/refs', 'logs/refs/remotes', 'logs/refs/remotes/origin', 'logs/refs/remotes/origin/ops', 'HEAD', 'objects', 'objects/pack', 'objects/info', LEASE_FILENAME];
const symlinkedGitPaths = (dir) => GIT_WRITE_PATHS.filter((p) => { try { return lstatSync(join(dir, '.git', p)).isSymbolicLink(); } catch { return false; } });
const commonDir = (dir) => { try { return real(resolve(dir, git(dir, ['rev-parse', '--git-common-dir']).trim())); } catch { return null; } };

const eligible = (dir) => {
  const realGitDir = real(join(dir, '.git'));
  const objects = realGitDir ? real(join(realGitDir, 'objects')) : null;
  return cleanupEligibility({
    dir, poolRoot: POOL_ROOT, realDir: real(dir), realGitDir, realCommonDir: realGitDir ? commonDir(dir) : undefined, realObjectsDir: objects ?? undefined, symlinkedGitPaths: symlinkedGitPaths(dir),
    lease: readLease(dir), nowMs: Date.now(), locks: locksIn(dir),
    borrowers: (objects && BORROWERS.get(objects)) || [], gcHooks: realGitDir ? gcHooks(dir) : [],
  });
};

// O_EXCL claim, same marker shape as `lane-pool` (so `acquire` reads it as a live lease and skips the lane).
function claim(dir) {
  const holder = `lane-git-diet-${process.pid}-${randomBytes(4).toString('hex')}`;
  const body = { session: holder, purpose: 'lane-git-diet', acquiredAt: new Date().toISOString(), ttlMinutes: 60, host: hostname(), pid: process.pid, ownerSession: process.env.CLAUDE_CODE_SESSION_ID || null, holder };
  try { writeFileSync(leaseFile(dir), JSON.stringify(body, null, 2) + '\n', { flag: 'wx' }); return holder; } catch { return null; }
}
function unclaim(dir, holder) {
  const lease = readLease(dir);
  if (lease && lease.holder === holder) rmSync(leaseFile(dir), { force: true });
}

const poolDir = join(POOL_ROOT, POOL);
const lanes = readdirSync(poolDir)
  .map((name) => /^lane-(\d+)$/.exec(name)).filter(Boolean).map((m) => Number(m[1]))
  .filter((n) => !ONLY || ONLY.has(n)).sort((a, b) => a - b);

const rows = [];
let total = 0;
for (const n of lanes) {
  const dir = join(poolDir, `lane-${n}`);
  if (!existsSync(join(dir, '.git')) || !statSync(join(dir, '.git')).isDirectory()) { rows.push({ lane: n, skipped: 'no .git dir' }); continue; }
  const e = eligible(dir);
  if (!e.ok) { rows.push({ lane: n, skipped: e.reason }); continue; }
  try {
    const refs = opsRefs(dir);
    const counts = parseCountObjects(git(dir, ['count-objects', '-v']));
    if (!APPLY) {
      const projected = projectedFreedBytes(counts);
      total += projected;
      rows.push({ lane: n, mode: 'dry-run', opsRefs: refs.length, loose: counts.count || 0, packs: counts.packs || 0, projectedBytes: projected });
      continue;
    }
    const holder = claim(dir);
    if (!holder) { rows.push({ lane: n, skipped: 'lost the claim race (someone took the lane)' }); continue; }
    try {
      const recheck = cleanupEligibility({ dir, poolRoot: POOL_ROOT, realDir: real(dir), realGitDir: real(join(dir, '.git')), realCommonDir: commonDir(dir), realObjectsDir: real(join(dir, '.git', 'objects')), symlinkedGitPaths: symlinkedGitPaths(dir), lease: null, nowMs: Date.now(), locks: locksIn(dir) });
      if (!recheck.ok) { rows.push({ lane: n, skipped: recheck.reason }); continue; }
      const before = duBytes(join(dir, '.git'));
      const applied = applyLaneDietConfig((args) => git(dir, args));
      const refsNow = opsRefs(dir);
      for (const ref of refsNow) git(dir, ['update-ref', '--no-deref', '-d', ref]);
      // Re-scan borrowers right before pruning: a repo that started borrowing this lane's objects since startup
      // would lose them to gc. (Lane-pool clones `--reference` the primary, never a lane, so this is the anomaly path.)
      // TEST SEAM (honoured only under vitest): simulate a borrower appearing mid-run, after the startup scan.
      if (process.env.VITEST && process.env.LANE_GIT_DIET_TEST_LATE_BORROWER) {
        const borrowerObjects = process.env.LANE_GIT_DIET_TEST_LATE_BORROWER;
        mkdirSync(join(borrowerObjects, 'info'), { recursive: true });
        writeFileSync(join(borrowerObjects, 'info', 'alternates'), `${join(dir, '.git', 'objects')}\n`);
      }
      const lateBorrowers = borrowerMap().get(real(join(dir, '.git', 'objects'))) || [];
      if (lateBorrowers.length) { rows.push({ lane: n, skipped: `objects borrowed by ${lateBorrowers.join(', ')} (config + ref cleanup done, gc skipped)` }); continue; }
      git(dir, ['-c', 'gc.autoDetach=false', '-c', 'gc.reflogExpire=never', '-c', 'gc.reflogExpireUnreachable=never', '-c', 'gc.worktreePruneExpire=never', '-c', 'gc.rerereResolved=36500', '-c', 'gc.rerereUnresolved=36500', 'gc', `--prune=${PRUNE_EXPIRE}`, '--quiet'], GC_TIMEOUT_MS);
      const after = duBytes(join(dir, '.git'));
      const freed = before - after;
      total += Number.isFinite(freed) ? freed : 0;
      rows.push({ lane: n, mode: 'apply', configOps: applied.length, opsRefsDeleted: refsNow.length, beforeBytes: before, afterBytes: after, freedBytes: freed });
    } finally {
      unclaim(dir, holder);
    }
  } catch (err) {
    rows.push({ lane: n, error: String(err?.stderr || err?.message || err).trim().split('\n').slice(-1)[0] });
  }
}

if (flags.json) {
  process.stdout.write(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', pool: POOL, totalBytes: total, rows }, null, 2) + '\n');
} else {
  for (const r of rows) {
    if (r.skipped) process.stdout.write(`lane-${r.lane}: SKIP ${r.skipped}\n`);
    else if (r.error) process.stdout.write(`lane-${r.lane}: ERROR ${r.error}\n`);
    else if (r.mode === 'dry-run') process.stdout.write(`lane-${r.lane}: ~${formatBytes(r.projectedBytes)} potentially reclaimable (${r.loose} loose objects, ${r.packs} packs, ${r.opsRefs} ops refs)\n`);
    else process.stdout.write(`lane-${r.lane}: ${formatBytes(r.beforeBytes)} -> ${formatBytes(r.afterBytes)} (freed ${formatBytes(r.freedBytes)}) [${r.configOps} config ops, ${r.opsRefsDeleted} ops refs deleted]\n`);
  }
  const counted = rows.filter((r) => !r.skipped && !r.error).length;
  process.stdout.write(`${APPLY ? 'freed' : 'projected (estimate)'}: ${formatBytes(total)} across ${counted} lane(s); skipped ${rows.filter((r) => r.skipped).length}, errors ${rows.filter((r) => r.error).length}\n`);
}
