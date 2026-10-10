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
 *      and prunes old finished records. It never waits on a job, and it never BUILDS a snapshot: a queued job
 *      whose pinned code snapshot or `node_modules` store is cold stays `queued` (no attempt spent) while a
 *      detached `prewarm` child (this file, `prewarm` subcommand) builds it; the job launches on a later tick.
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
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { readGit } from '../lib/proc-read.mjs';
import { createJobStore, enqueueJob, launchJob, reattachTick, runJob } from '../lib/daemon-jobs-runtime.mjs';
import { detectSleep, markFailed } from '../lib/daemon-jobs.mjs';
import { ensureCodeSnapshot, ensureNodeModulesStore, evictSnapshots, npmCiInstaller, snapshotsRoot } from '../lib/daemon-job-snapshots.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { scrubText } from './health-watch-core.mjs';
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
/** The result sidecar sits in a user-writable directory, so it is untrusted input. A `sampledAt` further ahead of
 *  the tick than this (clock skew allowance) is rejected, not stored: it would park the gh cadence behind it. */
export const MAX_RESULT_FUTURE_SKEW_MS = 5 * 60_000;
/** A sidecar over this size is never parsed. Live sidecars (2026-10-09) are ~34 MB, mostly the merged-PR list, so
 *  this leaves ~7x headroom for its growth while still bounding what a corrupt file can make the tick load. */
export const MAX_RESULT_BYTES = 256 * 1024 * 1024;
/** Longest error text kept per probe. */
const MAX_RESULT_ERROR_CHARS = 2_000;
/** At most this many unexpected key names are reported back (as identifier-shaped text or `<invalid>`). */
const MAX_DROPPED_KEYS_REPORTED = 10;
/** Every probe name `collectGhProbes` can report under — the gh-cadence group. These are the ONLY keys a job
 *  result may contribute to the tick's probe set and error map, and the error-streak keys carried across queued ticks. */
export const GH_GROUP_PROBE_NAMES = Object.freeze(['prs', 'agents', 'authExpired', 'bgIsolationStalls', 'liveBindings', 'buildSessions', 'staleState', 'mergedPrs']);

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

// ── cold-snapshot prewarm: the tick never builds a snapshot ───────────────────────────────────────────────────

/** A prewarm marker still `running` after this long is a dead build (its pid was reused or it hung): counted as a failed attempt. */
export const PREWARM_MAX_MS = 25 * 60_000;
/** A failed prewarm is retried after `base * 2^(failures-1)`, up to {@link PREWARM_MAX_ATTEMPTS} failures. */
export const PREWARM_BACKOFF_BASE_MS = 60_000;
export const PREWARM_MAX_ATTEMPTS = 3;
/** After {@link PREWARM_MAX_ATTEMPTS} failures the marker is held this long (queued jobs fail visibly), then it resets and a fresh build is tried. */
export const PREWARM_FAILED_HOLD_MS = 30 * 60_000;
/** A marker written but not yet carrying the child's pid counts as live for this long. */
export const PREWARM_SPAWN_GRACE_MS = 30_000;

/** The shape the snapshot module accepts for a code sha (`daemon-job-snapshots.mjs#KEY_RE`). A `codeSha` comes from a job
 *  record on disk and becomes a marker/log file name and a CLI argument here, so it is checked before it is used as either. */
const CODE_SHA_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const isSafeCodeSha = (s) => typeof s === 'string' && CODE_SHA_RE.test(s) && !s.includes('..');

const prewarmDir = (jobsDir) => join(jobsDir, '.prewarm');
const prewarmMarkerPath = (jobsDir, codeSha) => {
  if (!isSafeCodeSha(codeSha)) throw new TypeError(`health-jobs: invalid codeSha ${JSON.stringify(codeSha)}`);
  return join(prewarmDir(jobsDir), `${codeSha}.json`);
};

/** A marker that does not parse, or whose numbers are not sane, reads as "no marker" — but a write failure never does (see {@link createWarmGate}). */
function readPrewarmMarker(jobsDir, codeSha) {
  let m;
  try { m = JSON.parse(readFileSync(prewarmMarkerPath(jobsDir, codeSha), 'utf8')); } catch { return null; }
  if (!m || (m.status !== 'running' && m.status !== 'failed')) return null;
  const num = (v) => Number.isFinite(v);
  if (m.status === 'running' && !(num(m.startedAt) && (m.pid === null || (Number.isInteger(m.pid) && m.pid > 1)))) return null;
  if (m.status === 'failed' && !num(m.failedAt)) return null;
  if (m.attempts !== undefined && !(Number.isInteger(m.attempts) && m.attempts >= 1 && m.attempts < 1000)) return null;
  return m;
}

function writePrewarmMarker(jobsDir, codeSha, body) {
  mkdirSync(prewarmDir(jobsDir), { recursive: true });
  const path = prewarmMarkerPath(jobsDir, codeSha);
  writeFileSync(`${path}.tmp-${process.pid}`, `${JSON.stringify(body)}\n`);
  renameSync(`${path}.tmp-${process.pid}`, path);
}

const pidAliveDefault = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/**
 * Build the pinned code snapshot and the lockfile-keyed `node_modules` store for `codeSha`. This is the slow work
 * (`git archive`, a `node_modules` clone or `npm ci`: minutes cold) that must NEVER run inside the health tick, whose
 * watchdog kills it at 180 s; the detached `prewarm` child runs it instead. Idempotent: a finished snapshot is returned as is.
 * @param {{jobsDir: string, codeSha: string, snapshot: {repoDir?: string, materialize?: Function, install?: Function}, nodeModules?: boolean}} o
 */
export function prewarmSnapshots({ jobsDir, codeSha, snapshot, nodeModules = true }) {
  const cwd = ensureCodeSnapshot({ jobsDir, codeSha, repoDir: snapshot.repoDir, materialize: snapshot.materialize });
  if (nodeModules) ensureNodeModulesStore({ jobsDir, sourceDir: cwd, install: snapshot.install });
  return cwd;
}

const COLD = Symbol('snapshot-cold');
const cold = () => { throw COLD; };

/**
 * Is the snapshot for `codeSha` already built? Answered through the snapshot module's own `ensure*` with a builder
 * that refuses to build, so the completeness marker stays that module's private business: a finished build returns
 * without calling the builder, a missing one throws {@link COLD}. Cheap (a few stats and one lockfile read).
 */
export function snapshotWarm({ jobsDir, codeSha, nodeModules = true }) {
  try {
    const cwd = ensureCodeSnapshot({ jobsDir, codeSha, materialize: cold });
    if (nodeModules) ensureNodeModulesStore({ jobsDir, sourceDir: cwd, install: cold });
    return true;
  } catch {
    return false; // cold (the builder was refused) or unreadable: either way the prewarm child, not the tick, deals with it
  }
}

/**
 * Make sure a detached prewarm is running (or backing off, or has given up) for `codeSha`. Single flight: a marker
 * whose pid is alive and younger than {@link PREWARM_MAX_MS} means one is already building. Never waits on it.
 * @returns {{state: 'started'|'warming'|'backoff'|'failed', error?: string, attempts?: number}}
 */
export function requestPrewarm({
  jobsDir, codeSha, sourceRoot, now = Date.now(), spawnFn = spawnPrewarm, pidAlive = pidAliveDefault,
}) {
  if (!isSafeCodeSha(codeSha)) return { state: 'failed', error: `invalid codeSha ${JSON.stringify(String(codeSha).slice(0, 40))}`, attempts: 0 };
  let marker = readPrewarmMarker(jobsDir, codeSha);
  if (marker?.status === 'running') {
    // pid null: the tick wrote the marker, then spawned; the pid is patched in right after (a crash between leaves null → ages out below).
    const alive = marker.pid === null ? now - marker.startedAt < PREWARM_SPAWN_GRACE_MS : pidAlive(marker.pid);
    if (alive && now - marker.startedAt < PREWARM_MAX_MS) return { state: 'warming', attempts: marker.attempts ?? 1 };
    // Died without recording an outcome (or hung past the max age): a failed attempt like any other, with its backoff.
    marker = { codeSha, status: 'failed', attempts: marker.attempts ?? 1, failedAt: now, error: 'prewarm build died without finishing' };
    writePrewarmMarker(jobsDir, codeSha, marker);
  }
  let failures = 0;
  if (marker?.status === 'failed') {
    failures = marker.attempts ?? 1;
    const lastError = marker.error ?? 'unknown';
    const since = now - (marker.failedAt ?? 0);
    if (failures >= PREWARM_MAX_ATTEMPTS) {
      if (since < PREWARM_FAILED_HOLD_MS) return { state: 'failed', error: lastError, attempts: failures };
      failures = 0; // held long enough: a fresh round of attempts
    } else if (since < PREWARM_BACKOFF_BASE_MS * 2 ** (failures - 1)) {
      return { state: 'backoff', error: lastError, attempts: failures };
    }
  }
  const attempts = failures + 1;
  // The marker goes down BEFORE the spawn: if it cannot be written nothing was started (the caller fails the job
  // visibly), and a crash after the spawn still leaves a single-flight record instead of a child per tick.
  const startedAt = now;
  writePrewarmMarker(jobsDir, codeSha, { codeSha, status: 'running', pid: null, startedAt, attempts });
  let pid;
  try {
    pid = spawnFn({ jobsDir, codeSha, sourceRoot });
  } catch (e) {
    const error = `could not start the prewarm build: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`;
    writePrewarmMarker(jobsDir, codeSha, { codeSha, status: 'failed', attempts, failedAt: now, error });
    return { state: 'backoff', error, attempts };
  }
  const cur = readPrewarmMarker(jobsDir, codeSha); // the child may already have finished or failed: never overwrite its outcome
  if (cur?.status === 'running' && cur.startedAt === startedAt && Number.isInteger(pid) && pid > 1) {
    writePrewarmMarker(jobsDir, codeSha, { ...cur, pid });
  }
  return { state: 'started', attempts };
}

/** Default prewarm spawner: a detached `node health-watch-job.mjs prewarm …` from the daemon clone, output appended to a log. */
function spawnPrewarm({ jobsDir, codeSha, sourceRoot }) {
  mkdirSync(prewarmDir(jobsDir), { recursive: true });
  const fd = openSync(join(prewarmDir(jobsDir), `${codeSha}.log`), 'a');
  try {
    const child = spawn(process.execPath, [SELF, 'prewarm', `--sha=${codeSha}`, `--source-root=${sourceRoot}`, `--jobs-dir=${jobsDir}`],
      { cwd: sourceRoot, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => {}); // an async spawn failure (bad cwd, ENOENT) must not crash the tick; the marker ages out into a failed attempt
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/**
 * The `launch` the tick hands the runtime's reattach pass: it launches a queued job only once its OWN pinned
 * snapshot is warm. A cold one starts (or keeps) a detached prewarm and leaves the job `queued`, no attempt spent,
 * so the tick returns at once. After repeated prewarm failures the queued job fails visibly instead of waiting forever.
 */
export function createWarmGate({
  jobsDir, sourceRoot, kinds = HEALTH_WATCH_JOB_KINDS, isWarm = snapshotWarm, requestPrewarm: request = requestPrewarm,
  launchFn = launchJob, now = Date.now, drain = false,
}) {
  const warming = [];
  const launch = (o) => {
    const { store, id } = o;
    const rec = store.read(id);
    const kindDef = o.kindDef ?? kinds.get(rec?.job.kind);
    if (!rec || rec.job.status !== 'queued' || kindDef?.codeMode !== 'readonly-tree') return launchFn(o);
    const { codeSha } = rec.job;
    const nodeModules = !!kindDef.nodeModules;
    const failJob = (reason) => store.update(id, (r) => (r.job.status === 'queued' ? markFailed(r, { at: iso(now()), reason: `could not prepare code: ${reason}` }) : null));
    if (!isSafeCodeSha(codeSha)) { warming.push({ id, codeSha: null, state: 'failed', error: 'invalid codeSha' }); return failJob('the queued job has no valid codeSha to pin'); }
    if (isWarm({ jobsDir, codeSha, nodeModules })) return launchFn(o);
    // A rollback drains work; it must not start a multi-minute build for a job that will only be consumed and pruned.
    if (drain) { warming.push({ id, codeSha, state: 'failed', error: 'rollback' }); return failJob('rollback with a cold snapshot (not building it)'); }
    let asked;
    try {
      asked = request({ jobsDir, codeSha, sourceRoot, now: now() });
    } catch (e) { // e.g. the marker cannot be written: nothing was started, so say so and back off instead of aborting the whole pass
      asked = { state: 'backoff', error: `prewarm request failed: ${String(e?.message || e).split('\n')[0].slice(0, 200)}` };
    }
    warming.push({ id, codeSha, state: asked.state, ...(asked.error ? { error: asked.error } : {}) });
    if (asked.state !== 'failed') return null;
    return failJob(`prewarm failed after ${asked.attempts ?? PREWARM_MAX_ATTEMPTS} attempt(s): ${asked.error}`);
  };
  return { launch, warming };
}

/**
 * Eviction without the slow part. The shared {@link evictSnapshots} `rm -rf`s whole snapshot trees (a `node_modules` store is tens
 * of thousands of files; a code snapshot is evicted on every HEAD change) — synchronous work that does not belong inside the
 * health tick. This picks the victims with the shared selection (`dryRun`), RENAMES each into `.snapshots/.trash/` (atomic, O(1)),
 * and lets a detached `sweep-trash` child delete them. The names under `code/` and `node-modules/` vanish at once, so a later
 * prewarm of the same key builds fresh rather than reusing a half-deleted tree.
 */
export function evictToTrash({ jobsDir, referenced, spawnSweep = spawnTrashSweep, now = Date.now }) {
  const { evicted } = evictSnapshots({ jobsDir, referenced, dryRun: true });
  const root = snapshotsRoot(jobsDir);
  const trash = join(root, '.trash');
  const moved = [];
  for (const ref of evicted) {
    const [type, key] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    const sub = type === 'code' ? 'code' : type === 'node-modules' ? 'node-modules' : null;
    if (!sub || !isSafeCodeSha(key)) continue; // an unknown ref shape is left alone, never guessed at
    mkdirSync(trash, { recursive: true });
    try { renameSync(join(root, sub, key), join(trash, `${sub}-${key}.${now()}`)); moved.push(ref); } catch { /* gone already, or next tick */ }
  }
  if (moved.length) { try { spawnSweep({ jobsDir }); } catch { /* the leftovers are swept by the next eviction that moves something */ } }
  return { evicted: moved };
}

/** The `sweep-trash` child's work: delete everything under `.snapshots/.trash/`. Returns how many entries went. */
export function sweepTrash({ jobsDir }) {
  const trash = join(snapshotsRoot(jobsDir), '.trash');
  let n = 0;
  for (const name of existsSync(trash) ? readdirSync(trash) : []) { rmSync(join(trash, name), { recursive: true, force: true }); n += 1; }
  return n;
}

function spawnTrashSweep({ jobsDir }) {
  const child = spawn(process.execPath, [SELF, 'sweep-trash', `--jobs-dir=${jobsDir}`], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function readHeadSha(sourceRoot) {
  return readGit(['-C', sourceRoot, 'rev-parse', 'HEAD'], { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function readResult(dir, id, maxBytes = MAX_RESULT_BYTES) {
  const file = join(dir, `${id}${RESULT_SUFFIX}`);
  const size = statSync(file).size;
  if (size > maxBytes) throw new Error(`too large (${size} bytes, cap ${maxBytes})`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a parsed result sidecar before any of it reaches the tick. Pure: returns the cleaned result, or why it
 * was rejected. `probes` / `errors` are rebuilt from the gh-group allowlist alone — an own `__proto__`, `processes`
 * or `daemonLogs` key can never be assigned onto the tick's probe set — and `sampledAt` must be a finite number no
 * further ahead of `now` than the skew allowance.
 * @returns {{ok: true, sampledAt: number, probes: object, errors: object, dropped: string[]}|{ok: false, reason: string}}
 */
export function validateJobResult(res, { now, maxFutureSkewMs = MAX_RESULT_FUTURE_SKEW_MS } = {}) {
  if (!isPlainObject(res)) return { ok: false, reason: 'invalid result (not an object)' };
  if (typeof res.sampledAt !== 'number' || !Number.isFinite(res.sampledAt)) return { ok: false, reason: 'invalid result (sampledAt is not a finite number)' };
  if (res.sampledAt - now > maxFutureSkewMs) return { ok: false, reason: `invalid result (sampledAt ${Math.round((res.sampledAt - now) / 1000)}s in the future)` };
  if (res.probes !== undefined && !isPlainObject(res.probes)) return { ok: false, reason: 'invalid result (probes is not an object)' };
  if (res.errors !== undefined && !isPlainObject(res.errors)) return { ok: false, reason: 'invalid result (errors is not an object)' };
  const allowed = new Set(GH_GROUP_PROBE_NAMES);
  const probes = {};
  const errors = {};
  const unexpected = new Set();
  for (const k of Object.keys(res.probes || {})) {
    if (allowed.has(k)) probes[k] = res.probes[k]; else unexpected.add(k);
  }
  for (const k of Object.keys(res.errors || {})) {
    if (!allowed.has(k)) { unexpected.add(k); continue; }
    // As the inline path does: first line only, credential-shaped text redacted.
    if (typeof res.errors[k] === 'string') errors[k] = scrubText(res.errors[k].split('\n')[0]).slice(0, MAX_RESULT_ERROR_CHARS);
  }
  // Key names are untrusted text: only identifier-shaped ones are ever echoed, and only a handful of them.
  const dropped = [...unexpected].slice(0, MAX_DROPPED_KEYS_REPORTED).map((k) => (/^[A-Za-z0-9_$]{1,64}$/.test(k) ? k : '<invalid>'));
  // A sample can be no newer than the tick that reads it: clamping the allowed skew means a slightly-future
  // `sampledAt` can never be stored as `ghCache.at` and outlast its cadence.
  return { ok: true, sampledAt: Math.min(res.sampledAt, now), probes, errors, dropped: [...new Set(dropped)] };
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
  snapshot, evict = evictToTrash, wallNow = Date.now, monoNow = hostMonotonicMs, log = () => {},
  maxResultAgeMs = MAX_RESULT_AGE_MS, maxResultBytes = MAX_RESULT_BYTES, drain = false, warmGate = {},
}) {
  const kind = HEALTH_GH_PROBE_KIND.kind;
  mkdirSync(store.dir, { recursive: true });
  const consumed = new Set(state?.consumed || []);
  const mine = () => store.list().records.filter((r) => r.job.kind === kind);

  // 1. Consume every finished job not consumed yet — oldest first, so the NEWEST success is the one kept.
  let result = null;
  const failures = [];
  const stale = [];
  const dropped = [];
  const finished = mine().filter((r) => TERMINAL_JOB_STATUSES.includes(r.job.status) && !consumed.has(r.id))
    .sort((a, b) => Date.parse(a.job.finishedAt || 0) - Date.parse(b.job.finishedAt || 0));
  for (const r of finished) {
    consumed.add(r.id);
    if (r.job.status === 'failed') { failures.push(`job ${r.id} failed: ${r.job.error ?? 'unknown'}`); continue; }
    try {
      const res = validateJobResult(readResult(store.dir, r.id, maxResultBytes), { now });
      if (!res.ok) { failures.push(`job ${r.id} ${res.reason}`); continue; }
      if (res.dropped.length) { dropped.push(...res.dropped.filter((k) => !dropped.includes(k))); log(`health-jobs: job ${r.id} result carried unexpected keys, dropped ${res.dropped.length}: ${res.dropped.join(', ')}`); }
      if (now - res.sampledAt > maxResultAgeMs) { stale.push(r.id); continue; }
      result = { jobId: r.id, sampledAt: res.sampledAt, probes: res.probes, errors: res.errors };
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
  // The tick never builds a snapshot: a queued job whose pinned snapshot is cold waits for a detached prewarm.
  const gate = createWarmGate({ jobsDir: store.dir, sourceRoot: input.sourceRoot, kinds, drain, ...warmGate });
  const pass = await reattach({ store, kinds, maxConcurrent, observation: clock.observation, snapshot: snap, log, launch: gate.launch, ...reattachOpts });

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
      consumed: result?.jobId ?? null, enqueued, stale, dropped,
      remaining: left.filter((r) => r.job.kind === kind).length,
      inFlight: current && !TERMINAL_JOB_STATUSES.includes(current.job.status)
        ? { id: current.id, status: current.job.status, attempt: current.job.attempts, handle: current.job.handle } : null,
      slept: pass?.slept ?? false, actions: pass?.actions ?? [], evicted, pruned, warming: gate.warming,
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

const parseFlags = (args) => Object.fromEntries(args.map((a) => { const m = /^--([^=]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a, true]; }));

/**
 * The `prewarm` child: build the snapshot, then clear the marker; on failure record it for the tick's backoff.
 * @returns {number} the exit code
 */
export function prewarmMain({
  jobsDir, codeSha, sourceRoot, now = Date.now, snapshot = { repoDir: sourceRoot, install: cloneNodeModulesInstaller(sourceRoot) },
}) {
  if (!isSafeCodeSha(codeSha)) { console.error(`prewarm: invalid --sha ${JSON.stringify(String(codeSha).slice(0, 40))}`); return 2; }
  const attempts = readPrewarmMarker(jobsDir, codeSha)?.attempts ?? 1;
  try {
    prewarmSnapshots({ jobsDir, codeSha, snapshot });
    rmSync(prewarmMarkerPath(jobsDir, codeSha), { force: true });
    return 0;
  } catch (e) {
    const error = String(e?.message || e).split('\n')[0].slice(0, 300);
    writePrewarmMarker(jobsDir, codeSha, { codeSha, status: 'failed', attempts, failedAt: now(), error });
    console.error(`${new Date().toISOString()} health-gh-probe prewarm ${codeSha} failed: ${error}`);
    return 1;
  }
}

async function jobMain(argv) {
  if (argv[0] === 'sweep-trash') {
    const flags = parseFlags(argv.slice(1));
    if (!flags['jobs-dir']) { console.error('sweep-trash: --jobs-dir is required'); return 2; }
    sweepTrash({ jobsDir: flags['jobs-dir'] });
    return 0;
  }
  if (argv[0] === 'prewarm') {
    const flags = parseFlags(argv.slice(1));
    if (!flags.sha || !flags['source-root'] || !flags['jobs-dir']) { console.error('prewarm: --sha, --source-root and --jobs-dir are required'); return 2; }
    return prewarmMain({ jobsDir: flags['jobs-dir'], codeSha: flags.sha, sourceRoot: flags['source-root'] });
  }
  if (argv[0] === 'enqueue-proof') {
    const flags = parseFlags(argv.slice(1));
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
