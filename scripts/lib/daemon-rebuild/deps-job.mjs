#!/usr/bin/env node
/**
 * @file scripts/lib/daemon-rebuild/deps-job.mjs
 * @description x0m7a8x (card 5691, slice 2 of #4126) — a daemon clone's `npm ci` runs as a DETACHED DURABLE JOB
 *   (the shared job runtime, `../daemon-jobs-runtime.mjs`, the same one the rebuild job uses), never inline in the
 *   daemon's loop. Live harm it removes: the drain's `refreshClone` ran `npm ci` (minutes) inline between passes
 *   whenever the data clone's lockfile changed, so no PR landed meanwhile.
 *
 *   One file, two roles (the rebuild-job.mjs shape):
 *   1. LOOP SIDE — {@link refreshDepsAsJob}, called by the daemon BETWEEN passes. Fast: compares the clone's lockfile
 *      key with the one its `node_modules` was installed for; when they differ it queues ONE install job for the new
 *      lockfile (a fresh `node_modules` store under the job dir, never the live one), watches it, and once the store
 *      is complete SWAPS it in (an APFS clone copy, then two renames) — at a pass boundary, never under a running pass.
 *   2. JOB CHILD — this file run as a script from a pinned code snapshot: pnpm, or `npm ci --ignore-scripts`, into the
 *      lockfile-keyed store (`ensureNodeModulesStore`: built in a temp dir and renamed into place, so a half-built
 *      store is never used).
 *
 *   Settings (`depsAsJob` in daemon-rebuild-settings.json; env `WE_DAEMON_DEPS_AS_JOB` 1/0 beats the file; the
 *   built-in default is ON) — resolved by {@link resolveDepsAsJob}, which names its source for the caller's log.
 *
 *   node scripts/lib/daemon-rebuild/deps-job.mjs           # the job child (env from the runtime)
 */
import { execFileSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync,
  realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineJobKind, kindRegistry } from '../daemon-jobs.mjs';
import {
  createJobStore, createTickClock, enqueueJob, reattachTick, runJob,
} from '../daemon-jobs-runtime.mjs';
import {
  ensureNodeModulesStore, evictSnapshots, lockfileKey, snapshotsRoot, storeStillValid,
} from '../daemon-job-snapshots.mjs';
import { TERMINAL_JOB_STATUSES } from '../../operations/job-record.mjs';
import { daemonJobsDir } from '../../operations/run-store.mjs';
import { cloneKey } from '../daemon-overlays.mjs';
import { NPM_INSTALL_TIMEOUT_MS } from '../bounded-child.mjs';
import { readGit } from '../proc-read.mjs';
import {
  selectInstaller, runDepsInstaller, markerMatches, lockHash, readStoreGeneration, hasDanglingTopLevelLink,
  resolvePnpmStoreDir, whichOnPath, PROBE_TIMEOUT_MS, PROBE_MAX_BUFFER,
} from '../lane-deps-installer.mjs';
import { readLockfileParity } from '../../check-lockfile-parity.mjs';

const SELF = fileURLToPath(import.meta.url);
const SETTINGS_PATH = resolve(SELF, '..', '..', 'daemon-rebuild-settings.json');

export const DEPS_AS_JOB_ENV = 'WE_DAEMON_DEPS_AS_JOB';
export const DEFAULT_DEPS_JOB_RETRY_MS = 5 * 60_000;
const COMPLETE_MARKER = '.snapshot-complete';

/**
 * The argv for the install job's legacy npm backend. `--ignore-scripts` prevents npm lifecycle scripts in the
 * unattended daemon. The pnpm backend also disables scripts and verifies cached native build artifacts.
 * Exported so a caller (the drain) can refuse the job path when it is missing, and pinned by a test.
 */
export const DEPS_JOB_NPM_ARGS = Object.freeze(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);

export const DEPS_MARKER_FILE = '.we-deps-marker';

/** Follow the installed dependency graph, rather than treating root links as its inventory.
 * Resolve from real package paths so pnpm's adjacent GVS dependencies and multiple versions are visited.
 * A graph exceeding 10000 instances fails closed through the installer's logged npm fallback. */
function installedPackages(into) {
  const modules = join(into, 'node_modules');
  const pending = [];
  const packages = new Map();
  const seen = new Set();
  if (!existsSync(modules)) return packages;
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(modules, entry.name);
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (child.isDirectory() || child.isSymbolicLink()) pending.push([`${entry.name}/${child.name}`, join(path, child.name)]);
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) pending.push([entry.name, path]);
  }
  while (pending.length) {
    const [requestedName, path] = pending.pop();
    const root = realpathSync(path);
    if (seen.has(root)) continue;
    seen.add(root);
    if (seen.size > 10000) throw new Error('native dependency graph exceeds 10000 instances');
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const name = pkg.name ?? requestedName;
    if (!packages.has(name)) packages.set(name, new Set());
    packages.get(name).add(root);
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(dependency)
        || dependency.split('/').some((part) => part === '.' || part === '..')) {
        throw new Error('invalid installed dependency name');
      }
      let ancestor = root;
      for (;;) {
        const candidate = join(ancestor, 'node_modules', dependency);
        if (existsSync(candidate)) {
          pending.push([dependency, candidate]);
          break;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
  }
  return packages;
}

/** Read the workspace's boolean allowBuilds map without requiring installed YAML dependencies.
 * Unsupported policy syntax fails closed to the legacy installer, rather than silently skipping a build. */
function installedBuilds(into) {
  let policy;
  try { policy = readFileSync(join(into, 'pnpm-workspace.yaml'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const names = [];
  const packages = installedPackages(into);
  let inBuilds = false;
  let seenBuilds = false;
  let sawTopLevel = false;
  // Every YAML line break (CRLF, CR, LF) splits a line: a lone CR must not hide a key inside another line.
  for (const line of policy.split(/\r\n|\r|\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    // Indentation is spaces. A line that starts with any other whitespace (a BOM, NBSP, ...) is not a shape this reader
    // understands, and `\S` / `^allowBuilds` would silently read it as "indented, so not top-level".
    if (/^[^\S \t]/.test(line)) throw new Error('unsupported pnpm-workspace.yaml syntax');
    // A document marker opens the document; it is not itself a key. Content before a later marker would make a second
    // document, which this reader never follows. Only a marker before any content (still the first document) is read.
    if (/^---\s*(?:#.*)?$/.test(line)) {
      if (sawTopLevel) throw new Error('unsupported pnpm-workspace.yaml syntax');
      continue;
    }
    if (/^[^ \t]/.test(line)) sawTopLevel = true;
    // A document whose first content line is indented is a uniformly indented mapping: `  allowBuilds:` is then a
    // real top-level key this reader would never match. The marker above leaves sawTopLevel unset, so `---` followed by
    // an indented mapping is refused the same way.
    else if (!sawTopLevel) throw new Error('unsupported pnpm-workspace.yaml syntax');
    if (/^allowBuilds\s*:/.test(line)) {
      if (!/^allowBuilds\s*:\s*(?:#.*)?$/.test(line) || seenBuilds) throw new Error('unsupported allowBuilds policy');
      inBuilds = true;
      seenBuilds = true;
      continue;
    }
    // A top-level key this reader cannot name exactly could still BE `allowBuilds` (quoted `"allowBuilds":`, an escaped
    // spelling, `? allowBuilds`, a flow map, an anchor or tag): skipping it would silently skip the native-build check.
    // Only a bare key, a list item of the previous key or a document marker may sit at the top level; anything else
    // fails closed to the legacy installer, like every other unsupported policy syntax here.
    if (/^[^ \t]/.test(line) && !/^(?:[A-Za-z_@][\w@.\/-]*\s*:(?:\s|$)|-(?:\s|$)|---\s*(?:#.*)?$)/.test(line)) {
      throw new Error('unsupported pnpm-workspace.yaml syntax');
    }
    if (!inBuilds) continue;
    if (/^[^ \t]/.test(line)) { inBuilds = false; continue; }
    const entry = /^\s+(?:"([^"]+)"|'([^']+)'|([^\s:]+)):\s*(true|false)\s*(?:#.*)?$/.exec(line);
    if (!entry) throw new Error('unsupported allowBuilds entry');
    const name = entry[1] ?? entry[2] ?? entry[3];
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || name === '.' || name === '..') {
      throw new Error('invalid allowBuilds package');
    }
    if (entry[4] === 'true' && packages.has(name)) names.push(name);
  }
  return names;
}

/** Verify artifacts, never execute package code or write to pnpm's shared store.
 * GVS esbuild has a Mach-O bin/esbuild (also in its adjacent @esbuild platform package).
 * Other native packages ship .node libraries or native executables in optional platform packages.
 * Bound traversal to 2048 entries and six levels per package; incomplete evidence uses npm. */
export function nativeBuilt(into, names) {
  const magic = new Set(['7f454c46', '4d5a', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca']);
  // A binding is what the package loads (.node, or an executable). A supporting shared library
  // (.so/.dylib/.dll/.a, e.g. sharp-libvips) is never a binding, even when its mode is executable.
  const LIBRARY = /\.(?:so(?:\.\d+)*|dylib|dll|a)$/;
  function artifact(root, binding) {
    let remaining = 2048;
    function visit(dir, depth) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (--remaining < 0) throw new Error('native artifact scan limit');
        if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
        if (binding && LIBRARY.test(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth === 0) throw new Error('native artifact scan depth');
          if (visit(path, depth - 1)) return true;
        } else if (entry.isFile() && (/\.(?:node|so|dylib|dll|exe)$/.test(entry.name) || (statSync(path).mode & 0o111))) {
          const fd = openSync(path, 'r');
          const header = Buffer.alloc(4);
          try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
          const hex = header.toString('hex');
          if (magic.has(hex) || magic.has(hex.slice(0, 4))) return true;
        }
      }
      return false;
    }
    return visit(root, 6);
  }
  const validName = (dependency) => /^(?:@[\w.-]+\/)?[\w.-]+$/.test(dependency) && dependency !== '.' && dependency !== '..';
  const supports = (values, value) => !values || (Array.isArray(values)
    && !values.includes('!' + value) && (values.every((v) => v.startsWith('!')) || values.includes(value)));
  // Resolve optional packages from this package's own dependency graph, including scoped GVS paths.
  const locate = (root, name, dependency) => {
    const modules = name.startsWith('@') ? dirname(dirname(root)) : dirname(root);
    return [join(root, 'node_modules', dependency), join(modules, dependency)].find((path) => existsSync(path));
  };
  /** A platform package counts only with its own binding AND the supporting libraries named for this platform
   * (sharp-libvips-darwin-arm64 is the binding's dependency, never evidence for sharp by itself). */
  const platformBinding = (dependency, candidate) => {
    const real = realpathSync(candidate);
    const meta = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
    if (!supports(meta.os, process.platform) || !supports(meta.cpu, process.arch) || !artifact(real, true)) return false;
    return Object.keys(meta.optionalDependencies ?? {})
      .filter((support) => validName(support) && support.endsWith(`-${process.platform}-${process.arch}`))
      .every((support) => {
        const found = locate(real, dependency, support);
        return found !== undefined && artifact(realpathSync(found), false);
      });
  };
  try {
    const packages = installedPackages(into);
    return names.every((name) => packages.has(name) && [...packages.get(name)].every((root) => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (artifact(root, true)) return true;
      return Object.keys(pkg.optionalDependencies ?? {}).some((dependency) => {
        if (!validName(dependency)) return false;
        const candidate = locate(root, name, dependency);
        return candidate !== undefined && platformBinding(dependency, candidate);
      });
    }));
  } catch { return false; }
}

/** Install snapshot-local dependencies, using the legacy installer once if pnpm cannot be used. */
export function pnpmAwareInstaller({
  sourceRoot = process.cwd(), legacy, env = process.env, exec = execFileSync,
  storeDir = resolvePnpmStoreDir(env), which = (name) => whichOnPath(name, env.PATH),
  parity = (root = sourceRoot) => readLockfileParity(root).ok,
  log = (line) => process.stderr.write(`[deps-installer] ${line}\n`),
  timeoutMs = NPM_INSTALL_TIMEOUT_MS,
  nativeBuilt: checkNativeBuilt = nativeBuilt,
} = {}) {
  // `sourceDir` is the tree the store being built is FOR (ensureNodeModulesStore passes the pinned snapshot). The pnpm
  // inputs, their parity and the marker hash all come from it, so they agree with `storeStillValid(dir, sourceDir)`;
  // `sourceRoot` (e.g. the live clone, whose checkout can differ from the snapshot's) only applies when none is given.
  return (into, { sourceDir } = {}) => {
    const inputsRoot = sourceDir ?? sourceRoot;
    let same = false;
    try {
      same = readFileSync(join(inputsRoot, 'package-lock.json'), 'utf8')
        === readFileSync(join(into, 'package-lock.json'), 'utf8');
    } catch { /* Missing or unreadable inputs must use the legacy path. */ }
    let plan = selectInstaller({
      which, parity: () => parity(inputsRoot), storeDir,
      hasPnpmLock: same && existsSync(join(inputsRoot, 'pnpm-lock.yaml')),
      hasNpmLock: existsSync(join(into, 'package-lock.json')),
      exec: (command, args, { cwd }) => exec(command, args, {
        cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER, killSignal: 'SIGKILL',
      }),
    });
    // This plan is never spawned: its dispatch calls the existing installer directly.
    const npm = { backend: 'npm', command: Symbol('legacy-installer'), args: [] };
    if (plan.backend === 'pnpm') {
      // Unattended and run with the daemon's credentials: no lifecycle scripts AND no pnpmfile / config-dependency
      // hooks (a checked-in .pnpmfile.cjs or a `pnpmfile:` setting in the copied workspace config is code, too).
      plan.args.push('--ignore-scripts', '--ignore-pnpmfile');
      plan.fallback = npm;
      if (readStoreGeneration(storeDir) === null) {
        log('pnpm store not initialised by a lane; using npm');
        plan = npm;
      }
    } else plan = npm;
    if (plan.backend === 'pnpm' && resolve(inputsRoot) !== resolve(into)) {
      for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
        const source = join(inputsRoot, name);
        if (existsSync(source)) copyFileSync(source, join(into, name));
        else rmSync(join(into, name), { force: true });
      }
    }
    const markerPath = join(into, DEPS_MARKER_FILE);
    let marker = null;
    try { marker = readFileSync(markerPath, 'utf8').trim(); } catch { /* No trusted marker yet. */ }
    const hashFor = (backend) => lockHash(into, backend, storeDir);
    // Normalize old unprefixed npm markers for the shared runner's backend transition check.
    const npmHash = hashFor('npm');
    if (npmHash && markerMatches(marker, npmHash, 'npm')) marker = `npm:${npmHash}`;
    const result = runDepsInstaller({
      plan, hashFor, marker, hasNodeModules: existsSync(join(into, 'node_modules')),
      invalidate: () => rmSync(markerPath, { force: true }),
      remove: () => rmSync(join(into, 'node_modules'), { recursive: true, force: true }),
      log,
      exec: (command, args) => {
        const backend = command === npm.command ? 'npm' : 'pnpm';
        log(`backend=${backend}`);
        if (backend === 'npm') return legacy(into);
        const output = exec(command, args, {
          cwd: into, env, stdio: ['ignore', 2, 'pipe'], timeout: timeoutMs,
          maxBuffer: PROBE_MAX_BUFFER, killSignal: 'SIGKILL',
        });
        const names = installedBuilds(into);
        if (checkNativeBuilt(into, names) !== true) {
          log(`native build missing: ${names.join(', ')}; backend=npm`);
          throw new Error('native build missing');
        }
        return output;
      },
    });
    // Without a lockfile or manifest there is no dependency identity to persist.
    if (hashFor(result.backend) !== null) writeFileSync(markerPath, result.marker);
  };
}

/** The deps job uses pnpm when eligible, retaining its script-free npm fallback. */
export function depsJobInstaller({ timeoutMs = NPM_INSTALL_TIMEOUT_MS, exec = execFileSync,
  sourceRoot = process.cwd(), ...options } = {}) {
  const legacy = (into) => {
    exec('npm', [...DEPS_JOB_NPM_ARGS], { cwd: into, stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
  };
  return pnpmAwareInstaller({ ...options, sourceRoot, timeoutMs, exec, legacy });
}

export const DEPS_JOB_KIND = defineJobKind({
  kind: 'daemon-deps-install',
  entry: 'scripts/lib/daemon-rebuild/deps-job.mjs',
  codeMode: 'readonly-tree',
  serial: true,
  // The child needs no packages itself (node built-ins + this repo's scripts only): it BUILDS the store.
  nodeModules: false,
  maxAttempts: 2,
});
export const DEPS_JOB_KINDS = kindRegistry([DEPS_JOB_KIND]);

/**
 * The effective `depsAsJob` setting and where it came from (env > file > built-in). Never throws.
 * @returns {{enabled: boolean, retryMs: number, source: 'env'|'file'|'built-in'}}
 */
export function resolveDepsAsJob({ env = process.env, path = SETTINGS_PATH } = {}) {
  let file = null;
  try { file = JSON.parse(readFileSync(path, 'utf8'))?.depsAsJob ?? null; } catch { file = null; }
  const retryMs = Number.isFinite(file?.retryMs) && file.retryMs >= 0 ? file.retryMs : DEFAULT_DEPS_JOB_RETRY_MS;
  const v = env?.[DEPS_AS_JOB_ENV];
  if (v === '0' || v === '1') return { enabled: v === '1', retryMs, source: 'env' };
  if (typeof file?.enabled === 'boolean') return { enabled: file.enabled, retryMs, source: 'file' };
  return { enabled: true, retryMs, source: 'built-in' };
}

/** `<daemonJobsRoot>/deps-<cloneKey>` — one clone's install jobs and their `node_modules` stores. */
export function depsJobsDir(root, env = process.env) {
  return daemonJobsDir(`deps-${cloneKey(root)}`, env);
}

/** The store directory (holding `node_modules/`) for a lockfile key, and whether it is complete. */
export function depsStore(jobsDir, key) {
  const dir = join(snapshotsRoot(jobsDir), 'node-modules', key);
  return { dir, complete: existsSync(join(dir, COMPLETE_MARKER)) && existsSync(join(dir, 'node_modules')) && storeStillValid(dir) };
}

const MAX_REBASE_ENTRIES = 2_000_000;
const MAX_SHIM_BYTES = 4 * 1024 * 1024;
// pnpm/cmd-shim spellings: $basedir/x, "$basedir_abs"/'x', "$basedir_win"/'x', ${basedir}/x.
const SHIM_PATH = /(\$\{?basedir(?:_abs|_win)?\}?"?)\/(?:'([^']*)'|([^\s"':$;|&()]+))/g;
const SHIM_VAR_SLASH = /\$\{?basedir\w*\}?"?\//g;
const insideTree = (path, tree) => path === tree || path.startsWith(tree + sep);

/**
 * Make a copied `node_modules` work at its FINAL location. `cp -R` keeps symlink text verbatim, so pnpm's relative
 * links into the shared store (and the `$basedir/…` paths inside its `.bin` shims) dangle once the tree sits at a
 * different depth than where it was installed. Links and shims that point INSIDE the tree keep their text (the
 * tree moves as a unit); every other relative one is rewritten to reach the same target from `final`. Absolute
 * links are left alone. Fails closed: a link that resolved in `from` but not in the copy throws.
 * @param {{from: string, copy: string, final: string}} o `from` the tree as installed, `copy` where the copy is now,
 *   `final` where it will live.
 */
export function rebaseNodeModulesLinks({ from, copy, final }) {
  // Real paths on both ends: `..` in a link is resolved physically, so a symlinked parent (/tmp, a moved clone
  // root) must not skew the relative path.
  from = realpathSync(from); copy = resolve(copy); final = join(realpathSync(dirname(resolve(final))), basename(final));
  if (from === final) return;
  const stack = [''];
  let seen = 0;
  while (stack.length) {
    const rel = stack.pop();
    const dir = join(copy, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++seen > MAX_REBASE_ENTRIES) throw new Error('node_modules link rebase entry limit');
      const childRel = join(rel, entry.name);
      const path = join(copy, childRel);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target)) continue;
        const original = join(from, childRel);
        const absolute = resolve(dirname(original), target);
        if (insideTree(absolute, from)) {
          if (existsSync(original) && !existsSync(path)) throw new Error(`node_modules link did not survive the copy: ${childRel}`);
          continue;
        }
        if (existsSync(original) && !existsSync(absolute)) throw new Error(`node_modules link would dangle: ${childRel}`);
        rmSync(path, { force: true });
        symlinkSync(relative(dirname(join(final, childRel)), absolute), path);
      } else if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile() && basename(rel) === '.bin') {
        if (statSync(path).size > MAX_SHIM_BYTES) throw new Error(`bin shim too large to rebase: ${childRel}`);
        const bytes = readFileSync(path);
        if (bytes.includes(0)) continue; // a native executable, not a shell/PowerShell shim
        const text = bytes.toString('utf8');
        if (!/basedir/.test(text)) continue;
        const binDir = dirname(join(from, childRel));
        const finalBin = dirname(join(final, childRel));
        const next = text.replace(SHIM_PATH, (whole, head, quoted, bare) => {
          const absolute = resolve(binDir, quoted ?? bare);
          if (insideTree(absolute, from)) return whole;
          const path = relative(finalBin, absolute).split(sep).join('/') || '.';
          if (quoted !== undefined) return `${head}/'${path.replaceAll("'", "'\\''")}'`;
          if (!/^[\w@.+,=%~/-]+$/.test(path)) throw new Error(`bin shim path cannot be rebased unquoted: ${childRel}`);
          return `${head}/${path}`;
        });
        // Fail closed on any `$basedir…/` path spelling the rewrite did not recognise.
        if ((text.match(SHIM_VAR_SLASH) ?? []).length !== (text.match(SHIM_PATH) ?? []).length) {
          throw new Error(`bin shim has an unrecognised $basedir path: ${childRel}`);
        }
        if (next !== text) writeFileSync(path, next);
      }
    }
  }
}

/**
 * Swap a complete store's `node_modules` into `root` — the caller guarantees no pass is running. The copy is an APFS
 * clone (`cp -c`, near-instant; a plain copy where the filesystem has none) into a sibling temp dir; then the live
 * directory is renamed aside, the copy renamed in, and the old one deleted. The store itself is kept (a later
 * rollback or a sibling clone can reuse it).
 *
 * Failure handling: a failed copy leaves the live tree untouched. If the copy cannot be renamed in after the live tree
 * was moved aside, the old tree is renamed BACK (rollback) before the error is rethrown; the error carries
 * `liveIntact` (false only when that rollback failed too, so the caller's log never claims an unchanged tree it does
 * not have). Leftover `.node_modules.swap.*` / `.node_modules.old.*` dirs from ANY earlier process (a crash between
 * the renames) are removed first. A crash between the two renames leaves no `node_modules` until the next call: the
 * caller's `installed` key is written only after a swap, so that call swaps again from the kept store.
 */
export function swapNodeModules({ root, storeDir, exec = execFileSync, rename = renameSync }) {
  const live = join(root, 'node_modules');
  const tmp = join(root, `.node_modules.swap.${process.pid}`);
  const old = join(root, `.node_modules.old.${process.pid}`);
  for (const name of readdirSync(root)) {
    if (/^\.node_modules\.(swap|old)\.\d+$/.test(name)) rmSync(join(root, name), { recursive: true, force: true });
  }
  try { exec('cp', ['-cR', join(storeDir, 'node_modules'), tmp], { stdio: 'ignore', timeout: 5 * 60_000 }); } catch {
    rmSync(tmp, { recursive: true, force: true });
    exec('cp', ['-R', join(storeDir, 'node_modules'), tmp], { stdio: 'ignore', timeout: 10 * 60_000 });
  }
  // Relative store links and bin shims are rebased BEFORE the live tree is touched, so a copy that cannot
  // resolve at the final location leaves the working dependencies in place (and the lockfile key unstamped).
  try { rebaseNodeModulesLinks({ from: join(storeDir, 'node_modules'), copy: tmp, final: live }); } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const hadLive = existsSync(live);
  if (hadLive) rename(live, old);
  try {
    rename(tmp, live);
  } catch (e) {
    let restored = !hadLive;
    if (hadLive) { try { rename(old, live); restored = true; } catch { restored = false; } }
    rmSync(tmp, { recursive: true, force: true });
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { liveIntact: restored });
  }
  rmSync(old, { recursive: true, force: true });
}

function readHead(root) {
  return readGit(['-C', root, 'rev-parse', 'HEAD'], {
    timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

const CLOCKS = new Map();
function clockFor(dir) {
  if (!CLOCKS.has(dir)) CLOCKS.set(dir, createTickClock());
  return CLOCKS.get(dir);
}

/**
 * LOOP SIDE. Never runs `npm ci` itself. Call it between passes; it returns at once.
 * @param {{root: string, installed: {read: () => (string|null), write: (key: string) => void}, env?: object,
 *   log?: Function, store?: object, reattach?: Function, clock?: object, now?: () => number, codeSha?: string,
 *   swap?: Function, evict?: Function, retryMs?: number, readLock?: (root: string) => string}} o — `installed` is
 *   the caller's record of which lockfile key the live `node_modules` was installed for.
 * @returns {Promise<{reason: string, key?: string, job?: object}>} reason: `up-to-date` | `swapped` |
 *   `deps-job-started` | `deps-job-running` | `deps-job-spaced` | `deps-job-queue-failed` | `swap-failed` | `no-lockfile`
 */
export async function refreshDepsAsJob({
  root, installed, env = process.env, log = () => {}, store = createJobStore(depsJobsDir(root, env)), reattach = reattachTick,
  clock, now = () => Date.now(), codeSha, swap = swapNodeModules, evict = evictSnapshots, retryMs = DEFAULT_DEPS_JOB_RETRY_MS,
  readLock = (r) => readFileSync(join(r, 'package-lock.json'), 'utf8'),
}) {
  const say = (m) => log(`deps-job: ${m}`);
  let key;
  try { key = lockfileKey(readLock(root)); } catch { return { reason: 'no-lockfile' }; }
  // The recorded key proves which lockfile was swapped in, not that the tree still works: pnpm links point into a
  // shared store that can be wiped underneath the clone. A dangling top-level link (or an unreadable tree) is not ready.
  if (installed.read() === key && !hasDanglingTopLevelLink(join(root, 'node_modules'))) return { reason: 'up-to-date', key };
  mkdirSync(store.dir, { recursive: true });
  const kind = DEPS_JOB_KIND.kind;
  const mine = () => store.list().records.filter((r) => r.job.kind === kind && r.input?.key === key);
  const pass = async () => {
    try {
      return await reattach({
        store, kinds: DEPS_JOB_KINDS, maxConcurrent: 1, clock: clock ?? clockFor(store.dir), snapshot: { repoDir: root }, log: say,
      });
    } catch (e) {
      say(`reattach pass failed (${String(e?.message || e).split('\n')[0]}) — the next call retries`);
      return null;
    }
  };
  const housekeeping = () => {
    const referenced = store.list().records.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)).flatMap((r) => r.job.snapshotKeys || []);
    // The store this clone now runs on is kept by recency (evictSnapshots keeps the newest 2 per type).
    try { evict({ jobsDir: store.dir, referenced }); } catch (e) { say(`snapshot eviction failed: ${e.message}`); }
  };

  // 1. The store for this lockfile is built: swap it in now (the caller is between passes).
  const st = depsStore(store.dir, key);
  if (st.complete) {
    try {
      swap({ root, storeDir: st.dir });
    } catch (e) {
      const intact = e?.liveIntact !== false;
      say(`swap failed (${String(e?.message || e).split('\n')[0]}) — ${intact
        ? 'the live node_modules is unchanged'
        : 'the live node_modules could NOT be restored (it is missing until the swap succeeds)'}; the next call retries`);
      return { reason: 'swap-failed', key, liveIntact: intact };
    }
    installed.write(key);
    say(`swapped in node_modules for lockfile ${key} at a pass boundary (built off the loop by the install job)`);
    housekeeping();
    return { reason: 'swapped', key };
  }

  // 2. A job for this lockfile is in flight: reattach (launch / stalled / dead handling) and return.
  const live = mine().find((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status));
  if (live) {
    await pass();
    // A job that finished during the pass still answers `deps-job-running` (with its terminal status): the next call
    // swaps its store in, or spaces a retry.
    const cur = store.read(live.id);
    return { reason: 'deps-job-running', key, job: { id: live.id, status: cur?.job.status ?? 'gone' } };
  }

  // 3. The last job for this lockfile finished without a store (failed): retry at most once per `retryMs`.
  const last = mine().filter((r) => TERMINAL_JOB_STATUSES.includes(r.job.status))
    .sort((a, b) => Date.parse(b.job.finishedAt || 0) - Date.parse(a.job.finishedAt || 0))[0];
  if (last && now() - Date.parse(last.job.finishedAt || 0) < retryMs) {
    return { reason: 'deps-job-spaced', key, job: { id: last.id, status: last.job.status, error: last.job.error ?? null } };
  }

  // 4. Queue one install job for this lockfile, pinned to the commit whose lockfile it is.
  let queued;
  try {
    queued = enqueueJob({ store, kindDef: DEPS_JOB_KIND, codeSha: codeSha ?? readHead(root), now: now(), input: { key } });
  } catch (e) {
    say(`could not queue an install job (${String(e?.message || e).split('\n')[0]}) — the next call retries`);
    return { reason: 'deps-job-queue-failed', key };
  }
  say(`lockfile changed (${installed.read() ?? 'unknown'} -> ${key}) — queued install job ${queued.id}; npm ci runs detached, passes keep running on the current node_modules until the swap`);
  await pass();
  return { reason: 'deps-job-started', key, job: { id: queued.id } };
}

// ── job child ────────────────────────────────────────────────────────────────────────────────────────────────

/** The job's one step: build the lockfile-keyed store from the pinned snapshot's lockfile (idempotent). */
export function installStep({ jobsDir, sourceDir, expectKey, install = depsJobInstaller({ sourceRoot: sourceDir }) }) {
  const got = lockfileKey(readFileSync(join(sourceDir, 'package-lock.json'), 'utf8'));
  if (expectKey && got !== expectKey) throw new Error(`lockfile of the pinned commit is ${got}, not the requested ${expectKey}`);
  const { key, dir } = ensureNodeModulesStore({ jobsDir, sourceDir, install });
  return { key, dir };
}

/**
 * The job child's whole run, injectable for tests: the runtime spawns this file with `OPERATION_RUNS_DIR` = the
 * clone's deps jobs dir (where the store is built) and its cwd = the pinned code snapshot (whose lockfile it installs).
 * @param {{env?: object, cwd?: string, install?: Function, run?: typeof runJob, write?: (s: string) => void}} [o]
 */
export async function runDepsJob({
  env = process.env, cwd = process.cwd(), install = depsJobInstaller({ sourceRoot: cwd, env }), run = runJob, write = (m) => process.stderr.write(m),
} = {}) {
  const dir = env.OPERATION_RUNS_DIR;
  return run({
    env,
    steps: [{
      name: 'npm-ci',
      run: async ({ jobId, input }) => {
        write(`[deps-job ${jobId}] ${new Date().toISOString()} npm ci for lockfile ${input.key}\n`);
        const r = installStep({ jobsDir: dir, sourceDir: cwd, expectKey: input.key, install });
        write(`[deps-job ${jobId}] ${new Date().toISOString()} store ready: ${r.dir}\n`);
        return { key: r.key };
      },
    }],
  });
}

async function jobMain() {
  const out = await runDepsJob();
  process.stderr.write(`[deps-job] outcome ${out.outcome}${out.error ? `: ${out.error}` : ''}\n`);
  process.exit(out.outcome === 'succeeded' ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  jobMain().catch((e) => {
    process.stderr.write(`[deps-job] fatal: ${String(e?.stack || e)}\n`);
    process.exit(1);
  });
}
