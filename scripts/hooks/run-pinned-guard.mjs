/**
 * Run a security guard from a trusted origin/main snapshot, never the cwd tree.
 * Usage: node run-pinned-guard.mjs scripts/<guard>.mjs [args...]
 * The settings wrapper uses Git's common dir for linked worktrees. For clone
 * lanes under <workspace>/.lanes/, it selects <workspace>/web-everything (legacy:
 * webeverything), outside the lane, and denies if that primary is unavailable.
 * Keep that primary bootstrap trusted. No fetch is performed: updating the
 * local origin/main ref refreshes the snapshot on the next invocation.
 * PostToolUse and Session* hooks remain local: they perform lifecycle/bookkeeping
 * work rather than admission decisions, and need the checkout's current tooling.
 * Operator escape: revert the relevant settings.json command to
 * `node scripts/<x>.mjs` to deliberately use the working-tree guard again.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { watch, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { acquireLockDir, releaseLockDir } from '../readiness/file-locks.mjs';

const root = resolve(process.env.WE_PINNED_HOOKS_DIR || join(homedir(), '.claude/pinned-hooks'));
const shaPattern = /^[a-f0-9]{40,64}$/;
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const hash = value => createHash('sha256').update(value).digest('hex');
const maxAgeMs = 24 * 60 * 60 * 1000;

// Never follow cache symlinks while hashing, changing permissions or removing trees.
function removeTree(path) {
  if (!existsSync(path) && !lstatExists(path)) return;
  if (lstatSync(path).isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) removeTree(join(path, name));
  }
  rmSync(path, { force: true, recursive: true });
}
function lstatExists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function inventory(tree, lock = false) {
  if (!lstatSync(tree).isDirectory()) throw new Error('snapshot must be a directory');
  const entries = [];
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), relative = prefix + name, stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push([relative, 'directory']);
        walk(path, relative + '/');
      } else if (stat.isFile()) {
        entries.push([relative, 'file', hash(readFileSync(path))]);
        if (lock) chmodSync(path, stat.mode & 0o111 ? 0o555 : 0o444);
      } else if (stat.isSymbolicLink() && relative === 'node_modules') {
        // Dependencies stay in the primary checkout; never traverse them as snapshot files.
        entries.push([relative, 'symlink', readlinkSync(path)]);
      } else throw new Error(`unsafe snapshot entry: ${relative}`);
    }
    if (lock) chmodSync(dir, 0o555);
  }
  walk(tree);
  return entries;
}
function verify(pinned, manifestPath, sha, offline) {
  const start = performance.now();
  let createdAt;
  try {
    if (!lstatSync(manifestPath).isFile()) throw new Error('manifest must be a regular file');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.sha !== sha || manifest.version !== 1 ||
        !Number.isFinite(manifest.createdAt) || manifest.createdAt > Date.now()) throw new Error('invalid snapshot manifest');
    createdAt = manifest.createdAt;
    if (offline && Date.now() - createdAt > maxAgeMs) {
      throw new Error('latest snapshot is older than 24h; restore origin/main to refresh it');
    }
    const entries = inventory(pinned);
    if (hash(JSON.stringify(entries)) !== manifest.digest ||
        JSON.stringify(entries) !== JSON.stringify(manifest.files)) throw new Error('snapshot integrity mismatch');
  } catch (error) {
    error.snapshotCreatedAt = createdAt;
    throw error;
  } finally {
    process.stderr.write(`Pinned guard: snapshot verification ${(performance.now() - start).toFixed(2)} ms\n`);
  }
}
function compatible(pinned, hookRoot) {
  const helper = join(pinned, 'scripts/lib/hook-root.mjs');
  if (!existsSync(helper)) throw new Error('snapshot lacks launcher-compatible root-resolution support (scripts/lib/hook-root.mjs); update origin/main');
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { pathToFileURL } from 'node:url';
const { hookRoot } = await import(pathToFileURL(process.argv[1]).href);
if (typeof hookRoot !== 'function' || hookRoot(import.meta.url) !== process.env.WE_HOOK_ROOT) process.exit(2);`, helper],
  { env: { ...process.env, WE_HOOK_ROOT: hookRoot }, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' });
  if (probe.error || probe.status !== 0) throw new Error('snapshot lacks launcher-compatible root-resolution support; update origin/main');
}

// No lease reclamation: a paused launcher/guard must never lose its snapshot.
// Abandoned locks fail closed and require operator inspection before removal.
async function lockSnapshot(locks, sha) {
  mkdirSync(locks, { recursive: true });
  const entry = { owner: randomUUID(), pid: process.pid, path: sha };
  return new Promise((resolveLock, reject) => {
    let watcher, timer, settled = false;
    const cleanup = () => { settled = true; watcher?.close(); clearTimeout(timer); };
    const fail = error => { cleanup(); reject(error); };
    const attempt = () => {
      if (settled) return true;
      try {
        if (!acquireLockDir(locks, sha, entry)) return false;
        cleanup();
        resolveLock(() => releaseLockDir(locks, sha));
        return true;
      } catch (error) { fail(error); return true; }
    };
    // Watch before checking ownership so a release cannot be missed.
    watcher = watch(locks, () => attempt());
    watcher.on('error', fail);
    timer = setTimeout(() => fail(new Error(
      'snapshot lock busy after 5s; retry the hook; inspect abandoned locks and remove them only after confirming no launcher or guard is using the snapshot'
    )), 5000);
    if (!attempt()) process.stderr.write('Pinned guard: waiting for snapshot lock\n');
  });
}

try {
  const [script, ...args] = process.argv.slice(2);
  if (!script || !/^scripts\/.+\.mjs$/.test(script) || script.split('/').includes('..')) throw new Error('expected a scripts/<guard>.mjs relative path');
  const hookRoot = realpathSync(git(process.cwd(), ['rev-parse', '--show-toplevel']));
  let primary = dirname(git(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const laneIndex = primary.indexOf(`${sep}.lanes${sep}`);
  if (laneIndex >= 0) {
    const workspace = primary.slice(0, laneIndex);
    primary = join(workspace, 'web-everything');
    if (!existsSync(primary)) primary = join(workspace, 'webeverything');
    primary = realpathSync(primary);
    if (primary.includes(`${sep}.lanes${sep}`)) throw new Error('refusing a lane primary');
  }
  // Repository identity must resolve even offline. Never consult the old global latest.
  const common = realpathSync(git(primary, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const cache = join(root, hash(common));
  let sha, offline = false;
  try {
    sha = git(primary, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
    if (!shaPattern.test(sha)) throw new Error('invalid origin/main SHA');
  } catch {
    offline = true;
    sha = readlinkSync(join(cache, 'latest'));
    if (!shaPattern.test(sha)) throw new Error('invalid latest snapshot pointer');
    process.stderr.write(`Pinned guard: origin/main unavailable; using latest snapshot ${sha}\n`);
  }
  mkdirSync(cache, { recursive: true });
  const pinned = join(cache, sha), manifestPath = join(cache, `${sha}.manifest`);
  const locks = `${cache}.locks`;
  const release = await lockSnapshot(locks, sha);
  try {
    function materialize(createdAt = Date.now()) {
      const temp = mkdtempSync(join(cache, '.snapshot-'));
      const tempManifest = join(cache, `.manifest-${randomUUID()}`);
      try {
        const archive = join(temp, 'snapshot.tar');
        git(primary, ['archive', '--format=tar', `--output=${archive}`, sha, 'scripts', 'package.json']);
        execFileSync('tar', ['-xf', archive, '-C', temp], { timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        rmSync(archive);
        if (existsSync(join(primary, 'node_modules'))) symlinkSync(join(primary, 'node_modules'), join(temp, 'node_modules'), 'dir');
        const files = inventory(temp, true);
        compatible(temp, hookRoot);
        writeFileSync(tempManifest, JSON.stringify({ version: 1, sha, createdAt, files, digest: hash(JSON.stringify(files)) }), { mode: 0o444 });
        renameSync(temp, pinned);
        renameSync(tempManifest, manifestPath);
      } finally { removeTree(temp); rmSync(tempManifest, { force: true }); }
    }
    try {
      verify(pinned, manifestPath, sha, offline);
    } catch (error) {
      // Recovery must never extend the offline age or invent missing age evidence.
      if (offline && (!Number.isFinite(error.snapshotCreatedAt) || Date.now() - error.snapshotCreatedAt > maxAgeMs)) {
        throw new Error(`latest snapshot failed verification: ${error.message}; restore origin/main to rebuild it`);
      }
      process.stderr.write(`Pinned guard: invalid cached snapshot; discarding and re-materializing from git: ${error.message}\n`);
      removeTree(pinned);
      rmSync(manifestPath, { force: true });
      materialize(offline ? error.snapshotCreatedAt : undefined);
      verify(pinned, manifestPath, sha, offline);
    }
    compatible(pinned, hookRoot);
    const target = realpathSync(join(pinned, script));
    if (!target.startsWith(realpathSync(pinned) + sep) || !statSync(target).isFile()) throw new Error(`missing or unsafe guard: ${script}`);
    const pointer = join(cache, `.latest-${randomUUID()}`);
    try {
      symlinkSync(sha, pointer);
      renameSync(pointer, join(cache, 'latest'));
    } finally { rmSync(pointer, { force: true }); }
    const older = readdirSync(cache).filter(name => shaPattern.test(name) && name !== sha)
      .map(name => {
        try { return { name, time: statSync(join(cache, name)).mtimeMs }; }
        catch (error) { if (error.code === 'ENOENT') return { name, time: 0 }; throw error; }
      }).sort((a, b) => b.time - a.time);
    for (const { name } of older.slice(2)) {
      // Never wait while holding our own SHA: another live guard may need it.
      if (!acquireLockDir(locks, name, { owner: randomUUID(), pid: process.pid, path: name })) continue;
      try {
        removeTree(join(cache, name));
        rmSync(join(cache, `${name}.manifest`), { force: true });
      } finally { releaseLockDir(locks, name); }
    }
    const child = spawnSync(process.execPath, [target, ...args], { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, WE_HOOK_ROOT: hookRoot } });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 2;
  } finally { release(); }
} catch (error) {
  process.stderr.write(`Pinned guard: cannot load trusted guard; denying (exit 2): ${error.message}\n`);
  process.exitCode = 2;
}
