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
  existsSync, mkdirSync, readFileSync, renameSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineJobKind, kindRegistry } from '../daemon-jobs.mjs';
import {
  createJobStore, createTickClock, enqueueJob, reattachTick, runJob,
} from '../daemon-jobs-runtime.mjs';
import {
  ensureNodeModulesStore, evictSnapshots, lockfileKey, npmCiInstaller, snapshotsRoot,
} from '../daemon-job-snapshots.mjs';
import { TERMINAL_JOB_STATUSES } from '../../operations/job-record.mjs';
import { daemonJobsDir } from '../../operations/run-store.mjs';
import { cloneKey } from '../daemon-overlays.mjs';
import { readGit } from '../proc-read.mjs';

const SELF = fileURLToPath(import.meta.url);
const SETTINGS_PATH = resolve(SELF, '..', '..', 'daemon-rebuild-settings.json');

export const DEPS_AS_JOB_ENV = 'WE_DAEMON_DEPS_AS_JOB';
export const DEFAULT_DEPS_JOB_RETRY_MS = 5 * 60_000;
const COMPLETE_MARKER = '.snapshot-complete';

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
  return { dir, complete: existsSync(join(dir, COMPLETE_MARKER)) && existsSync(join(dir, 'node_modules')) };
}

/**
 * Swap a complete store's `node_modules` into `root` — the caller guarantees no pass is running. The copy is an APFS
 * clone (`cp -c`, near-instant; a plain copy where the filesystem has none) into a sibling temp dir; then the live
 * directory is renamed aside, the copy renamed in, and the old one deleted. The store itself is kept (a later
 * rollback or a sibling clone can reuse it).
 */
export function swapNodeModules({ root, storeDir, exec = execFileSync }) {
  const live = join(root, 'node_modules');
  const tmp = join(root, `.node_modules.swap.${process.pid}`);
  const old = join(root, `.node_modules.old.${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  try { exec('cp', ['-cR', join(storeDir, 'node_modules'), tmp], { stdio: 'ignore', timeout: 5 * 60_000 }); } catch {
    rmSync(tmp, { recursive: true, force: true });
    exec('cp', ['-R', join(storeDir, 'node_modules'), tmp], { stdio: 'ignore', timeout: 10 * 60_000 });
  }
  rmSync(old, { recursive: true, force: true });
  if (existsSync(live)) renameSync(live, old);
  renameSync(tmp, live);
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
      say(`swap failed (${String(e?.message || e).split('\n')[0]}) — the live node_modules is unchanged; the next call retries`);
      return { reason: 'swap-failed', key };
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
    const cur = store.read(live.id);
    if (cur && !TERMINAL_JOB_STATUSES.includes(cur.job.status)) return { reason: 'deps-job-running', key, job: { id: cur.id, status: cur.job.status } };
    return { reason: 'deps-job-running', key, job: { id: live.id, status: cur?.job.status ?? 'gone' } }; // finished in the pass: next call swaps
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
export function installStep({ jobsDir, sourceDir, expectKey, install = npmCiInstaller() }) {
  const got = lockfileKey(readFileSync(join(sourceDir, 'package-lock.json'), 'utf8'));
  if (expectKey && got !== expectKey) throw new Error(`lockfile of the pinned commit is ${got}, not the requested ${expectKey}`);
  const { key, dir } = ensureNodeModulesStore({ jobsDir, sourceDir, install });
  return { key, dir };
}

async function jobMain() {
  const dir = process.env.OPERATION_RUNS_DIR;
  const out = await runJob({
    steps: [{
      name: 'npm-ci',
      run: async ({ jobId, input }) => {
        process.stderr.write(`[deps-job ${jobId}] ${new Date().toISOString()} npm ci for lockfile ${input.key}\n`);
        const r = installStep({ jobsDir: dir, sourceDir: process.cwd(), expectKey: input.key });
        process.stderr.write(`[deps-job ${jobId}] ${new Date().toISOString()} store ready: ${r.dir}\n`);
        return { key: r.key };
      },
    }],
  });
  process.stderr.write(`[deps-job] outcome ${out.outcome}${out.error ? `: ${out.error}` : ''}\n`);
  process.exit(out.outcome === 'succeeded' ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  jobMain().catch((e) => {
    process.stderr.write(`[deps-job] fatal: ${String(e?.stack || e)}\n`);
    process.exit(1);
  });
}
