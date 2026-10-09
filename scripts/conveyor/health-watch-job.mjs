#!/usr/bin/env node
/**
 * @file scripts/conveyor/health-watch-job.mjs
 * @description #4131 — the health watch's JOB ADOPTION (statute `#daemon-jobs`, first adopter of the shared job
 *   runtime we:scripts/lib/daemon-jobs-runtime.mjs). One file, three roles:
 *
 *   1. TICK SIDE — {@link runGhProbeJobs}, called by `health-watch.mjs tick` when the `ghProbes` switch is on.
 *      It consumes a finished `health-gh-probe` job's result once, queues a new job when the gh cadence is due
 *      and none is in flight, runs the runtime's reattach pass (live = left alone, stalled = stopped then
 *      requeued, dead = requeued with backoff, out of attempts = failed visibly), evicts unreferenced snapshots
 *      and prunes old finished records. It never waits on a job.
 *   2. JOB CHILD — this file run as a script (the kind's `entry`), detached, from a pinned code snapshot. It
 *      claims its record through `runJob` and heartbeats from its own event loop, while the synchronous probe
 *      bodies run in a WORKER THREAD beneath it: a 2-minute `execFileSync` read can never starve the heartbeat.
 *      The worker thread dies with the job process. The probes' own subprocesses (`gh`, the stale-state CLI) are
 *      in the job's process group: a graceful stop (SIGTERM) kills the group; after a SIGKILL they may finish
 *      their own bounded timeouts (≤ 90 s) beside the retry. They only read, so an overlap duplicates a read,
 *      never a write.
 *   3. WORKER — runs `collectGhProbes` (we:scripts/conveyor/health-watch.mjs), scrubs the result and posts it.
 *
 *   A finished job's result is a sidecar `<jobsDir>/<id>.result` (JSON; not `.json`, so run-record readers never
 *   parse it as a run), named in the record's checkpoint. Only the tick writes health state.
 *
 *   node scripts/conveyor/health-watch-job.mjs                       # the job child (env from the runtime)
 *   node scripts/conveyor/health-watch-job.mjs enqueue-proof --block-ms=300000 [--jobs-dir=DIR]
 *       # live proof only: queue a gh-probe job whose worker blocks for --block-ms, then returns no probes
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { readGit } from '../lib/proc-read.mjs';
import { createJobStore, enqueueJob, reattachTick, runJob } from '../lib/daemon-jobs-runtime.mjs';
import { detectSleep } from '../lib/daemon-jobs.mjs';
import { evictSnapshots, npmCiInstaller } from '../lib/daemon-job-snapshots.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { daemonJobsDir, deleteRun } from '../operations/run-store.mjs';
import {
  HEALTH_GH_PROBE_KIND, HEALTH_WATCH_JOB_CAP, HEALTH_WATCH_JOB_DAEMON, HEALTH_WATCH_JOB_KINDS, HEALTH_WATCH_JOB_SWITCHES,
} from '../../skills-src/conveyor/daemon-manifest.mjs';

const SELF = fileURLToPath(import.meta.url);
const SOURCE_ROOT_DEFAULT = resolve(SELF, '..', '..', '..');

/** A gh-probe worker that has not answered after this long is terminated and the step fails (the runtime retries). */
export const GH_PROBE_TIMEOUT_MS = 10 * 60_000;
/** Finished, consumed records older than this are pruned (record, log, result). */
export const FINISHED_JOB_KEEP_MS = 24 * 60 * 60_000;
export const RESULT_SUFFIX = '.result';
/** A finished result sampled longer ago than this is consumed but never applied: after a rollback and a later
 *  re-enable, an old job's result must not pass for the current observation (two gh cadences). */
export const MAX_RESULT_AGE_MS = 30 * 60_000;

const WORKER_MARK = 'health-gh-probe-worker';
const iso = (ms) => new Date(ms).toISOString();

/** The per-kind rollout switches: the manifest default, overridden by the health `config.json` `jobs` block. */
export function resolveHealthJobSwitches(config = {}) {
  const over = config && typeof config.jobs === 'object' && config.jobs ? config.jobs : {};
  const out = {};
  for (const [k, def] of Object.entries(HEALTH_WATCH_JOB_SWITCHES)) out[k] = typeof over[k] === 'boolean' ? over[k] : def;
  return out;
}

/** This host's monotonic clock in ms (sleep-excluding on macOS, shared by every process on the host). */
export function hostMonotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * The sleep rule across single-shot tick processes: compare this tick's wall/monotonic sample with the one the
 * previous tick persisted. A monotonic clock that went BACKWARDS means a reboot: the old sample is discarded.
 * @returns {{observation: {now: number, slept: boolean, gapMs: number}, clock: {wallMs: number, monoMs: number}}}
 */
export function observeTickClock(prevClock, cur) {
  const usable = prevClock && Number.isFinite(prevClock.wallMs) && Number.isFinite(prevClock.monoMs) && cur.monoMs >= prevClock.monoMs;
  const { slept, gapMs } = detectSleep(usable ? prevClock : null, cur);
  return { observation: { now: cur.wallMs, slept, gapMs }, clock: { wallMs: cur.wallMs, monoMs: cur.monoMs } };
}

/**
 * The `node_modules` store installer for a snapshot: an APFS clone (`cp -c`) of the daemon clone's own
 * `node_modules` when its lockfile is the one the store is keyed by (seconds), else `npm ci` (minutes).
 */
export function cloneNodeModulesInstaller(sourceRoot, { exec = execFileSync, fallback = npmCiInstaller() } = {}) {
  return (into) => {
    const src = join(sourceRoot, 'node_modules');
    let same = false;
    try { same = readFileSync(join(sourceRoot, 'package-lock.json'), 'utf8') === readFileSync(join(into, 'package-lock.json'), 'utf8'); } catch { same = false; }
    if (same && existsSync(src)) {
      try { exec('cp', ['-cR', src, join(into, 'node_modules')], { stdio: 'ignore', timeout: 5 * 60_000 }); return; } catch { /* no clonefile here */ }
      exec('cp', ['-R', src, join(into, 'node_modules')], { stdio: 'ignore', timeout: 10 * 60_000 });
      return;
    }
    fallback(into);
  };
}

function readHeadSha(sourceRoot) {
  return readGit(['-C', sourceRoot, 'rev-parse', 'HEAD'], { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function readResult(dir, id) {
  return JSON.parse(readFileSync(join(dir, `${id}${RESULT_SUFFIX}`), 'utf8'));
}

function removeJobFiles(dir, id) {
  deleteRun(id, dir);
  for (const ext of ['.log', RESULT_SUFFIX, '.json.lock']) rmSync(join(dir, `${id}${ext}`), { force: true });
}

/**
 * TICK SIDE. One pass of the gh-probe job lifecycle. Never waits on a job.
 * `drain` (a rollback: the switch is off) prunes every consumed finished record at once, so reconciliation can
 * end with no health job record left behind.
 * @param {{now: number, due: boolean, state?: {consumed?: string[], clock?: object}, input: {sourceRoot: string,
 *   skipBuildSessions?: boolean}, store?: object, kinds?: Map, maxConcurrent?: number, codeSha?: string,
 *   reattach?: Function, reattachOpts?: object, snapshot?: object, evict?: Function, wallNow?: Function,
 *   monoNow?: Function, log?: Function}} o
 * @returns {Promise<{state: object, result: {jobId: string, sampledAt: number, probes: object, errors: object}|null,
 *   failure: string|null, summary: object}>}
 */
export async function runGhProbeJobs({
  now, due, state = {}, input,
  store = createJobStore(daemonJobsDir(HEALTH_WATCH_JOB_DAEMON)), kinds = HEALTH_WATCH_JOB_KINDS,
  maxConcurrent = HEALTH_WATCH_JOB_CAP, codeSha, reattach = reattachTick, reattachOpts = {},
  snapshot, evict = evictSnapshots, wallNow = Date.now, monoNow = hostMonotonicMs, log = () => {},
  maxResultAgeMs = MAX_RESULT_AGE_MS, drain = false,
}) {
  const kind = HEALTH_GH_PROBE_KIND.kind;
  mkdirSync(store.dir, { recursive: true });
  const consumed = new Set(state?.consumed || []);
  const mine = () => store.list().records.filter((r) => r.job.kind === kind);

  // 1. Consume every finished job not consumed yet — oldest first, so the NEWEST success is the one kept.
  let result = null;
  const failures = [];
  const stale = [];
  const finished = mine().filter((r) => TERMINAL_JOB_STATUSES.includes(r.job.status) && !consumed.has(r.id))
    .sort((a, b) => Date.parse(a.job.finishedAt || 0) - Date.parse(b.job.finishedAt || 0));
  for (const r of finished) {
    consumed.add(r.id);
    if (r.job.status === 'failed') { failures.push(`job ${r.id} failed: ${r.job.error ?? 'unknown'}`); continue; }
    try {
      const res = readResult(store.dir, r.id);
      if (!Number.isFinite(res.sampledAt) || now - res.sampledAt > maxResultAgeMs) { stale.push(r.id); continue; }
      result = { jobId: r.id, sampledAt: res.sampledAt, probes: res.probes || {}, errors: res.errors || {} };
    } catch (e) { failures.push(`job ${r.id} result unreadable: ${String(e?.message || e).split('\n')[0]}`); }
  }

  // 2. Queue one when the cadence is due, nothing is in flight and nothing fresh was just consumed.
  let inFlight = mine().find((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)) ?? null;
  let enqueued = null;
  if (due && !inFlight && !result) {
    const sha = codeSha ?? readHeadSha(input.sourceRoot);
    inFlight = enqueueJob({ store, kindDef: HEALTH_GH_PROBE_KIND, codeSha: sha, now, input });
    enqueued = inFlight.id;
  }

  // 3. Reattach + admit. The sleep rule uses the wall/monotonic sample the previous tick persisted.
  const clock = observeTickClock(state?.clock, { wallMs: wallNow(), monoMs: monoNow() });
  const snap = snapshot ?? { repoDir: input.sourceRoot, install: cloneNodeModulesInstaller(input.sourceRoot) };
  const pass = await reattach({ store, kinds, maxConcurrent, observation: clock.observation, snapshot: snap, log, ...reattachOpts });

  // 4. Housekeeping: evict snapshots no live job references; prune old finished, consumed records.
  const after = store.list().records;
  const referenced = after.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)).flatMap((r) => r.job.snapshotKeys || []);
  let evicted = [];
  try { evicted = evict({ jobsDir: store.dir, referenced }).evicted; } catch (e) { log(`health-jobs: snapshot eviction failed: ${e.message}`); }
  const pruned = [];
  for (const r of after) {
    if (r.job.kind !== kind || !TERMINAL_JOB_STATUSES.includes(r.job.status) || !consumed.has(r.id)) continue;
    if (!drain && now - Date.parse(r.job.finishedAt || 0) < FINISHED_JOB_KEEP_MS) continue;
    try { removeJobFiles(store.dir, r.id); pruned.push(r.id); consumed.delete(r.id); } catch { /* next tick */ }
  }
  const left = store.list().records;
  const present = new Set(left.map((r) => r.id));
  const current = inFlight ? store.read(inFlight.id) : null;
  return {
    state: { consumed: [...consumed].filter((id) => present.has(id)), clock: clock.clock },
    result,
    failure: failures.length ? failures.join('; ') : null,
    summary: {
      consumed: result?.jobId ?? null, enqueued, stale,
      remaining: left.filter((r) => r.job.kind === kind).length,
      inFlight: current && !TERMINAL_JOB_STATUSES.includes(current.job.status)
        ? { id: current.id, status: current.job.status, attempt: current.job.attempts, handle: current.job.handle } : null,
      slept: pass?.slept ?? false, actions: pass?.actions ?? [], evicted, pruned,
    },
  };
}

// ── job child ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run the probe group in a worker thread, so this process's event loop stays free to heartbeat. Rejects on a
 * worker error, a non-zero exit, or `timeoutMs` (the worker is terminated first).
 */
export function runProbeWorker({ input, timeoutMs = GH_PROBE_TIMEOUT_MS, workerUrl = new URL(import.meta.url) }) {
  return new Promise((resolveRun, reject) => {
    const worker = new Worker(workerUrl, { workerData: { [WORKER_MARK]: true, input } });
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      // Settle first: terminating fires the worker's own 'exit', which must not be reported as a crash.
      done(reject, new Error(`gh probe worker timed out after ${timeoutMs}ms`));
      worker.terminate().catch(() => {});
    }, timeoutMs);
    worker.once('message', (msg) => done(resolveRun, msg));
    worker.once('error', (e) => done(reject, e));
    worker.once('exit', (code) => done(reject, new Error(`gh probe worker exited (${code}) without a result`)));
  });
}

/** The job's one step: probe in the worker, write the result sidecar, checkpoint its name. Idempotent. */
export async function ghProbeStep({ jobId, input, dir = process.env.OPERATION_RUNS_DIR, runWorker = runProbeWorker, now = Date.now }) {
  const sampledAt = now();
  const out = await runWorker({ input: { ...input, now: sampledAt }, timeoutMs: input?.timeoutMs ?? GH_PROBE_TIMEOUT_MS });
  const body = { jobId, sampledAt, finishedAt: now(), probes: out?.probes || {}, errors: out?.errors || {} };
  const path = join(dir, `${jobId}${RESULT_SUFFIX}`);
  writeFileSync(`${path}.tmp-${process.pid}`, `${JSON.stringify(body)}\n`);
  renameSync(`${path}.tmp-${process.pid}`, path);
  return { resultFile: `${jobId}${RESULT_SUFFIX}`, sampledAt: iso(sampledAt), errorKeys: Object.keys(body.errors) };
}

async function workerMain() {
  const { input } = workerData;
  if (input?.proofBlockMs) {
    // Live proof only (`enqueue-proof`): block THIS thread on a real synchronous subprocess, exactly the way a
    // probe's `execFileSync('gh', …)` does — so the proof exercises heartbeat continuity and process-group teardown.
    execFileSync('sleep', [String(Math.max(1, Math.round(Number(input.proofBlockMs) / 1000)))], { stdio: 'ignore' });
    parentPort.postMessage({ probes: {}, errors: {} });
    return;
  }
  const { collectGhProbes } = await import('./health-watch.mjs');
  const { scrubDeep } = await import('./health-watch-core.mjs');
  parentPort.postMessage(scrubDeep(collectGhProbes(input)));
}

async function jobMain(argv) {
  if (argv[0] === 'enqueue-proof') {
    const flags = Object.fromEntries(argv.slice(1).map((a) => { const m = /^--([^=]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a, true]; }));
    const store = createJobStore(flags['jobs-dir'] || daemonJobsDir(HEALTH_WATCH_JOB_DAEMON));
    mkdirSync(store.dir, { recursive: true });
    const rec = enqueueJob({ store, kindDef: HEALTH_GH_PROBE_KIND, codeSha: readHeadSha(SOURCE_ROOT_DEFAULT),
      input: { sourceRoot: SOURCE_ROOT_DEFAULT, proofBlockMs: Number(flags['block-ms']) || 300_000 } });
    console.log(JSON.stringify({ queued: rec.id, codeSha: rec.job.codeSha, dir: store.dir }));
    return 0;
  }
  // A graceful stop (the runtime's SIGTERM to a stalled job) takes the whole process group with it: the
  // detached spawn made this process its group leader, so the worker's `gh`/CLI children are in it too.
  process.once('SIGTERM', () => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.kill(process.pid, 'SIGKILL'); } // not a group leader: at least this process
  });
  const out = await runJob({ steps: [{ name: 'gh-probes', run: (ctx) => ghProbeStep(ctx) }] });
  console.log(`${new Date().toISOString()} health-gh-probe pid=${process.pid} ${JSON.stringify(out)}`);
  return out.outcome === 'succeeded' ? 0 : 1;
}

/** Is `argv1` this file? Compared by real path: a snapshot under a symlinked dir (macOS `/var` → `/private/var`)
 *  is spawned by its link path, while `import.meta.url` is the resolved one. */
function isEntry(argv1) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(SELF); } catch { return resolve(argv1) === SELF; }
}

// No top-level await: the worker imports health-watch.mjs, which imports THIS module — awaiting here would
// deadlock that import on this module's own unfinished evaluation.
if (!isMainThread && workerData?.[WORKER_MARK]) {
  workerMain().catch((e) => { throw e; });
} else if (isMainThread && isEntry(process.argv[1])) {
  jobMain(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (e) => { console.error(`health-gh-probe: fatal: ${e?.stack || e}`); process.exitCode = 1; });
}
