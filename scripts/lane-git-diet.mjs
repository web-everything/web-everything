#!/usr/bin/env node
/**
 * @file lane-git-diet.mjs
 * @description One-time, idempotent cleanup of bloated lane `.git` dirs (see `./lib/lane-git-diet.mjs` for why; rules in `./lib/lane-git-diet-cleanup.mjs`).
 *
 *   node scripts/lane-git-diet.mjs                      # DRY RUN over every lane in the web-everything pool
 *   node scripts/lane-git-diet.mjs --apply --lanes=5,7  # act on those lanes only (an explicit list is required)
 *   flags: --pool=<web-everything|frontierui|plateau-app>  --pool-root=<dir>  --scan-root=<dir>  --json
 *          --extra-scan-roots=<dir>[:<dir>...]  --gc-timeout-ms=N  --prune-expire=<git date, default 1.hour.ago>
 *
 * Eligibility (`cleanupEligibility`): a real, non-symlinked `<pool>/lane-N` with its own `.git` dir, NO lease
 * marker, no git lock file anywhere under `.git` (`*.lock`, gc.pid), no other repository borrowing its objects (alternates under --scan-root/*,
 * each --extra-scan-roots/*, the temp dir and the pool root, following alternate chains; the report lists the roots scanned), no `gc.recentObjectsHook` or config-defined `hook.*` (neither obeys the
 * core.hooksPath pin), a common dir that is exactly the lane's own `.git`, a plain ref store (no `<format>://<path>`
 * `extensions.refStorage`; inherited GIT_REFERENCE_BACKEND is scrubbed), no GC repack filtering, and no per-ref
 * `gc.<pattern>.reflogExpire[Unreachable]`. Per eligible lane, on --apply:
 *   0. CLAIM the lane: write its lease marker with O_EXCL (the same move as `lane-pool trim`), so a concurrent
 *      acquirer sees a live lease and moves on, and we never act on a lane someone else just took; before any write
 *      the marker is re-read (still ours?) and every eligibility input is re-checked;
 *   1. apply the diet config (negative `^refs/heads/ops/*` refspec + unpackLimit=1);
 *   2. delete the stale `refs/remotes/origin/ops/*` tracking refs (readers re-fetch them explicitly by name);
 *   3. `git repack -A -d -l --unpack-unreachable=never` (no cruft pack), a re-check of the claim and
 *      every input, then `git prune --expire=<1.hour.ago>`: only objects unreachable from every ref, reflog, index
 *      and HEAD, and older than the grace window, are dropped (the old ledger blobs);
 *   4. drop the claim marker (only if it is still ours).
 * Never `reset`, `clean` or `checkout`; never a working-tree write. Never the primary checkout, `~/workspace/wev-*`,
 * or `.lanes/we-drain-daemon`. Git runs with inherited GIT_DIR-style and GIT_CONFIG* overrides scrubbed
 * (`scrubGitRepoEnv`) and the lane hardening pins applied.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LEASE_FILENAME } from './lib/lane-lease.mjs';
import { laneGitHardeningEnv, scrubGitRepoEnv } from './lib/lane-git-hardening.mjs';
import { applyLaneDietConfig } from './lib/lane-git-diet.mjs';
import {
  cleanupEligibility, CLEANUP_POOLS, formatBytes, parseCountObjects, parseGitAlternates, projectedFreedBytes,
} from './lib/lane-git-diet-cleanup.mjs';

const flags = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) { process.stderr.write(`unexpected argument: ${a}\n`); process.exit(2); }
  // A repeated flag would silently drop all but its last value (e.g. one of two --extra-scan-roots): refuse it.
  if (Object.hasOwn(flags, m[1])) { process.stderr.write(`--${m[1]} given more than once\n`); process.exit(2); }
  flags[m[1]] = m[2] ?? true;
}
const KNOWN = new Set(['apply', 'lanes', 'pool', 'pool-root', 'scan-root', 'extra-scan-roots', 'json', 'gc-timeout-ms', 'prune-expire']);
const unknown = Object.keys(flags).filter((f) => !KNOWN.has(f));
if (unknown.length) { process.stderr.write(`unknown flag(s): ${unknown.map((f) => `--${f}`).join(', ')}\n`); process.exit(2); }

const APPLY = flags.apply === true;
const POOL = typeof flags.pool === 'string' ? flags.pool : 'web-everything';
if (!CLEANUP_POOLS.includes(POOL)) { process.stderr.write(`--pool must be one of ${CLEANUP_POOLS.join(', ')}\n`); process.exit(2); }
const real = (p) => { try { return realpathSync(p); } catch (err) { if (['ENOENT', 'ENOTDIR'].includes(err.code)) return null; throw err; } };
const POOL_ROOT = real(typeof flags['pool-root'] === 'string' ? flags['pool-root'] : join(homedir(), 'workspace', '.lanes'));
const SCAN_ROOT = real(typeof flags['scan-root'] === 'string' ? flags['scan-root'] : join(homedir(), 'workspace'));
if (!POOL_ROOT || !SCAN_ROOT) { process.stderr.write('pool root / scan root does not exist\n'); process.exit(2); }
// Git records no back-pointer from a store to the repos borrowing it, so a borrower outside every scanned root is
// invisible: the operator names any other place such clones live (`:`-separated; each root AND its children are
// scanned), and the report lists every root. A bare or empty value is refused, never read as "no extra roots".
const extraFlag = flags['extra-scan-roots'];
const extraParts = extraFlag === undefined ? [] : typeof extraFlag === 'string' ? extraFlag.split(delimiter) : [''];
if (extraParts.some((p) => !p)) { process.stderr.write('--extra-scan-roots needs non-empty directory paths\n'); process.exit(2); }
const EXTRA_SCAN_ROOTS = extraParts.map((p) => {
  const r = real(p);
  if (!r) { process.stderr.write(`extra scan root ${p} does not exist\n`); process.exit(2); }
  return r;
});
const poolDir = join(POOL_ROOT, POOL);
let poolEntries = null;
try { poolEntries = readdirSync(poolDir); } catch { /* absent, not a directory or unlistable: refused below */ }
if (!poolEntries) { process.stderr.write(`pool directory ${poolDir} does not exist or is not a readable directory\n`); process.exit(2); }
const GC_TIMEOUT_MS = Number(flags['gc-timeout-ms']) || 900_000;
const PRUNE_EXPIRE = typeof flags['prune-expire'] === 'string' ? flags['prune-expire'] : '1.hour.ago';
const ONLY = typeof flags.lanes === 'string' ? new Set(flags.lanes.split(',').map((s) => Number(s.trim())).filter(Number.isInteger)) : null;
if (APPLY && !ONLY) { process.stderr.write('--apply needs an explicit --lanes=N,M list (the full apply is the operator\'s call)\n'); process.exit(2); }

// Git env: no inherited repo redirection or env-injected config, plus the lane hardening pins (no fsmonitor/hooks run from lane config).
const GIT_ENV = laneGitHardeningEnv(scrubGitRepoEnv(process.env));
const git = (dir, args, timeout = 120_000, encoding = 'utf8') => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding, stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 * 1024 * 1024 });
const leaseFile = (dir) => join(dir, '.git', LEASE_FILENAME);
const readLease = (dir) => { try { return JSON.parse(readFileSync(leaseFile(dir), 'utf8')); } catch { return existsSync(leaseFile(dir)) ? { unreadable: true } : null; } };
const duBytes = (p) => { try { return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8', timeout: 300_000 }).split(/\s+/)[0]) * 1024; } catch { return NaN; } };
const opsRefs = (dir) => git(dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/ops/']).split('\n').filter(Boolean);
const gcHooks = (dir) => { try { return git(dir, ['config', '--get-all', 'gc.recentObjectsHook']).split('\n').filter(Boolean); } catch (e) { if (e.status === 1) return []; throw e; } };
const gcRepackFilters = (dir) => { try { return git(dir, ['config', '--name-only', '--get-regexp', '^gc\\.repackfilter(to)?$']).split('\n').filter(Boolean); } catch (e) { if (e.status === 1) return []; throw e; } };
// Keep the conservative GC eligibility checks, even though repack itself performs no expiry.
const gcReflogPatterns = (dir) => { try { return git(dir, ['config', '--name-only', '--get-regexp', '^gc\\..*\\.reflogexpire(unreachable)?$']).split('\n').filter(Boolean); } catch (e) { if (e.status === 1) return []; throw e; } };
// `hook.<name>.command` runs on its `hook.<name>.event` (e.g. reference-transaction on update-ref) whatever core.hooksPath says.
const configHooks = (dir) => { try { return git(dir, ['config', '--name-only', '--get-regexp', '^hook\\.']).split('\n').filter(Boolean); } catch (e) { if (e.status === 1) return []; throw e; } };
// `extensions.refStorage=<format>://<path>` keeps the refs in another repo: update-ref, gc and prune would act there.
const refStorage = (dir) => { try { return git(dir, ['config', '--get-all', 'extensions.refstorage']).split('\n').filter(Boolean); } catch (e) { if (e.status === 1) return []; throw e; } };
// A path git prints, byte-exact: whitespace is a legal path byte, so only the one trailing newline is git's.
const gitPath = (dir, args) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(git(dir, args, 120_000, null)).replace(/\n$/, '');

// Who borrows whose objects: repos under <scan-root>/*, each extra root and its children, <tmpdir>/* and
// <pool-root>/*/*, including Gitfile/common-dir stores.
const CHILD_ROOTS = [...new Set([SCAN_ROOT, ...EXTRA_SCAN_ROOTS, real(tmpdir()) || tmpdir()])];
const SCANNED = [...EXTRA_SCAN_ROOTS, ...CHILD_ROOTS.map((r) => join(r, '*')), join(POOL_ROOT, '*', '*')];
function borrowerMap() {
  const map = new Map();
  const candidates = [...EXTRA_SCAN_ROOTS];
  const kids = (d) => { try { return readdirSync(d).map((n) => join(d, n)); } catch (err) { if (['ENOENT', 'ENOTDIR'].includes(err.code)) return []; throw err; } };
  for (const r of CHILD_ROOTS) candidates.push(...kids(r));
  for (const pool of kids(POOL_ROOT)) candidates.push(...kids(pool));
  for (const repo of candidates) {
    const stores = [join(repo, '.git', 'objects'), join(repo, 'objects')];
    let dotGit;
    try { dotGit = statSync(join(repo, '.git')); } catch (err) { if (!['ENOENT', 'ENOTDIR'].includes(err.code)) throw err; }
    if (dotGit?.isFile() || existsSync(join(repo, '.git', 'commondir')) || existsSync(join(repo, 'commondir'))) {
      // Git resolves relative Gitfiles and linked-worktree commondir paths. Keep literal path whitespace;
      // a failed resolution must abort the scan, never silently authorize pruning an unknown object store.
      stores.push(gitPath(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']));
    }
    // A store outside the candidate roots can itself borrow from a lane. Walk the whole graph per
    // borrower, canonicalizing every hop so aliases/cycles terminate without losing that borrower's identity.
    const pending = new Set(stores.map(real).filter(Boolean));
    for (const objects of pending) {
      if (pending.size > 10_000) throw new Error('alternate graph too large; cleanup refused');
      let text;
      try { text = readFileSync(join(objects, 'info', 'alternates')); } catch (err) { if (['ENOENT', 'ENOTDIR'].includes(err.code)) continue; throw err; }
      for (const line of parseGitAlternates(text)) {
        const target = real(isAbsolute(line) ? line : resolve(objects, line));
        if (!target) continue;
        if (!map.has(target)) map.set(target, []);
        if (!map.get(target).includes(repo)) map.get(target).push(repo);
        pending.add(target);
      }
    }
  }
  return map;
}
const BORROWERS = borrowerMap();
// Audit the whole Git directory: GC's write paths extend beyond config, refs, logs and objects, and any `*.lock`
// anywhere (e.g. a prepared update-ref transaction's refs/heads/<name>.lock) or gc.pid means an op is mid-flight.
// So does an unfinished merge/rebase/cherry-pick/bisect/notes merge: gc does not keep the commits these pseudorefs name.
const IN_FLIGHT = new Set(['gc.pid', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'AUTO_MERGE', 'BISECT_HEAD', 'BISECT_START', 'rebase-merge', 'rebase-apply', 'sequencer', 'NOTES_MERGE_PARTIAL', 'NOTES_MERGE_REF', 'NOTES_MERGE_WORKTREE']);
const auditGitDir = (dir) => {
  const links = [];
  const locks = [];
  const visit = (path) => {
    let entry;
    try { entry = lstatSync(join(dir, '.git', path)); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
    if (entry.isSymbolicLink()) { links.push(path); return; } // Never traverse even a dangling link.
    if (path.endsWith('.lock') || IN_FLIGHT.has(basename(path))) locks.push(path); // basename: linked worktrees too.
    if (!entry.isDirectory()) return;
    let names;
    // Git removes empty loose-ref and fan-out dirs as it works: a dir gone since its lstat is simply skipped.
    try { names = readdirSync(join(dir, '.git', path)); } catch (err) { if (['ENOENT', 'ENOTDIR'].includes(err.code)) return; throw err; }
    for (const name of names) visit(join(path, name));
  };
  visit('');
  return { symlinkedGitPaths: links, locks };
};
// Never trimmed: a common dir `<lane>/.git ` must not read as the lane's own `.git`. Unreadable → null → refused.
const commonDir = (dir) => { try { return real(gitPath(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])); } catch { return null; } };

const eligible = (dir) => {
  const realGitDir = real(join(dir, '.git'));
  const objects = realGitDir ? real(join(realGitDir, 'objects')) : null;
  return cleanupEligibility({
    dir, poolRoot: POOL_ROOT, realDir: real(dir), realGitDir, realCommonDir: realGitDir ? commonDir(dir) : undefined, realObjectsDir: objects ?? undefined, ...auditGitDir(dir),
    lease: readLease(dir), nowMs: Date.now(),
    borrowers: (objects && BORROWERS.get(objects)) || [], gcHooks: realGitDir ? gcHooks(dir) : [], gcRepackFilters: realGitDir ? gcRepackFilters(dir) : [],
    gcReflogPatterns: realGitDir ? gcReflogPatterns(dir) : [], configHooks: realGitDir ? configHooks(dir) : [],
    refStorage: realGitDir ? refStorage(dir) : [],
  });
};
// Every eligibility input re-read while we hold the claim (our own marker is the lease, so `lease: null`).
const recheckUnderClaim = (dir) => cleanupEligibility({ dir, poolRoot: POOL_ROOT, realDir: real(dir), realGitDir: real(join(dir, '.git')), realCommonDir: commonDir(dir), realObjectsDir: real(join(dir, '.git', 'objects')), ...auditGitDir(dir), lease: null, nowMs: Date.now(), gcHooks: gcHooks(dir), gcRepackFilters: gcRepackFilters(dir), gcReflogPatterns: gcReflogPatterns(dir), configHooks: configHooks(dir), refStorage: refStorage(dir) });

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
// TEST SEAM (honoured only under vitest): pause at one stage until the test signals, so it can change the lane
// inside a window the startup checks cannot see. The seam itself writes nothing into the lane.
const testPause = (stage) => {
  const at = process.env.VITEST && process.env.LANE_GIT_DIET_TEST_PAUSE_AT;
  const signals = process.env.LANE_GIT_DIET_TEST_PAUSE_DIR;
  if (at !== stage || !signals) return;
  writeFileSync(join(signals, 'ready'), '');
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(signals, 'go'))) {
    if (Date.now() > deadline) throw new Error(`test pause at ${stage} timed out`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
};

const lanes = poolEntries
  .map((name) => /^lane-(\d+)$/.exec(name)).filter(Boolean).map((m) => Number(m[1]))
  .filter((n) => !ONLY || ONLY.has(n)).sort((a, b) => a - b);

const rows = [];
let total = 0;
for (const n of lanes) {
  const dir = join(poolDir, `lane-${n}`);
  // The eligibility reads are inside the try: one unreadable lane (e.g. a corrupt config, git exit 128) is refused
  // as its own error row, never a crash that drops the report for lanes already changed and skips the rest.
  try {
    if (!existsSync(join(dir, '.git')) || !statSync(join(dir, '.git')).isDirectory()) { rows.push({ lane: n, skipped: 'no .git dir' }); continue; }
    const e = eligible(dir);
    if (!e.ok) { rows.push({ lane: n, skipped: e.reason }); continue; }
    const refs = opsRefs(dir);
    const counts = parseCountObjects(git(dir, ['count-objects', '-v']));
    if (!APPLY) {
      const projected = projectedFreedBytes(counts);
      total += projected;
      rows.push({ lane: n, mode: 'dry-run', opsRefs: refs.length, loose: counts.count || 0, packs: counts.packs || 0, projectedBytes: projected });
      continue;
    }
    testPause('before-claim');
    const holder = claim(dir);
    if (!holder) { rows.push({ lane: n, skipped: 'lost the claim race (someone took the lane)' }); continue; }
    try {
      testPause('after-claim');
      // Re-read ownership before any write: a marker rewritten or removed by another holder means the claim is lost.
      if (readLease(dir)?.holder !== holder) { rows.push({ lane: n, skipped: 'claim lost (lease marker is no longer ours)' }); continue; }
      const recheck = recheckUnderClaim(dir);
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
        const alternate = join(dir, '.git', 'objects');
        writeFileSync(join(borrowerObjects, 'info', 'alternates'), `${process.env.LANE_GIT_DIET_TEST_QUOTED_ALTERNATE ? JSON.stringify(alternate) : alternate}\n`);
      }
      const lateBorrowers = borrowerMap().get(real(join(dir, '.git', 'objects'))) || [];
      if (lateBorrowers.length) { rows.push({ lane: n, skipped: `objects borrowed by ${lateBorrowers.join(', ')} (config + ref cleanup done, gc skipped)` }); continue; }
      // Re-audit right before pruning too: a ref transaction prepared since the recheck holds a `*.lock` naming
      // objects gc would otherwise drop.
      testPause('before-gc');
      const late = recheckUnderClaim(dir);
      if (!late.ok) { rows.push({ lane: n, skipped: `${late.reason} (config + ref cleanup done, gc skipped)` }); continue; }
      // Two steps, so the walk that decides what to delete starts seconds after the last audit, not after a long
      // repack: unreachable objects stay or become loose (no cruft pack, which `git prune` cannot expire), then the
      // claim and every input are re-checked, then `git prune` drops only old loose objects
      // unreachable from every ref, reflog, index and HEAD. A ref transaction prepared during the repack holds a
      // `*.lock` that check sees. Git has no lock against gc, so prune's own short walk is the remaining window.
      // Call only gc's repack step: even `worktree prune --expire never` can remove an offline worktree with no
      // index, destroying its HEAD-only reachability root. Repack expires neither worktree metadata nor reflogs.
      git(dir, ['repack', '-A', '-d', '-l', '--unpack-unreachable=never', '--quiet'], GC_TIMEOUT_MS);
      testPause('before-prune');
      if (readLease(dir)?.holder !== holder) { rows.push({ lane: n, skipped: 'claim lost (lease marker is no longer ours) (repack done, prune skipped)' }); continue; }
      const final = recheckUnderClaim(dir);
      if (!final.ok) { rows.push({ lane: n, skipped: `${final.reason} (repack done, prune skipped)` }); continue; }
      const finalBorrowers = borrowerMap().get(real(join(dir, '.git', 'objects'))) || [];
      if (finalBorrowers.length) { rows.push({ lane: n, skipped: `objects borrowed by ${finalBorrowers.join(', ')} (repack done, prune skipped)` }); continue; }
      git(dir, ['prune', `--expire=${PRUNE_EXPIRE}`], GC_TIMEOUT_MS);
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
  process.stdout.write(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', pool: POOL, scannedRoots: SCANNED, totalBytes: total, rows }, null, 2) + '\n');
} else {
  process.stdout.write(`borrower scan: ${SCANNED.join(', ')} (a borrower elsewhere is not seen: add --extra-scan-roots)\n`);
  for (const r of rows) {
    if (r.skipped) process.stdout.write(`lane-${r.lane}: SKIP ${r.skipped}\n`);
    else if (r.error) process.stdout.write(`lane-${r.lane}: ERROR ${r.error}\n`);
    else if (r.mode === 'dry-run') process.stdout.write(`lane-${r.lane}: ~${formatBytes(r.projectedBytes)} potentially reclaimable (${r.loose} loose objects, ${r.packs} packs, ${r.opsRefs} ops refs)\n`);
    else process.stdout.write(`lane-${r.lane}: ${formatBytes(r.beforeBytes)} -> ${formatBytes(r.afterBytes)} (freed ${formatBytes(r.freedBytes)}) [${r.configOps} config ops, ${r.opsRefsDeleted} ops refs deleted]\n`);
  }
  const counted = rows.filter((r) => !r.skipped && !r.error).length;
  process.stdout.write(`${APPLY ? 'freed' : 'projected (estimate)'}: ${formatBytes(total)} across ${counted} lane(s); skipped ${rows.filter((r) => r.skipped).length}, errors ${rows.filter((r) => r.error).length}\n`);
}
