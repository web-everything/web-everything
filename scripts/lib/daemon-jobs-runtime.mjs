/**
 * @file scripts/lib/daemon-jobs-runtime.mjs
 * @description THE DAEMON JOB RUNTIME — the io half of the shared job layer (#4125, statute `#daemon-jobs`).
 *   The policy it applies is `daemon-jobs.mjs`; the record shape is `we:scripts/operations/job-record.mjs`.
 *
 *   Daemon side:
 *   - {@link createJobStore} — job records in the daemon's jobs folder (`run-store.mjs#daemonJobsDir`); every
 *     read-modify-write happens under a per-record file lock on a FRESH read, because the daemon and the
 *     job child both write the same record.
 *   - {@link probeHandle}   — `host:pid:procStart` liveness: the pid exists on this host and its start time
 *     (`LC_ALL=C ps -o lstart= -p <pid>`) matches. A reused pid reads as dead.
 *   - {@link reattachTick}  — what every daemon runs at boot and each tick: judge every record, stop stalled
 *     jobs (SIGTERM → SIGKILL → confirm gone), requeue dead ones with backoff or fail them visibly, then
 *     launch what the per-daemon cap and the serial lane admit. It never waits on a job.
 *   - {@link launchJob}     — spawn one job detached, from its pinned snapshot or its own worktree.
 *   - {@link startJobLoop}  — boot tick plus an interval, for a daemon to drop in.
 *
 *   Job side:
 *   - {@link runJob} — claim the record (refusing if it is finished or not this launch's), heartbeat, run the
 *     steps from the checkpoint, stamp each applied step, finish. Every write first checks the record still
 *     names THIS process, so a superseded child can never overwrite its replacement.
 */

import { spawn, execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { withFileLock } from './atomic-json-file.mjs';
import {
  DEFAULT_BACKOFF_BASE_MS, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_STALE_MS, DEFAULT_LAUNCH_GRACE_MS,
  SLEEP_GAP_THRESHOLD_MS, admitJobs, classifyJob, detectSleep, markClaimed, markCheckpoint, markFailed,
  markHeartbeat, markLaunching, markQueued, markRequeued, markSpawned, markStepError, markStopped, markSucceeded,
  planReattach,
} from './daemon-jobs.mjs';
import { codeRef, ensureCodeSnapshot, ensureNodeModulesStore, linkNodeModules, nodeModulesRef } from './daemon-job-snapshots.mjs';
import { TERMINAL_JOB_STATUSES, formatJobHandle, isJobRecord, normalizeProcStart, parseJobHandle } from '../operations/job-record.mjs';
import { listRunIds, newJobRunRecord, newRunId, runPath, tryReadRun, writeRun } from '../operations/run-store.mjs';

/** Env the daemon hands each job child. `OPERATION_RUNS_DIR` points the child's run store at the jobs dir. */
export const JOB_ID_ENV = 'DAEMON_JOB_ID';
export const JOB_ATTEMPT_ENV = 'DAEMON_JOB_ATTEMPT';
export const JOB_HEARTBEAT_MS_ENV = 'DAEMON_JOB_HEARTBEAT_MS';

const PS_TIMEOUT_MS = 5_000;

const iso = (ms) => new Date(ms).toISOString();

/** This host's name as a handle part (no `:` or whitespace). */
export function hostName() {
  return hostname().replace(/[\s:]/g, '-') || 'localhost';
}

/**
 * A process's start time, as `ps -o lstart=` prints it, or `null` when the pid does not exist. Bounded.
 * @param {number} pid
 * @returns {string|null}
 */
export function readProcStart(pid, { execFn = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFn('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return normalizeProcStart(out) || null;
  } catch (e) {
    if (e && e.status === 1) return null; // ps: no such process
    throw e; // a timeout or a missing `ps` is not "dead" — never relaunch on a probe that did not answer
  }
}

/**
 * Handle liveness: `'alive'` only when the pid exists on THIS host with the recorded start time.
 * @param {string} handle
 * @returns {'alive'|'dead'|'foreign'}
 */
export function probeHandle(handle, { host = hostName(), readStart = readProcStart } = {}) {
  const h = parseJobHandle(handle);
  if (!h) return 'dead';
  if (h.host !== host) return 'foreign';
  const start = readStart(h.pid);
  return start && start === h.procStart ? 'alive' : 'dead';
}

/** This process's own handle. */
export function selfHandle({ host = hostName(), readStart = readProcStart, pid = process.pid } = {}) {
  const procStart = readStart(pid);
  return { handle: formatJobHandle({ host, pid, procStart }), host, pid, procStart: normalizeProcStart(procStart) };
}

/**
 * Is this `.json` in a jobs folder well-formed JSON that is not a job record at all (an array, a primitive, or
 * an object with no `job` block)? A torn write never parses, and a record-shaped object with a bad `job` block
 * is still a record — both stay corrupt.
 */
function isForeignJson(path) {
  let v;
  try { v = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
  return v === null || typeof v !== 'object' || Array.isArray(v) || !('job' in v);
}

/**
 * The job record store for one daemon's jobs folder.
 * `update(id, fn)` runs `fn(freshRecord)` under the record's lock; `fn` returns the new record, or `null` to
 * leave it unchanged. Returns what was written (or `null`).
 * @param {string} dir
 */
export function createJobStore(dir) {
  const lockPath = (id) => `${runPath(id, dir)}.lock`;
  return {
    dir,
    read: (id) => tryReadRun(id, dir),
    create(record) {
      return withFileLock(lockPath(record.id), () => {
        if (tryReadRun(record.id, dir)) throw new Error(`daemon-jobs: job ${record.id} already exists`);
        writeRun(record, dir);
        return record;
      });
    },
    update(id, fn) {
      return withFileLock(lockPath(id), () => {
        const fresh = tryReadRun(id, dir);
        if (!fresh) return null;
        const next = fn(fresh);
        if (!next) return null;
        writeRun(next, dir);
        return next;
      });
    },
    /**
     * Every job record, plus the ids whose record would not parse (never treated as absent). A `.json` that
     * parses but is not a job record at all — a kind's own sidecar, e.g. the rebuild job's `consumed.json`
     * array — is skipped, not reported: only a torn or invalid RECORD is corrupt.
     */
    list() {
      const records = [];
      const corrupt = [];
      for (const id of listRunIds(dir)) {
        try {
          const r = tryReadRun(id, dir);
          if (r && isJobRecord(r)) records.push(r);
        } catch {
          if (!isForeignJson(runPath(id, dir))) corrupt.push(id);
        }
      }
      return { records, corrupt };
    },
  };
}

/**
 * Queue a job. The tick launches it when the cap admits it.
 * @param {{store: object, kindDef: object, input?: object, id?: string, codeSha?: string|null, now?: number}} o
 */
export function enqueueJob({ store, kindDef, input = {}, id = newRunId(`job-${kindDef.kind}`), codeSha = null, now = Date.now() }) {
  if (kindDef.codeMode === 'readonly-tree' && !codeSha) {
    throw new Error(`daemon-jobs: readonly-tree job ${kindDef.kind} needs a codeSha to pin its snapshot`);
  }
  const record = markQueued(newJobRunRecord({ id, kind: kindDef.kind, input, codeMode: kindDef.codeMode, maxAttempts: kindDef.maxAttempts, codeSha }), { at: iso(now) });
  return store.create(record);
}

/**
 * Where a job's code runs. `readonly-tree`: the pinned snapshot of `codeSha` (plus the lockfile-keyed
 * `node_modules` store when the kind wants one). `mutates-tree`: the kind's own worktree.
 * @returns {{cwd: string, snapshotKeys: string[]}}
 */
export function prepareJobCode({ store, record, kindDef, snapshot = {} }) {
  if (kindDef.codeMode === 'mutates-tree') {
    const cwd = kindDef.prepareWorktree(record);
    if (typeof cwd !== 'string' || !cwd) throw new Error(`daemon-jobs: ${kindDef.kind}.prepareWorktree returned no directory`);
    return { cwd, snapshotKeys: [] };
  }
  const { codeSha } = record.job;
  if (!codeSha) throw new Error(`daemon-jobs: readonly-tree job ${record.id} has no codeSha to pin`);
  const cwd = ensureCodeSnapshot({ jobsDir: store.dir, codeSha, repoDir: snapshot.repoDir, materialize: snapshot.materialize });
  const snapshotKeys = [codeRef(codeSha)];
  if (kindDef.nodeModules) {
    const nm = ensureNodeModulesStore({ jobsDir: store.dir, sourceDir: cwd, install: snapshot.install });
    linkNodeModules(cwd, nm.dir);
    snapshotKeys.push(nodeModulesRef(nm.key));
  }
  return { cwd, snapshotKeys };
}

/** Default spawner: a detached `node <entry>`, its output appended to `<jobsDir>/<id>.log`. */
export function spawnDetached({ entryPath, cwd, env, logPath }) {
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, [entryPath], { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/**
 * Launch one queued job: prepare its code, stamp `launching` (counting the attempt), spawn it detached.
 * Returns the written record, or `null` when the record was no longer `queued` (someone else got it).
 */
export function launchJob({ store, id, kindDef, snapshot, now = () => Date.now(), spawnFn = spawnDetached, env = process.env, heartbeatIntervalMs }) {
  const current = store.read(id);
  if (!current || current.job.status !== 'queued') return null;
  let code;
  try {
    code = prepareJobCode({ store, record: current, kindDef, snapshot });
  } catch (e) {
    return store.update(id, (r) => (r.job.status === 'queued' ? markFailed(r, { at: iso(now()), reason: `could not prepare code: ${e.message}` }) : null));
  }
  // Stamped AFTER the code is ready: a first snapshot build can take seconds, and a `launchedAt` from before
  // it would open the launch grace already spent — the next tick would call a healthy launch dead (seen live).
  const launching = store.update(id, (r) => (r.job.status === 'queued'
    ? markLaunching(r, { at: iso(now()), launcherPid: process.pid, cwd: code.cwd, snapshotKeys: code.snapshotKeys })
    : null));
  if (!launching) return null;
  const childEnv = {
    ...env,
    OPERATION_RUNS_DIR: store.dir,
    [JOB_ID_ENV]: id,
    [JOB_ATTEMPT_ENV]: String(launching.job.attempts),
    ...(heartbeatIntervalMs ? { [JOB_HEARTBEAT_MS_ENV]: String(heartbeatIntervalMs) } : {}),
  };
  let pid;
  try {
    pid = spawnFn({ entryPath: join(code.cwd, kindDef.entry), cwd: code.cwd, env: childEnv, logPath: join(store.dir, `${id}.log`) });
  } catch (e) {
    // Never launched: the attempt stays counted, the launch grace turns it into a dead launch next tick.
    return store.update(id, (r) => ({ ...r, job: { ...r.job, error: `spawn failed: ${e.message}` } }));
  }
  return store.update(id, (r) => markSpawned(r, { at: iso(now()), pid }));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop a live job: SIGTERM (plus SIGCONT, so a frozen process can act on it), wait, SIGKILL, then confirm the
 * handle is gone. Each signal is sent only while the handle still probes alive — a reused pid is never hit.
 * @returns {Promise<{gone: boolean, signal: string|null}>}
 */
export async function stopHandle(handle, {
  probe = (h) => probeHandle(h), kill = (pid, sig) => process.kill(pid, sig), termGraceMs = 5_000, killGraceMs = 5_000,
  pollMs = 100, sleep = defaultSleep,
} = {}) {
  const { pid } = parseJobHandle(handle) || {};
  if (!pid) return { gone: true, signal: null };
  const waitGone = async (budget) => {
    for (let waited = 0; waited <= budget; waited += pollMs) {
      if (probe(handle) !== 'alive') return true;
      await sleep(pollMs);
    }
    return probe(handle) !== 'alive';
  };
  const send = (sig) => { try { if (probe(handle) === 'alive') kill(pid, sig); } catch { /* raced its own exit */ } };
  if (probe(handle) !== 'alive') return { gone: true, signal: null };
  send('SIGTERM');
  send('SIGCONT');
  if (await waitGone(termGraceMs)) return { gone: true, signal: 'SIGTERM' };
  send('SIGKILL');
  return { gone: await waitGone(killGraceMs), signal: 'SIGKILL' };
}

/**
 * Tick clock for the sleep rule: each `observe()` compares the wall and monotonic gaps since the last call.
 */
export function createTickClock({ wallNow = Date.now, monoNow = () => performance.now(), thresholdMs = SLEEP_GAP_THRESHOLD_MS } = {}) {
  let prev = null;
  return {
    observe() {
      const cur = { wallMs: wallNow(), monoMs: monoNow() };
      const { slept, gapMs } = detectSleep(prev, cur, thresholdMs);
      prev = cur;
      return { now: cur.wallMs, slept, gapMs };
    },
  };
}

const sameGeneration = (a, b) => a.job.status === b.job.status && a.job.handle === b.job.handle && a.job.attempts === b.job.attempts;

/**
 * ONE reattach-and-admit pass. Run at boot and every tick.
 * @param {{store: object, kinds: Map<string, object>, maxConcurrent: number, clock?: object, observation?: object,
 *   probe?: Function, stop?: Function, launch?: Function, staleMs?: number, launchGraceMs?: number,
 *   backoffBaseMs?: number, snapshot?: object, heartbeatIntervalMs?: number, log?: Function}} o
 * @returns {Promise<{slept: boolean, gapMs: number, actions: object[], corrupt: string[]}>}
 */
export async function reattachTick({
  store, kinds, maxConcurrent, clock, observation, probe = (h) => probeHandle(h), stop = (h) => stopHandle(h, { probe }),
  launch = launchJob, staleMs = DEFAULT_HEARTBEAT_STALE_MS, launchGraceMs = DEFAULT_LAUNCH_GRACE_MS,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS, snapshot, heartbeatIntervalMs, log = () => {},
}) {
  const obs = observation ?? (clock ? clock.observe() : { now: Date.now(), slept: false, gapMs: 0 });
  const { now, slept, gapMs } = obs;
  if (slept) log(`daemon-jobs: host slept (wall-vs-monotonic gap ${Math.round(gapMs)}ms) — skipping the staleness check this tick`);
  const actions = [];
  const { records, corrupt } = store.list();
  for (const id of corrupt) log(`daemon-jobs: job record ${id} is corrupt — left untouched, fix or delete it`);

  for (const r of records) {
    const liveness = r.job.handle ? probe(r.job.handle) : null;
    const state = classifyJob(r, { now, liveness, staleMs, launchGraceMs, sleepDetected: slept });
    const kindDef = kinds.get(r.job.kind) ?? null;
    const plan = planReattach(r, state, { kindDef });
    if (plan.type === 'none') continue;
    if (plan.stopFirst) {
      const res = await stop(r.job.handle);
      if (!res.gone) {
        actions.push({ id: r.id, state, action: 'stop-failed' });
        log(`daemon-jobs: could not stop stalled job ${r.id} (${r.job.handle}) — it keeps its slot; alerting`);
        continue;
      }
      store.update(r.id, (f) => (sameGeneration(f, r) ? markStopped(f, { at: iso(Date.now()), signal: res.signal, handle: r.job.handle }) : null));
    }
    const at = iso(Date.now());
    const written = store.update(r.id, (f) => {
      if (!sameGeneration(f, r)) return null; // the child claimed or finished since we looked — re-judge next tick
      return plan.type === 'fail'
        ? markFailed(f, { at, reason: plan.reason })
        : markRequeued(f, { at, now: Date.now(), reason: plan.reason, resume: plan.resume, backoffBaseMs });
    });
    if (!written) continue;
    actions.push({ id: r.id, state, action: plan.type, reason: plan.reason });
    if (plan.type === 'fail') log(`daemon-jobs: job ${r.id} (${r.job.kind}) FAILED — ${plan.reason}`);
    else log(`daemon-jobs: job ${r.id} (${r.job.kind}) ${state} — requeued (${plan.reason})`);
  }

  const fresh = store.list().records;
  for (const id of admitJobs({ records: fresh, kinds, maxConcurrent, now })) {
    const rec = fresh.find((x) => x.id === id);
    const out = launch({ store, id, kindDef: kinds.get(rec.job.kind), snapshot, heartbeatIntervalMs });
    if (!out) continue;
    const action = out.job.status === 'failed' ? 'fail' : 'launch';
    actions.push({ id, state: 'queued', action, attempt: out.job.attempts, reason: out.job.status === 'failed' ? out.job.error : undefined });
    log(action === 'fail' ? `daemon-jobs: job ${id} FAILED — ${out.job.error}` : `daemon-jobs: launched job ${id} (${rec.job.kind}) attempt ${out.job.attempts}`);
  }
  return { slept, gapMs, actions, corrupt };
}

/**
 * Drop-in loop: one tick at boot, then one every `intervalMs`. Ticks never overlap. Returns `stop()`.
 */
export function startJobLoop({ intervalMs, onTick = () => {}, onError = () => {}, ...tickOpts }) {
  const clock = tickOpts.clock ?? createTickClock();
  let timer = null;
  let stopped = false;
  const run = async () => {
    try { onTick(await reattachTick({ ...tickOpts, clock })); } catch (e) { onError(e); }
    if (!stopped) timer = setTimeout(run, intervalMs);
  };
  run();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

// ── job side ──────────────────────────────────────────────────────────────────────────────────────────────

/** Why a child refused to run or stopped writing. */
export class JobRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Run a job's steps inside the job child. Each step is `{ name, run(ctx) }`; `run` gets
 * `{ jobId, input, data, step }` and may return an object merged into the checkpoint data. Steps MUST be
 * idempotent — a relaunch after a crash re-runs the step that was in progress.
 *
 * @returns {Promise<{outcome: 'succeeded'|'error'|'refused', code?: string, error?: string}>}
 */
export async function runJob({
  steps, env = process.env, host = hostName(), readStart = readProcStart, pid = process.pid,
  heartbeatIntervalMs = Number(env[JOB_HEARTBEAT_MS_ENV]) || DEFAULT_HEARTBEAT_INTERVAL_MS, now = () => Date.now(),
}) {
  const id = env[JOB_ID_ENV];
  const dir = env.OPERATION_RUNS_DIR;
  const attempt = Number(env[JOB_ATTEMPT_ENV]);
  if (!id || !dir || !Number.isInteger(attempt)) return { outcome: 'refused', code: 'no-job-env', error: `${JOB_ID_ENV}/${JOB_ATTEMPT_ENV}/OPERATION_RUNS_DIR not set` };
  const store = createJobStore(dir);
  const me = selfHandle({ host, readStart, pid });

  let claimed;
  try {
    claimed = store.update(id, (r) => {
      if (TERMINAL_JOB_STATUSES.includes(r.job.status)) throw new JobRefusal('already-finished', `job ${id} is already ${r.job.status}`);
      if (r.job.status !== 'launching' || r.job.attempts !== attempt) {
        throw new JobRefusal('not-this-launch', `job ${id} is ${r.job.status} at attempt ${r.job.attempts}, not launching attempt ${attempt}`);
      }
      return markClaimed(r, { at: iso(now()), ...me });
    });
  } catch (e) {
    if (e instanceof JobRefusal) return { outcome: 'refused', code: e.code, error: e.message };
    throw e;
  }
  if (!claimed) return { outcome: 'refused', code: 'no-record', error: `no job record ${id}` };

  const own = (fn) => (r) => {
    if (r.job.handle !== me.handle) throw new JobRefusal('superseded', `job ${id} no longer names this process`);
    return fn(r);
  };
  let superseded = null;
  const beat = setInterval(() => {
    try { store.update(id, own((r) => markHeartbeat(r, { at: iso(now()) }))); } catch (e) { if (e instanceof JobRefusal) superseded = e; }
  }, heartbeatIntervalMs);
  beat.unref?.();

  let record = claimed;
  try {
    for (let i = record.job.checkpoint.step; i < steps.length; i += 1) {
      if (superseded) throw superseded;
      const step = steps[i];
      let patch;
      try {
        patch = await step.run({ jobId: id, input: record.input, data: record.job.checkpoint.data, step: i });
      } catch (e) {
        store.update(id, own((r) => markStepError(r, { at: iso(now()), step: i, error: e?.message ?? e })));
        return { outcome: 'error', error: String(e?.message ?? e) };
      }
      record = store.update(id, own((r) => markCheckpoint(r, { at: iso(now()), step: i + 1, data: patch && typeof patch === 'object' ? patch : {} })));
    }
    store.update(id, own((r) => markSucceeded(r, { at: iso(now()) })));
    return { outcome: 'succeeded' };
  } catch (e) {
    if (e instanceof JobRefusal) return { outcome: 'refused', code: e.code, error: e.message };
    throw e;
  } finally {
    clearInterval(beat);
  }
}
