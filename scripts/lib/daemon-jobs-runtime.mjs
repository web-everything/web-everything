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
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import {
  DEFAULT_BACKOFF_BASE_MS, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_STALE_MS, DEFAULT_LAUNCH_GRACE_MS,
  SLEEP_GAP_THRESHOLD_MS, admitJobs, classifyJob, detectSleep, markClaimed, markCheckpoint, markFailed,
  markHeartbeat, markLaunching, markQueued, markRequeued, markSpawned, markStepError, markStopped, markSucceeded,
  planReattach, taskDeadlineDecision,
} from './daemon-jobs.mjs';
import { codeRef, ensureCodeSnapshot, ensureNodeModulesStore, evictSnapshots, linkNodeModules, nodeModulesRef } from './daemon-job-snapshots.mjs';
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

let cachedLocalHostAliases;

/** Names of this machine as sanitized handle parts. Default discovery is cached once per process. */
export function localHostAliases({ host = hostName(), platform = process.platform, execFn = execFileSync } = {}) {
  const useCache = arguments[0] === undefined || Object.keys(arguments[0]).length === 0;
  if (useCache && cachedLocalHostAliases) return cachedLocalHostAliases;
  const aliases = new Set();
  const add = (name) => {
    const sanitized = name.replace(/[\s:]/g, '-');
    if (sanitized) aliases.add(sanitized);
  };
  const addLocal = (name) => {
    if (!name) return;
    add(name);
    add(`${name}.local`);
  };
  add(host);
  addLocal(host.split('.')[0]);
  if (platform === 'darwin') {
    for (const key of ['LocalHostName', 'ComputerName']) {
      try {
        const name = execFn('scutil', ['--get', key], {
          timeout: PS_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (key === 'LocalHostName') addLocal(name);
        else add(name);
      } catch { /* An unavailable macOS name does not prevent probing known local names. */ }
    }
  }
  if (useCache) cachedLocalHostAliases = aliases;
  return aliases;
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
 * Handle liveness: identity is proven by pid + start time. The host check only prevents probing a
 * different machine's pid here; an old name of THIS machine is still this machine.
 * `'alive'` only when the local pid exists with the recorded start time.
 * @param {string} handle
 * @returns {'alive'|'dead'|'foreign'}
 */
export function probeHandle(handle, { host = hostName(), aliases = null, readStart = readProcStart } = {}) {
  const h = parseJobHandle(handle);
  if (!h) return 'dead';
  const hostArgGiven = arguments[1]?.host !== undefined;
  const local = aliases ?? (hostArgGiven ? new Set([host]) : localHostAliases());
  if (h.host !== host && !local.has(h.host)) return 'foreign';
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
    /**
     * {@link list} without re-reading history. Returns `{ live, done, corrupt }`: `live` is every NON-terminal job
     * record in full (fresh from disk, same objects `list()` would give); `done` is `project(record)` for every
     * TERMINAL one; `corrupt` is exactly `list().corrupt`. A terminal record is parsed once per process: a cached
     * projection is reused only while the file's inode, size, mtime and ctime are unchanged, and a record write is
     * always temp-file + rename (new inode), so a changed record can never be served stale. Corrupt or foreign
     * files are never cached and are re-judged on every call, and a file that vanishes mid-scan is skipped, as in
     * `list()`. `project` must be pure and return read-only data; `projectKey` names it for the cache.
     */
    scan(project, projectKey = 'default') {
      return scanJobStore(dir, project, projectKey);
    },
  };
}

const scanCaches = new Map();
function scanJobStore(dir, project, projectKey) {
  const cacheKey = `${dir}\0${projectKey}`;
  let cache = scanCaches.get(cacheKey);
  if (!cache) scanCaches.set(cacheKey, cache = new Map());
  const live = [];
  const done = [];
  const corrupt = [];
  const seen = new Set();
  for (const id of listRunIds(dir)) {
    const path = runPath(id, dir);
    let st;
    try { st = statSync(path, { bigint: true, throwIfNoEntry: false }); } catch { st = undefined; }
    if (!st) continue; // gone since the listing: absent, exactly as tryReadRun reports it
    seen.add(id);
    const sig = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    const hit = cache.get(id);
    if (hit && hit.sig === sig) { done.push(hit.projected); continue; }
    cache.delete(id);
    try {
      const r = tryReadRun(id, dir); // the signature was taken BEFORE this read, so a newer file only costs a re-read
      if (!r || !isJobRecord(r)) continue;
      if (TERMINAL_JOB_STATUSES.includes(r.job.status)) {
        const projected = project(r);
        cache.set(id, { sig, projected });
        done.push(projected);
      } else live.push(r);
    } catch {
      if (!isForeignJson(path)) corrupt.push(id);
    }
  }
  for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
  return { live, done, corrupt };
}

/**
 * {@link createJobStore}'s `scan`, falling back to `list()` for a store without one (test doubles), with the
 * same `{ live, done, corrupt }` result.
 */
export function scanStore(store, project, projectKey) {
  if (typeof store.scan === 'function') return store.scan(project, projectKey);
  const { records, corrupt } = store.list();
  const live = [];
  const done = [];
  for (const r of records) {
    if (TERMINAL_JOB_STATUSES.includes(r.job.status)) done.push(project(r));
    else live.push(r);
  }
  return { live, done, corrupt };
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
 * Launch one queued job: prepare its code, stamp `launching` (counting the attempt), spawn it detached,
 * record its child, then evict idle snapshots best-effort.
 * Returns the written record, or `null` when the record was no longer `queued` (someone else got it).
 */
export function launchJob({ store, id, kindDef, snapshot, evict = evictSnapshots, now = () => Date.now(), spawnFn = spawnDetached, env = process.env, heartbeatIntervalMs }) {
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
  const spawned = store.update(id, (r) => markSpawned(r, { at: iso(now()), pid }));
  // Housekeeping runs only after the child exists and its pid is durable: a recursive snapshot delete
  // can outlast the tick watchdog, but must never strand a launching record without a spawned child.
  try {
    const { live: records, corrupt } = scanStore(store, () => null, 'live-only');
    // An unreadable record may belong to a live child whose snapshot references are unknown.
    // Fail closed until the record is repaired; the new child is already durably spawned.
    if (corrupt.length > 0) return spawned;
    const referenced = records.flatMap((r) => r.job.snapshotKeys);
    evict({ jobsDir: store.dir, referenced });
  } catch { /* Snapshot cleanup is best-effort; the child is already spawned and recorded. */ }
  return spawned;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop a live job and its subprocesses: SIGTERM (plus SIGCONT, so a frozen process can act on it), wait, SIGKILL,
 * then confirm the handle is gone. Each signal is sent only while the handle still probes alive — a reused pid is never hit.
 * @returns {Promise<{gone: boolean, signal: string|null}>}
 */
export async function stopHandle(handle, {
  probe = (h) => probeHandle(h), kill = (pid, sig) => process.kill(pid, sig), termGraceMs = 5_000, killGraceMs = 5_000,
  pollMs = 100, sleep = defaultSleep, requireConfirmedDeath = false,
} = {}) {
  const { pid } = parseJobHandle(handle) || {};
  if (!pid) return { gone: !requireConfirmedDeath, signal: null };
  const observe = () => {
    try { return probe(handle); } catch (error) {
      if (requireConfirmedDeath) return 'unknown';
      throw error;
    }
  };
  const isGone = state => requireConfirmedDeath ? state === 'dead' : state !== 'alive';
  const waitGone = async (budget) => {
    for (let waited = 0; waited <= budget; waited += pollMs) {
      if (isGone(observe())) return true;
      await sleep(pollMs);
    }
    return isGone(observe());
  };
  // Every signal goes to the job's process group (a detached launch leads one), so no subprocess outlives the
  // job; a handle that leads no group is signalled by pid. Subprocesses the job starts after SIGTERM (its own
  // cleanup, e.g. a lane release) are spared it, and the grace lets them finish.
  const send = (sig) => {
    try {
      if (observe() !== 'alive') return;
      try { kill(-pid, sig); } catch { kill(pid, sig); }
    } catch { /* raced its own exit */ }
  };
  // Once the job pid is gone, SIGKILL whatever is left of its group (a grandchild the job did not wait for).
  // While any member lives the group id stays reserved, so it cannot name a newer process.
  const sweepGroup = () => { try { kill(-pid, 0); kill(-pid, 'SIGKILL'); } catch { /* no group left */ } };
  const initial = observe();
  if (initial !== 'alive') return { gone: isGone(initial), signal: null };
  send('SIGTERM');
  send('SIGCONT');
  if (await waitGone(termGraceMs)) { sweepGroup(); return { gone: true, signal: 'SIGTERM' }; }
  send('SIGKILL');
  const gone = await waitGone(killGraceMs);
  if (gone) sweepGroup();
  return { gone, signal: 'SIGKILL' };
}

/** Start times (ms) of every process in group `pgid`, or null when `ps` did not answer. */
export function readGroupStarts(pgid, { execFn = execFileSync } = {}) {
  try {
    const out = execFn('ps', ['-A', '-o', 'pgid=,lstart='], {
      env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.+)$/)).filter((m) => m && Number(m[1]) === pgid).map((m) => Date.parse(m[2]));
  } catch { return null; }
}

/** This host's boot time (ms), or null when unknown. */
export function readBootTime({ execFn = execFileSync, readFile = readFileSync } = {}) {
  try {
    if (process.platform === 'linux') {
      const s = Number(readFile('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
      return Number.isFinite(s) ? s * 1000 : null;
    }
    const s = Number(execFn('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: PS_TIMEOUT_MS }).match(/sec = (\d+)/)?.[1]);
    return Number.isFinite(s) ? s * 1000 : null;
  } catch { return null; }
}

/**
 * A job whose pid died on its own (crash, OOM kill) can leave its subprocesses running in its process group.
 * SIGKILL that group before the job is requeued or failed — only when it is provably the job's own: the pid is
 * unused, the host has not rebooted since the job started, and every member started between the job's start
 * and `notAfterMs` (when it was last known alive, plus the staleness window). A group whose id was reused
 * after the job died has members started later, so it is never touched. Anything unreadable skips the reap.
 * With requireConfirmedDeath, true means the group is confirmed absent (including after SIGKILL),
 * not merely signalled. Refusal, unreadable evidence, and pending exit all return false for a later tick.
 * @returns {boolean} whether a leftover group was killed, or confirmed absent in strict mode
 */
export function reapDeadGroup(handle, {
  notAfterMs, host = hostName(), aliases = null, readStart = readProcStart, groupStarts = readGroupStarts,
  bootTime = readBootTime, kill = (pid, sig) => process.kill(pid, sig), requireConfirmedDeath = false,
} = {}) {
  const h = parseJobHandle(handle);
  if (!h?.pid) return false;
  const local = aliases ?? (arguments[1]?.host !== undefined ? new Set([host]) : localHostAliases());
  if (h.host !== host && !local.has(h.host)) return false;
  const groupGone = () => {
    try { kill(-h.pid, 0); return false; } catch (error) { return error?.code === 'ESRCH' ? true : null; }
  };
  if (requireConfirmedDeath) {
    const gone = groupGone();
    if (gone !== false) return gone === true;
  }
  if (!Number.isFinite(notAfterMs)) return false;
  try { if (readStart(h.pid)) return false; } catch { return false; }
  const startedMs = Date.parse(h.procStart);
  let boot, members;
  try { boot = bootTime(); } catch { return false; }
  if (!Number.isFinite(startedMs) || !Number.isFinite(boot) || boot > startedMs) return false;
  try { members = groupStarts(h.pid); } catch { return false; }
  if (!members?.length || members.some((t) => !Number.isFinite(t) || t < startedMs - 1000 || t > notAfterMs)) return false;
  try {
    kill(-h.pid, 'SIGKILL');
    return requireConfirmedDeath ? groupGone() === true : true;
  } catch (error) { return requireConfirmedDeath && error?.code === 'ESRCH'; }
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

/** Publish from authoritative per-attempt evidence, under the same lock as child writes.
 * Output corruption is repairable; these files must never enter root run enumeration.
 */
function repairTaskResults(store, id, guard = fn => fn) {
  return store.update(id, guard(r => {
    const results = r.job.task?.execution?.results;
    if (!results || !Object.keys(results).length) return null;
    let changed = false;
    mkdirSync(join(store.dir, 'results'), { recursive: true });
    for (const [attempt, result] of Object.entries(results)) {
      const ref = `results/${id}-${attempt}.json`;
      let published;
      try { published = JSON.parse(readFileSync(join(store.dir, ref), 'utf8')); } catch { /* repair */ }
      if (JSON.stringify(published) !== JSON.stringify(result)) writeJsonAtomic(join(store.dir, ref), result);
      if (Number(attempt) === r.job.attempts && r.job.task.resultRef !== ref) {
        r.job.task.resultRef = ref;
        changed = true;
      }
    }
    return changed ? r : null;
  }));
}

/** Complete a saved semantic attempt without replay or another failure charge. */
function completeTaskResult(r, { at, now, backoffBaseMs }) {
  const result = r.job.task.execution?.results?.[r.job.attempts];
  if (!result) throw new JobRefusal('task-incomplete', 'task semantic completion is required before job success');
  if (result.outcome !== 'failed') return markSucceeded(r, { at });
  if (r.job.task.failureCount >= r.job.maxAttempts) {
    return markFailed(r, { at, reason: result.reason ?? result.outcome });
  }
  return markRequeued(r, { at, now, backoffBaseMs, resume: false, reason: result.reason ?? result.outcome });
}

/**
 * ONE reattach-and-admit pass. Run at boot and every tick.
 * @param {{store: object, kinds: Map<string, object>, maxConcurrent: number, clock?: object, observation?: object,
 *   probe?: Function, stop?: Function, launch?: Function, staleMs?: number, launchGraceMs?: number, reapGroup?: Function,
 *   // reapGroup(handle, cutoff, { requireConfirmedDeath: true }) must return true only for confirmed absence.
 *   releaseTaskClaim?: (record: object) => void, // synchronous, attempt-scoped port; must throw on refusal
 *   deadlineAt?: (record: object) => number|null, backoffBaseMs?: number, snapshot?: object, heartbeatIntervalMs?: number, log?: Function}} o
 * @returns {Promise<{slept: boolean, gapMs: number, actions: object[], corrupt: string[]}>}
 */
export async function reattachTick({
  store, kinds, maxConcurrent, clock, observation, probe = (h) => probeHandle(h), stop = (h, o = {}) => stopHandle(h, { probe, ...o }),
  launch = launchJob, staleMs = DEFAULT_HEARTBEAT_STALE_MS, launchGraceMs = DEFAULT_LAUNCH_GRACE_MS,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS, snapshot, heartbeatIntervalMs, log = () => {}, deadlineAt = () => null,
  releaseTaskClaim = () => {},
  reapGroup = (h, notAfterMs, options) => reapDeadGroup(h, { ...options, notAfterMs }),
}) {
  const obs = observation ?? (clock ? clock.observe() : { now: Date.now(), slept: false, gapMs: 0 });
  const { now, slept, gapMs } = obs;
  const tryReleaseTaskClaim = record => {
    try { releaseTaskClaim(record); return true; } catch (error) {
      log(`daemon-jobs: cannot release task claim ${record.id} — retains owner and slot; inspect claim before recovery: ${error?.message ?? String(error)}`);
      return false;
    }
  };
  if (slept) log(`daemon-jobs: host slept (wall-vs-monotonic gap ${Math.round(gapMs)}ms) — skipping the staleness check this tick`);
  const actions = [];
  const confirmTaskGroupGone = (record, state) => {
    if (!record.job.handle) return true; // unclaimed launch; no process group was recorded
    const lastAliveMs = Date.parse(record.job.heartbeatAt ?? record.job.startedAt ?? '');
    try {
      if (reapGroup(record.job.handle, lastAliveMs + staleMs, { requireConfirmedDeath: true }) === true) return true;
    } catch { /* unavailable cleanup evidence retains exclusion too */ }
    actions.push({ id: record.id, state, action: 'stop-failed' });
    log(`daemon-jobs: cannot confirm task process group gone ${record.id} (${record.job.handle}) — retains claim and slot; inspect group before recovery`);
    return false;
  };
  const { records, corrupt } = store.list();
  for (const id of corrupt) log(`daemon-jobs: job record ${id} is corrupt — left untouched, fix or delete it`);

  for (let r of records) {
    // Repair even terminal records, before classifyJob's terminal shortcut.
    if (r.job.task?.execution?.results) r = repairTaskResults(store, r.id) ?? r;
    const isTask = Object.hasOwn(r.job, 'task');
    const observeOwner = () => {
      try { return probe(r.job.handle); } catch (error) {
        if (isTask) return 'unknown';
        throw error;
      }
    };
    const liveness = r.job.handle ? observeOwner() : null;
    const state = classifyJob(r, { now, liveness, staleMs, launchGraceMs, sleepDetected: slept });
    const taskDeadline = isTask ? taskDeadlineDecision(r, { now }) : null;
    const deadline = isTask ? taskDeadline?.deadlineAt : deadlineAt(r);
    const expired = Number.isFinite(deadline) && now >= deadline && state !== 'terminal' && (isTask || state !== 'foreign');
    const savedResult = r.job.task?.execution?.results?.[r.job.attempts];
    if (savedResult && state !== 'terminal' && state !== 'queued' && state !== 'waiting' && (liveness === 'dead' || !expired)) {
      if (liveness !== 'dead') continue; // publication does not revoke a live/unknown owner
      if (!confirmTaskGroupGone(r, state)) continue;
      store.update(r.id, f => {
        if (!sameGeneration(f, r)) return null;
        if (!tryReleaseTaskClaim(f)) return null;
        return completeTaskResult(f, { at: iso(now), now, backoffBaseMs });
      });
      continue;
    }
    const kindDef = kinds.get(r.job.kind) ?? null;
    const plan = isTask && (expired || state === 'dead' || state === 'stalled')
      ? { type: !kindDef || r.job.task.failureCount + 1 >= r.job.maxAttempts ? 'fail' : 'requeue',
        stopFirst: !!r.job.handle && (expired || state === 'stalled'), resume: kindDef?.resumable,
        reason: expired ? 'task deadline exceeded' : state === 'dead' ? 'handle dead' : 'heartbeat stale on a live pid' }
      : expired ? { type: 'fail', stopFirst: liveness === 'alive',
        reason: `deadline exceeded; ${r.job.attempts}/${r.job.maxAttempts} attempts; last error: ${r.job.error ?? 'not completed'}` }
        : planReattach(r, state, { kindDef });
    // Unknown task ownership never enters the unclaimed-launch recovery path.
    if (isTask && r.job.handle && state !== 'terminal' && liveness !== 'alive' && liveness !== 'dead') {
      actions.push({ id: r.id, state, action: 'stop-failed' });
      log(`daemon-jobs: cannot confirm task owner ${r.id} (${r.job.handle}) — retains claim and slot; inspect owner before recovery`);
      continue;
    }
    if (plan.type === 'none') continue;
    const lastAliveMs = Date.parse(r.job.heartbeatAt ?? r.job.startedAt ?? '');
    let stopped;
    if (plan.stopFirst) {
      const res = await stop(r.job.handle, {
        ...(kindDef?.stopGraceMs ? { termGraceMs: kindDef.stopGraceMs } : {}),
        ...(isTask ? { requireConfirmedDeath: true } : {}),
      });
      if (!res.gone || (isTask && observeOwner() !== 'dead')) {
        actions.push({ id: r.id, state, action: 'stop-failed' });
        log(`daemon-jobs: could not stop stalled job ${r.id} (${r.job.handle}) — it keeps its slot; alerting`);
        continue;
      }
      stopped = { at: iso(Date.now()), signal: res.signal, handle: r.job.handle };
      if (!isTask) store.update(r.id, (f) => (sameGeneration(f, r) ? markStopped(f, stopped) : null));
    }
    // The owner can die after the tick's probe but before stopHandle's first observation. Reap after
    // stopping too, using the dead-group identity checks before releasing exclusion or requeuing.
    if (isTask) {
      if (!confirmTaskGroupGone(r, state)) continue;
    } else if ((liveness === 'dead' || stopped) && Number.isFinite(lastAliveMs) && reapGroup(r.job.handle, lastAliveMs + staleMs)) {
      log(`daemon-jobs: job ${r.id} died with subprocesses still running — killed its process group`);
    }
    const at = iso(Date.now());
    const written = store.update(r.id, (f) => {
      if (!sameGeneration(f, r)) return null; // the child claimed or finished since we looked — re-judge next tick
      if (isTask) {
        // Synchronous claim port under the record lock: a concurrent finish/new attempt wins.
        if (!tryReleaseTaskClaim(f)) return null;
        if (stopped) f = markStopped(f, stopped);
        // stop() can await a semantic completion without changing handle, attempt or status.
        if (f.job.task.execution?.results?.[f.job.attempts]) return completeTaskResult(f, { at, now, backoffBaseMs });
        f = { ...f, job: { ...f.job, task: { ...f.job.task,
          failureCount: f.job.task.failureCount + 1, outcome: 'failed' } } };
      }
      return plan.type === 'fail'
        ? markFailed(f, { at, reason: plan.reason })
        : markRequeued(f, { at, now: isTask ? now : Date.now(), reason: plan.reason, resume: plan.resume, backoffBaseMs });
    });
    if (!written) continue;
    if (isTask && written.job.task.execution?.results?.[written.job.attempts]) {
      repairTaskResults(store, r.id);
      continue;
    }
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
    if (!r || r.job.handle !== me.handle || (claimed.job.task && (r.job.attempts !== attempt || r.job.status !== 'running'))) throw new JobRefusal('superseded', `job ${id} no longer names this process`);
    return fn(r);
  };
  const task = claimed.job.task ? { task: claimed.job.task, attempt, handle: me.handle,
    record: { read: () => own(r => r)(store.read(id)), update: fn => store.update(id, own(fn)) } } : undefined;
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
        patch = await step.run({ jobId: id, input: record.input, data: record.job.checkpoint.data, step: i, ...(task ? { task } : {}) });
      } catch (e) {
        store.update(id, own((r) => markStepError(r, { at: iso(now()), step: i, error: e?.message ?? e })));
        return { outcome: 'error', error: String(e?.message ?? e) };
      }
      record = store.update(id, own((r) => markCheckpoint(r, { at: iso(now()), step: i + 1, data: patch && typeof patch === 'object' ? patch : {} })));
    }
    if (task) repairTaskResults(store, id, own);
    const finished = store.update(id, own((r) => task ? completeTaskResult(r, { at: iso(now()), now: now() }) : markSucceeded(r, { at: iso(now()) })));
    return finished.job.status === 'succeeded' ? { outcome: 'succeeded' } : { outcome: 'error', error: finished.job.task.outcome };
  } catch (e) {
    if (e instanceof JobRefusal) return { outcome: 'refused', code: e.code, error: e.message };
    throw e;
  } finally {
    clearInterval(beat);
  }
}
