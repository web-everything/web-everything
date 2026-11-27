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
 *   2. JOB CHILD — this file run as a script from a pinned code snapshot: `npm ci --ignore-scripts` into the
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
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineJobKind, kindRegistry } from '../daemon-jobs.mjs';
import {
  createJobStore, createTickClock, enqueueJob, reattachTick, runJob,
} from '../daemon-jobs-runtime.mjs';
import {
  ensureNodeModulesStore, evictSnapshots, lockfileKey, snapshotsRoot,
} from '../daemon-job-snapshots.mjs';
import { TERMINAL_JOB_STATUSES } from '../../operations/job-record.mjs';
import { daemonJobsDir } from '../../operations/run-store.mjs';
import { cloneKeyOf as cloneKey } from '../daemon-last-good.mjs';
import { NPM_INSTALL_TIMEOUT_MS } from '../bounded-child.mjs';
import { readGit } from '../proc-read.mjs';

const SELF = fileURLToPath(import.meta.url);
const SETTINGS_PATH = resolve(SELF, '..', '..', 'daemon-rebuild-settings.json');

export const DEPS_AS_JOB_ENV = 'WE_DAEMON_DEPS_AS_JOB';
export const DEFAULT_DEPS_JOB_RETRY_MS = 5 * 60_000;
const COMPLETE_MARKER = '.snapshot-complete';

const SYNTAX_LIMITS = Object.freeze({ maxFiles: 128, maxBytes: 4 * 1024 * 1024, maxMs: 10_000 });
const NON_CLAIMS = Object.freeze([
  'invoked-function loads', 'eval', 'aliased createRequire', 'computed specifiers',
]);

/**
 * Bounded syntax evidence, never a proof of the runtime import closure. Follow import/re-export
 * declarations and local require/import targets on non-indented lines, refusing nonliteral
 * specifiers as UNKNOWN. Keep the previous conservative text heuristic, including quoted eval
 * loads: runtime non-claims must never exempt a previously rejected load. No source is executed.
 * All IO, paths, time and the TypeScript syntax API are supplied by the caller; this module
 * must load without installed packages. Incomplete evidence throws with a repair/retry action.
 * This opt-in inspection reports syntax evidence only and never executes the inspected source.
 */
export function inspectDepsImports(entry, { root: repoRoot, read, now, syntax: ts, ...limits } = {}) {
  const { maxFiles, maxBytes, maxMs } = { ...SYNTAX_LIMITS, ...limits };
  const refuse = (reason) => {
    throw new Error(`Incomplete dependency syntax evidence: ${reason}; repair the input or inspection budget and retry; runtime assurance requires a separate isolated import trace.`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
  };
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot) || typeof read !== 'function' || typeof now !== 'function' || typeof ts?.createSourceFile !== 'function') refuse('required-input-missing');
  if (![maxFiles, maxBytes, maxMs].every((n) => Number.isSafeInteger(n) && n > 0)) refuse('invalid-budget');
  const started = now();
  let last = started;
  const checkTime = () => {
    const tick = now();
    if (!Number.isFinite(started) || !Number.isFinite(tick) || tick < last) refuse('invalid-clock');
    last = tick;
    if (tick - started >= maxMs) refuse('time-budget');
  };
  const localPath = (absolute) => {
    const path = relative(repoRoot, absolute);
    if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) refuse(`outside-root: ${absolute}`);
    return path;
  };
  const classifyAbsolute = (absolute, name) => {
    const path = relative(repoRoot, absolute);
    // Installed packages and external sources are dependencies, even when their
    // specifier is a path or URL. Report them without reading outside the closure.
    if (path === '..' || path.startsWith('../') || isAbsolute(path)
      || resolve(absolute).split(/[\\/]/).includes('node_modules')) return { package: name };
    return { local: localPath(absolute) };
  };
  const classify = (name, path) => {
    if (isBuiltin(name)) return { builtin: true };
    if (name.startsWith('./') || name.startsWith('../')) return { local: localPath(resolve(repoRoot, dirname(path), name)) };
    if (isAbsolute(name)) return classifyAbsolute(name, name);
    if (name.startsWith('file:')) {
      let absolute;
      try { absolute = fileURLToPath(name); } catch (error) { refuse(`invalid-file-url: ${error.message}`); }
      return classifyAbsolute(absolute, name);
    }
    if (!name || /^[a-zA-Z][\w+.-]*:/.test(name)) refuse(`unsupported-specifier: ${name}`);
    return { package: name };
  };
  const seen = new Set();
  const packages = [];
  let bytes = 0;
  function walk(path, chain) {
    checkTime();
    if (seen.has(path)) return;
    if (seen.size >= maxFiles) refuse('file-budget');
    seen.add(path);
    let text;
    try { text = read(path, maxBytes - bytes); } catch (error) { refuse(`read-failed: ${path}: ${error.message}`); }
    checkTime();
    if (typeof text !== 'string') refuse(`read-failed: ${path}: missing source text`);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) refuse('byte-budget');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) refuse(`malformed-module: ${path}`);
    const lines = text.split('\n');
    const startupPackages = new Set();
    const startupLocals = new Set();
    const calls = [source];
    while (calls.length) {
      checkTime();
      const node = calls.pop();
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require')
        || (ts.isElementAccessExpression(node.expression) && ts.isStringLiteral(node.expression.argumentExpression)
          && node.expression.argumentExpression.text === 'require'))) {
        const line = lines[source.getLineAndCharacterOfPosition(node.getStart(source)).line];
        const argument = node.arguments[0];
        if (/^\S/.test(line)) {
          if (!argument || !ts.isStringLiteral(argument)) refuse(`unknown-specifier: ${path}`);
          const target = classify(argument.text, path);
          if (target.local) startupLocals.add(target.local);
          if (target.package) startupPackages.add(target.package);
        }
      }
      ts.forEachChild(node, (child) => { calls.push(child); });
    }
    for (const line of lines) {
      checkTime();
      if (!/^\S/.test(line) || /^\/\//.test(line)) continue;
      for (const match of line.matchAll(/\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1/g)) {
        checkTime();
        const target = classify(match[2], path);
        if (target.local) startupLocals.add(target.local);
        if (target.package) startupPackages.add(target.package);
      }
    }
    for (const name of startupPackages) packages.push([...chain, path, name].join(' -> '));
    for (const target of startupLocals) walk(target, [...chain, path]);
    for (const statement of source.statements) {
      checkTime();
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier) continue;
      if (!ts.isStringLiteral(specifier)) refuse(`unreadable-import: ${path}`);
      const target = classify(specifier.text, path);
      if (target.local) walk(target.local, [...chain, path]);
      else if (target.package) packages.push([...chain, path, target.package].join(' -> '));
    }
  }
  walk(localPath(resolve(repoRoot, entry)), []);
  checkTime();
  return { packages, visited: [...seen], nonClaims: NON_CLAIMS, assurance: 'bounded syntax only; runtime import closure unproven' };
}

/**
 * The ONE argv the install job runs `npm` with. `--ignore-scripts` is load-bearing: the daemon runs unattended with
 * the operator's gh/git credentials, so a lockfile change that lands on main (possibly merged by the drain itself)
 * must never execute npm lifecycle scripts. Exported so a caller (the drain) can refuse the job path when it is
 * missing, and pinned by a test.
 */
export const DEPS_JOB_NPM_ARGS = Object.freeze(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);

/** The install job's installer: `npm <DEPS_JOB_NPM_ARGS>` in a directory holding only the manifest and lockfile. */
export function depsJobInstaller({ timeoutMs = NPM_INSTALL_TIMEOUT_MS, exec = execFileSync } = {}) {
  return (into) => {
    exec('npm', [...DEPS_JOB_NPM_ARGS], { cwd: into, stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
  };
}

export const DEPS_JOB_KIND = defineJobKind({
  kind: 'daemon-deps-install',
  entry: 'scripts/lib/daemon-rebuild/deps-job.mjs',
  codeMode: 'readonly-tree',
  serial: true,
  // The child builds the store without installed packages. deps-job-no-packages.test.mjs checks its
  // bounded static import/re-export graph via inspectDepsImports, plus a conservative load-line heuristic. This is syntax
  // evidence only: invoked-function loads, eval and aliased createRequire are outside its proof.
  // Stronger runtime-import assurance needs a separately reviewed, isolated import trace.
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
  return { dir, complete: existsSync(join(dir, COMPLETE_MARKER)) && existsSync(join(dir, 'node_modules')) };
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
  if (installed.read() === key) return { reason: 'up-to-date', key };
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
export function installStep({ jobsDir, sourceDir, expectKey, install = depsJobInstaller() }) {
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
  env = process.env, cwd = process.cwd(), install = depsJobInstaller(), run = runJob, write = (m) => process.stderr.write(m),
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
