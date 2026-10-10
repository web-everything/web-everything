#!/usr/bin/env node
/**
 * @file scripts/conveyor/verify-gate-job.mjs
 * @description #4135 (decision 4120, statute `#daemon-jobs`) — each lane's verify gate runs as a DETACHED DURABLE
 *   JOB on the shared job runtime (we:scripts/lib/daemon-jobs-runtime.mjs), not as a child the verify daemon holds.
 *
 *   Before: the daemon spawned `verify-lane.mjs` itself and kept the run in an in-memory registry. A gate's two
 *   ceilings, its kill and its settlement lived in the daemon's own process, so the daemon could not restart
 *   while a gate ran without losing them: a code-change restart waited for the registry to empty (live 2026-10-09:
 *   the clone moved at 23:15:02Z and the daemon kept running the old code until a hand SIGTERM at 00:23:55Z, with
 *   4–5 gates in flight the whole time), a SIGTERM hand-off left adopted gates with no ceilings and no verdict
 *   line, and a crash or `kill -9` lost the registry entirely (the next daemon re-dispatched a lane whose gate was
 *   still running).
 *
 *   Now the gate's supervisor is its own process — this file, run as the job's entry from a pinned code snapshot.
 *   It runs the SAME `runLaneGate` the in-process sweep uses (same ceilings, same marker ownership, same
 *   infrastructure-failure stamp), keyed by (lane dir, runId, headSha), heartbeats its job record, and writes the
 *   outcome next to it. The daemon only queues jobs and reads records; a restart re-attaches by reading the store.
 *
 *   One file, two roles:
 *   1. TICK SIDE — {@link createVerifyGateJobs}: `launch()` queues a job (the dispatch sweep's `launchGate`);
 *      `sync(inFlight)` runs the runtime's reattach pass (launch queued jobs, stop stalled ones, relaunch dead
 *      ones once), rebuilds the daemon's in-flight registry from live records, and consumes each finished job
 *      once, logging its verdict. It never waits on a gate.
 *   2. JOB CHILD — {@link runGateStep}: refuses to run beside a previous attempt's gate that is not proven gone
 *      (kills it first when its handle proves it alive), re-checks that the marker is still this request, records
 *      the gate (`<id>.gate`, written BEFORE the spawn and found by its `--run-id` until the pid lands), runs it,
 *      writes `<id>.result`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execRead, readGit } from '../lib/proc-read.mjs';

import { defineJobKind, kindRegistry } from '../lib/daemon-jobs.mjs';
import {
  createJobStore, createTickClock, enqueueJob, probeHandle, readProcStart, reattachTick, runJob, stopHandle,
  hostName, JOB_ID_ENV, JOB_ATTEMPT_ENV, JOB_HEARTBEAT_MS_ENV,
} from '../lib/daemon-jobs-runtime.mjs';
import { evictSnapshots } from '../lib/daemon-job-snapshots.mjs';
import { TERMINAL_JOB_STATUSES, formatJobHandle, parseJobHandle } from '../operations/job-record.mjs';
import { daemonJobsDir, deleteRun } from '../operations/run-store.mjs';
import { cloneNodeModulesInstaller } from '../lib/daemon-rebuild/rebuild-job.mjs';
import { laneNeedsVerifyDispatch, runLaneGate, readLaneState, gateCeilings } from './verify-dispatch.mjs';

const SELF = fileURLToPath(import.meta.url);
const CLONE_ROOT = resolve(dirname(SELF), '..', '..');

/** Env switch: `0` keeps the old in-process gate (rollback); anything else runs gates as jobs. */
export const VERIFY_GATE_AS_JOB_ENV = 'WE_VERIFY_GATE_AS_JOB';
export const GATE_SUFFIX = '.gate';
export const RESULT_SUFFIX = '.result';
// Not `.json`: the run store lists every `*.json` in the jobs dir as a job record (and calls this one corrupt).
const CONSUMED_FILE = 'consumed.ids';
/** A consumed job's files are kept this long for diagnosis, then removed. */
export const FINISHED_GATE_JOB_KEEP_MS = 6 * 60 * 60_000;

export const VERIFY_GATE_JOB_KIND = defineJobKind({
  kind: 'verify-gate',
  entry: 'scripts/conveyor/verify-gate-job.mjs',
  codeMode: 'readonly-tree',
  nodeModules: true,
  // A relaunch only happens when the SUPERVISOR died (the gate's own result is never retried — a killed gate is an
  // infrastructure failure that needs diagnosis). The relaunch re-checks the marker before running anything.
  maxAttempts: 2,
});
export const VERIFY_GATE_JOB_KINDS = kindRegistry([VERIFY_GATE_JOB_KIND]);

/** Are gates jobs? Default on; `WE_VERIFY_GATE_AS_JOB=0` restores the in-process gate. */
export function resolveGateAsJob(env = process.env) {
  return env?.[VERIFY_GATE_AS_JOB_ENV] !== '0';
}

/** `~/.claude/daemon-jobs/verify-daemon` (the #4125 location; `WE_DAEMON_JOBS_ROOT` moves the parent). */
export function verifyJobsDir(env = process.env) {
  return daemonJobsDir('verify-daemon', env);
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
// Write-then-rename: a crash mid-write must not leave a truncated sidecar that reads back as "no gate".
const writeJson = (path, value) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
};
export const gatePath = (dir, id) => join(dir, `${id}${GATE_SUFFIX}`);
export const resultPath = (dir, id) => join(dir, `${id}${RESULT_SUFFIX}`);

/**
 * PURE: classify a settled gate the way the in-process sweep's `settle` does — exit 0 green, exit 2 red (a normal
 * verdict, not a failure), a ceiling kill `timed-out`, anything else `failed`.
 * @param {{ok:boolean, error?:object}} r
 */
export function classifyGateOutcome({ ok, error }) {
  if (ok) return { outcome: 'green' };
  if (error?.timedOutPhase) return { outcome: 'timed-out', timedOutPhase: error.timedOutPhase };
  if (Number(error?.status) === 2) return { outcome: 'red' };
  return { outcome: 'failed', status: Number.isFinite(error?.status) ? error.status : null, signal: error?.signal ?? null,
    message: String(error?.message || error || '').split('\n')[0] };
}

/**
 * PURE: is the lane's marker still the request this job serves? Same identity rules as the in-process registry:
 * `running` for the lane's own HEAD, and either stamped by our `runId` or still the request we observed.
 */
export function markerStillOurs(marker, headSha, input) {
  if (!laneNeedsVerifyDispatch(marker, headSha) || marker.sha !== input.headSha) return false;
  if (marker.runId && marker.runId === input.runId) return true;
  return !!input.requestStartedAt && marker.startedAt === input.requestStartedAt;
}

const queuedMs = (r, now) => { const t = Date.parse(r.job.timeline?.[0]?.at || ''); return Number.isFinite(t) ? t : now(); };

// ── tick side ───────────────────────────────────────────────────────────────────────────────────────────────

function readHeadOf(root) {
  return readGit(['-C', root, 'rev-parse', 'HEAD'], {
    timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

/** Does a process with this pid exist? Fails closed: only a definite ESRCH says no. */
export function pidExistsDefault(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== 'ESRCH'; }
}

/** Does process group `pgid` still have a member? Fails closed like {@link pidExistsDefault}. */
export function groupExistsDefault(pgid) {
  return pidExistsDefault(-pgid);
}

const RUN_ID_RE = /^[\w.-]{1,128}$/;

/**
 * The pids of processes started with `--run-id=<runId>` (the gate is `node verify-lane.mjs … --run-id=<runId>`).
 * Throws when `ps` does not answer — a scan that did not run is never "no such gate".
 */
export function findGatePidsDefault(runId) {
  return psCommands().filter(({ command }) => command.split(/\s+/).includes(`--run-id=${runId}`)).map(({ pid }) => pid);
}

/**
 * The pids of dispatched gates on lane `dir`, whoever started them: a process carrying the exact `--repo=<dir>`
 * token next to a `--run-id=` token (every dispatched `verify-lane.mjs` gate has both; an agent's `request`/`check`
 * has no run id). Throws when `ps` does not answer.
 */
export function findLaneGatePidsDefault(dir) {
  return psCommands().filter(({ command }) => {
    const padded = ` ${command} `;
    return padded.includes(` --repo=${dir} `) && / --run-id=\S/.test(padded);
  }).map(({ pid }) => pid);
}

function psCommands() {
  const out = execRead('ps', ['-axww', '-o', 'pid=,command='], { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m && Number(m[1]) !== process.pid) rows.push({ pid: Number(m[1]), command: m[2] });
  }
  return rows;
}

/**
 * Is a recorded gate still running? `alive` and `dead` are proven by the handle (`host:pid:procStart`, so never a
 * reused pid); `dead` also needs the gate's process GROUP gone. Everything else is `unknown`, which callers treat as
 * "may still be running": a probe that throws, a handle from another host, a leader that is gone while its group
 * still has members, and a sidecar with no usable handle (start time unreadable at spawn) whose pid still exists. A `pending` sidecar (written BEFORE the spawn; its supervisor died before recording the pid) is found by
 * its run id: `unknown` while any process carries it (or the scan fails), `dead` once none does. No sidecar, or
 * one with no pid, no handle and no pending run id, records no gate: `dead`.
 */
export function gateState(gate, {
  probe = probeHandle, pidExists = pidExistsDefault, scan = findGatePidsDefault, groupExists = groupExistsDefault,
} = {}) {
  if (!gate) return 'dead';
  // The gate is a process GROUP (verify-lane leads it; its test runners share it). A leader that is gone while its
  // group still exists (crash, OOM, a kill of the leader alone) is not a dead gate: a second gate must not start
  // beside the surviving members. Never killed on that basis either — the group id alone proves no identity.
  const groupGone = (pid) => {
    if (!Number.isInteger(pid) || pid <= 1) return 'dead';
    try { return groupExists(pid) ? 'unknown' : 'dead'; } catch { return 'unknown'; }
  };
  const parsed = gate.handle ? parseJobHandle(gate.handle) : null;
  if (parsed) {
    try {
      const s = probe(gate.handle);
      if (s === 'alive') return 'alive';
      if (s !== 'dead') return 'unknown';
      // The leader is provably gone. If its pid already belongs to another process, our group is gone too (a pid is
      // never handed out while it is a live process group's id), so that group, if any, is not ours.
      return pidExists(parsed.pid) ? 'dead' : groupGone(parsed.pid);
    } catch { return 'unknown'; }
  }
  const pid = Number(gate.pid);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      if (!pidExists(pid)) return groupGone(pid);
      // No handle, so the pid alone may be reused. A sidecar naming its run id can tell: the gate's argv carries
      // `--run-id=<runId>`, and a pid without it is another process (our group, sharing that id, is gone with it).
      if (!RUN_ID_RE.test(String(gate.runId ?? ''))) return 'unknown';
      return scan(gate.runId).includes(pid) ? 'unknown' : 'dead';
    } catch { return 'unknown'; }
  }
  if (!gate.pending) return 'dead';
  if (!RUN_ID_RE.test(String(gate.runId ?? ''))) return 'unknown';
  try { return scan(gate.runId).length > 0 ? 'unknown' : 'dead'; } catch { return 'unknown'; }
}

/** The gate process recorded by a job's supervisor: `{gate, state, alive}` ({@link gateState}; `alive` = proven alive). */
export function liveGate(dir, id, {
  probe = probeHandle, pidExists = pidExistsDefault, scan = findGatePidsDefault, groupExists = groupExistsDefault,
} = {}) {
  const g = readJson(gatePath(dir, id));
  const state = gateState(g, { probe, pidExists, scan, groupExists });
  return { gate: g, state, alive: state === 'alive' };
}

/**
 * SIGKILL a recorded gate's process group. The pid comes from the probed handle (never the bare `pid` field alone),
 * must agree with that field, and must be an ordinary pid (> 1): a corrupt or stale sidecar must not turn into
 * `kill(-1)` or a kill of an unrelated group. Returns whether a kill was attempted.
 */
export function killGateGroup(gate, kill = process.kill.bind(process)) {
  const pid = gatePid(gate);
  if (!pid) return false;
  try { kill(-pid, 'SIGKILL'); } catch {}
  return true;
}

/** The recorded gate's pid when it is trustworthy (parsed from the handle, agrees with the `pid` field, > 1); else null. */
export function gatePid(gate) {
  const pid = parseJobHandle(gate?.handle)?.pid;
  return Number.isInteger(pid) && pid > 1 && pid === gate.pid ? pid : null;
}

/**
 * The daemon's handle on its gate jobs.
 * @param {{store?:object, cloneRoot?:string, log?:(m:string)=>void, maxConcurrent?:number, reattach?:Function,
 *   snapshot?:object, readHead?:()=>string, probe?:Function, now?:()=>number, onSettled?:(f:object)=>void,
 *   evict?:Function, kill?:Function}} o
 */
export function createVerifyGateJobs({
  store = createJobStore(verifyJobsDir()), cloneRoot = CLONE_ROOT, log = (m) => process.stderr.write(`${m}\n`),
  maxConcurrent = 8, reattach = reattachTick, snapshot, readHead = () => readHeadOf(cloneRoot), probe = probeHandle,
  now = () => Date.now(), onSettled = () => {}, evict = evictSnapshots, kill = process.kill.bind(process),
  pidExists = pidExistsDefault, scan = findGatePidsDefault, groupExists = groupExistsDefault,
} = {}) {
  mkdirSync(store.dir, { recursive: true });
  const kind = VERIFY_GATE_JOB_KIND.kind;
  const clock = createTickClock();
  const snap = snapshot ?? { repoDir: cloneRoot, install: cloneNodeModulesInstaller(cloneRoot) };
  const startLogged = new Set();
  const survivorLogged = new Set();
  // A dead handle never comes back (its start time is part of it), nor does a finished job's pending gate once no
  // process carries its run id (nothing relaunches a finished job): skip re-probing either each tick.
  const goneHandles = new Set();
  /** A finished job's gate that may still run: `{gate, state}` with state `alive` or `unknown` ({@link gateState}); null once provably gone. */
  const survivorOf = (id) => {
    const gate = readJson(gatePath(store.dir, id));
    const key = gate?.handle || (gate?.pending ? `pending:${id}:${gate.runId}` : null);
    if (!gate || (key && goneHandles.has(key))) return null;
    const state = gateState(gate, { probe, pidExists, scan, groupExists });
    if (state === 'dead') { if (key) goneHandles.add(key); return null; }
    return { gate, state };
  };
  const mine = () => store.list().records.filter((r) => r.job.kind === kind);
  /** The registry entry for a job's lane — one shape for live jobs and held survivors. `pid` only when proven alive. */
  const entryFor = (r, pid, prev) => {
    const input = r.input;
    return {
      pool: input.pool, lane: input.lane, dir: input.dir, runId: input.runId, sha: input.headSha,
      suites: input.suites ?? null, treeHash: input.treeHash ?? null, requestStartedAt: input.requestStartedAt ?? null,
      jobId: r.id, pid, startedMs: prev?.startedMs ?? queuedMs(r, now), keptFor: prev?.keptFor,
    };
  };
  const consumedPath = join(store.dir, CONSUMED_FILE);
  const readConsumed = () => new Set(readJson(consumedPath) || []);

  return {
    dir: store.dir,
    /** The dispatch sweep's `launchGate`: queue one gate job (launched by the next {@link sync}). */
    launch({ pool, lane, dir, headSha, marker, runId }) {
      return enqueueJob({
        store, kindDef: VERIFY_GATE_JOB_KIND, codeSha: readHead(), now: now(),
        input: { pool, lane, dir, headSha, runId, suites: marker?.suites ?? null, treeHash: marker?.treeHash ?? null,
          requestStartedAt: marker?.startedAt ?? null },
      });
    },
    /**
     * One reattach pass, then rebuild `inFlight` from the store and consume finished jobs once. Never waits on a gate.
     * @param {Map<string, object>} inFlight
     */
    async sync(inFlight) {
      let pass = null;
      try {
        pass = await reattach({ store, kinds: VERIFY_GATE_JOB_KINDS, maxConcurrent, clock, snapshot: snap,
          log: (m) => log(`verify-daemon: ${m}`) });
      } catch (e) {
        log(`verify-daemon: gate-job reattach pass failed (${String(e?.message || e).split('\n')[0]}) — the next tick retries`);
      }
      const listing = store.list();
      const records = listing.records.filter((r) => r.job.kind === kind);
      // A record that will not parse is never "removed": its entry (and the lane) stays held until it reads again.
      const live = new Set(listing.corrupt || []);
      // Every live job and held survivor of each lane, whichever entry the registry shows: when the job owning a lane's
      // entry ends, another holder takes the lane over in this same sync, never one tick later (a dispatch in between,
      // e.g. a rollback's in-process gate, would start beside it).
      const holders = new Map();
      const holdLane = (dir, r, pid, prev) => {
        if (!holders.has(dir)) holders.set(dir, entryFor(r, pid, prev?.jobId === r.id ? prev : undefined));
      };
      const consumed = readConsumed();
      const settled = [];
      for (const r of records) {
        const input = r.input || {};
        if (!input.dir) continue;
        if (!TERMINAL_JOB_STATUSES.includes(r.job.status)) {
          live.add(r.id);
          // A probe that throws (ps timeout) must not abort the whole sync: treat the gate as not yet seen this tick.
          const { gate, alive } = liveGate(store.dir, r.id, { probe, pidExists, scan, groupExists }); // a throwing probe reads as `unknown`, not an abort
          const prev = inFlight.get(input.dir);
          holdLane(input.dir, r, alive ? gatePid(gate) : null, prev);
          if (prev && prev.jobId !== r.id && !prev.jobId) continue; // a legacy (adopted) run still owns this lane
          inFlight.set(input.dir, entryFor(r, alive ? gatePid(gate) : null, prev));
          if (gate?.gateStartedAt && alive && !startLogged.has(r.id)) {
            startLogged.add(r.id);
            log(`  ▶ gate started for ${input.pool}/lane-${input.lane} @ ${String(input.headSha).slice(0, 8)} — ${gate.gateStartedAt} (job ${r.id}, pid ${gate.pid})`);
          }
          continue;
        }
        // A finished job's gate can outlive it (the supervisor refused to start a second gate beside a survivor, or died
        // for good with its gate running). The lane stays occupied until that gate is gone — otherwise the next dispatch
        // queues a fresh job with no gate sidecar and starts a second gate beside the survivor. Retry the kill each tick.
        const survivor = survivorOf(r.id);
        if (survivor) {
          live.add(r.id); // its sidecar must outlive the prune below even when another job's entry owns the lane
          // Only a PROVEN-alive gate puts a pid in the registry: the supersede path kills any entry pid without
          // re-probing, so an `unknown` survivor holds the lane with no pid (no proof the handle is still this gate,
          // a kill could hit a reused pid).
          const pid = survivor.state === 'alive' ? gatePid(survivor.gate) : null;
          const killed = survivor.state === 'alive' && killGateGroup(survivor.gate, kill);
          if (!survivorLogged.has(r.id)) {
            survivorLogged.add(r.id);
            log(`verify-daemon: gate job ${r.id} for ${input.pool}/lane-${input.lane} is finished but its gate pid ${survivor.gate.pid} may still be alive (${survivor.state}) — lane held${killed ? ', killing it each tick' : ', NOT killed (no trustworthy pid / unprobeable)'}`);
          }
          const prev = inFlight.get(input.dir);
          holdLane(input.dir, r, pid, prev);
          if (!prev || prev.jobId === r.id) inFlight.set(input.dir, entryFor(r, pid, prev));
        }
        if (consumed.has(r.id)) continue;
        consumed.add(r.id);
        startLogged.delete(r.id);
        const res = readJson(resultPath(store.dir, r.id));
        const where = `${input.pool}/lane-${input.lane} @ ${String(input.headSha).slice(0, 8)}`;
        let failure = null;
        if (r.job.status === 'failed') {
          log(`verify-daemon: gate job ${r.id} for ${where} FAILED — ${r.job.error ?? 'unknown'}`);
          failure = { pool: input.pool, lane: input.lane, sha: input.headSha, jobFailed: true };
        } else if (!res) {
          log(`verify-daemon: gate job ${r.id} for ${where} finished with no result`);
        } else {
          const verdict = res.marker ? ` — marker ${res.marker.status}${res.marker.sha ? ` @ ${String(res.marker.sha).slice(0, 8)}` : ''}` : '';
          log(`verify-daemon: gate job ${r.id} for ${where} settled: ${res.outcome}${res.timedOutPhase ? ` (${res.timedOutPhase}-phase ceiling)` : ''}${verdict} [attempt ${r.job.attempts}]`);
          if (res.outcome === 'timed-out') failure = { pool: input.pool, lane: input.lane, sha: input.headSha, timedOut: true, timedOutPhase: res.timedOutPhase };
          else if (res.outcome === 'failed') failure = { pool: input.pool, lane: input.lane, sha: input.headSha };
        }
        settled.push({ id: r.id, ...input, outcome: res?.outcome ?? r.job.status });
        if (failure) { try { onSettled(failure); } catch {} }
      }
      // Drop registry entries whose job is no longer live (finished, consumed, or removed by hand) — unless another live
      // job or survivor still holds that lane, which takes the entry over.
      for (const [dir, entry] of inFlight) {
        if (!entry.jobId || live.has(entry.jobId)) continue;
        if (holders.has(dir)) inFlight.set(dir, holders.get(dir));
        else inFlight.delete(dir);
      }
      for (const [dir, entry] of holders) if (!inFlight.has(dir)) inFlight.set(dir, entry);
      // Housekeeping: prune consumed jobs past the keep window; evict snapshots no live job references.
      for (const r of records) {
        if (!TERMINAL_JOB_STATUSES.includes(r.job.status) || !consumed.has(r.id) || live.has(r.id)) continue;
        if (now() - Date.parse(r.job.finishedAt || 0) < FINISHED_GATE_JOB_KEEP_MS) continue;
        try { deleteRun(r.id, store.dir); } catch {}
        for (const ext of ['.log', GATE_SUFFIX, RESULT_SUFFIX, '.json.lock']) rmSync(join(store.dir, `${r.id}${ext}`), { force: true });
        consumed.delete(r.id);
      }
      try { writeJson(consumedPath, [...consumed]); } catch {}
      const referenced = records.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)).flatMap((r) => r.job.snapshotKeys || []);
      try { evict({ jobsDir: store.dir, referenced }); } catch (e) { log(`verify-daemon: snapshot eviction failed: ${e.message}`); }
      return { actions: pass?.actions ?? [], live: live.size, settled };
    },
    /** `restartInFlight: kill` only — stop every live supervisor (its SIGTERM handler kills its gate group). */
    async stopAll({ stop = stopHandle, kill = process.kill.bind(process) } = {}) {
      for (const r of mine()) {
        if (TERMINAL_JOB_STATUSES.includes(r.job.status)) continue;
        if (r.job.handle) { try { await stop(r.job.handle); } catch {} }
        // Probe AFTER the stop (which may itself have ended the gate): never signal on a stale proof.
        const { gate, alive } = liveGate(store.dir, r.id, { probe, pidExists, scan, groupExists });
        if (alive) killGateGroup(gate, kill);
      }
    },
    /**
     * The dispatch sweep's supersede kill for a gate JOB's entry: re-read the job's sidecar and signal its group
     * only when the handle proves, right now, that it is still the gate. The registry `pid` was proven at the last
     * sync; by the time a newer request supersedes the entry the gate may have exited and its pid been reused.
     * @returns {boolean} whether a kill was attempted
     */
    killJobGate(entry) {
      if (!entry?.jobId) return false;
      const { gate, alive } = liveGate(store.dir, entry.jobId, { probe, pidExists, scan, groupExists });
      return alive ? killGateGroup(gate, kill) : false;
    },
  };
}

// ── job child ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The job's one step. Idempotent across a relaunch: a surviving gate from a previous attempt is killed (its
 * handle is checked, never a bare pid; one that survives the kill refuses the run with a `failed` result), and
 * nothing runs unless the marker is still this request.
 * @param {{jobId:string, input:object, jobsDir:string, attempt?:number, log?:(m:string)=>void, runGate?:typeof runLaneGate,
 *   laneState?:(dir:string)=>{marker:object|null, headSha:string|null}, probe?:Function, readStart?:Function,
 *   kill?:Function, onGate?:(pid:number)=>void}} o
 */
export async function runGateStep({
  jobId, input, jobsDir, attempt = 1, log = (m) => process.stderr.write(`${m}\n`), runGate = runLaneGate,
  laneState = readLaneState, probe = probeHandle, readStart = readProcStart, kill = process.kill.bind(process),
  onGate = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pidExists = pidExistsDefault,
  scan = findGatePidsDefault, groupExists = groupExistsDefault,
  listJobs = () => createJobStore(jobsDir).list(), scanLane = findLaneGatePidsDefault,
}) {
  const where = `${input.pool}/lane-${input.lane} @ ${String(input.headSha).slice(0, 8)}`;
  const finish = (result) => {
    const full = { ...result, attempt, finishedAt: new Date().toISOString(), ...gateCeilings() };
    writeJson(resultPath(jobsDir, jobId), full);
    log(`[verify-gate-job ${jobId}] ${full.finishedAt} ${where}: ${full.outcome}`);
    return { outcome: full.outcome };
  };

  // 1. A previous attempt's gate that outlived its supervisor: stop it before anything else runs on this lane.
  // Only a PROVEN-dead gate lets the run go on: `unknown` (a probe that threw, a foreign-host handle, a sidecar with
  // no usable handle whose pid still exists) is refused, and never killed (no proof the pid is still that gate).
  // A `pending` sidecar (the previous supervisor died before recording its gate's pid) is found by its run id.
  const prior = liveGate(jobsDir, jobId, { probe, pidExists, scan, groupExists });
  let state = prior.state;
  if (state === 'alive') {
    log(`[verify-gate-job ${jobId}] attempt ${attempt}: previous gate pid ${prior.gate.pid} still alive — killing its group`);
    killGateGroup(prior.gate, kill);
    for (let i = 0; i < 50; i += 1) {
      state = gateState(prior.gate, { probe, pidExists, scan, groupExists });
      if (state !== 'alive') break;
      await sleep(100);
    }
    // A bounded kill attempt is not proof of death: never start a second gate beside one that still owns the marker.
    if (state === 'alive') state = gateState(prior.gate, { probe, pidExists, scan, groupExists });
  }
  if (state !== 'dead') {
    const which = prior.gate?.pid ? `pid ${prior.gate.pid}` : `(unrecorded pid, run ${prior.gate?.runId ?? '?'})`;
    const message = state === 'alive'
      ? `previous gate ${which} survived SIGKILL; refusing to start a second gate on this lane`
      : `previous gate ${which} cannot be proven gone (liveness unknown); refusing to start a second gate on this lane`;
    log(`[verify-gate-job ${jobId}] attempt ${attempt}: ${message}`);
    return finish({ outcome: 'failed', status: null, signal: null, message });
  }

  // 2. Run nothing unless the marker is still this request (a relaunch may find it settled or superseded).
  const { marker, headSha } = laneState(input.dir);
  if (!markerStillOurs(marker, headSha, input)) {
    return finish({ outcome: 'stale', marker: marker ? { status: marker.status, sha: marker.sha ?? null, runId: marker.runId ?? null } : null,
      headSha: headSha ?? null });
  }

  // 3. Record the gate BEFORE spawning it: a supervisor that dies between the spawn and the pid write must not leave
  // a gate no sidecar names (the relaunch and the tick would read "no gate" and start a second one beside it). The
  // pending sidecar carries the run id the gate is spawned with (`--run-id=`), so it is found by that until the pid lands,
  // and the lane, so a check from another job can scope it even when that job's own record will not parse.
  const pendingRec = { pid: null, handle: null, pending: true, runId: input.runId, dir: input.dir, at: new Date().toISOString(), attempt };
  try {
    writeJson(gatePath(jobsDir, jobId), pendingRec);
  } catch (e) {
    return finish({ outcome: 'failed', status: null, signal: null,
      message: `could not record the gate before spawning it (${String(e?.message || e).split('\n')[0]}); not started` });
  }

  // 3b. Nor beside ANY other gate on this lane: another job's survivor (a daemon that dispatched before its first sync,
  // a second daemon on the same store), or a gate no sidecar names (another store, a rolled-back in-process sweep).
  // Checked only AFTER our own pending record is down: two jobs starting together each see the other's, and the
  // earlier one wins ({@link otherLaneGate}). Only proven gone lets the run go on; such a gate is never killed from
  // here (it is not this job's to signal).
  const blocker = otherLaneGate({ jobId, input, own: pendingRec, jobsDir, listJobs, scanLane, probe, pidExists, scan, groupExists });
  if (blocker) {
    const message = `${blocker}; refusing to start a second gate on this lane`;
    log(`[verify-gate-job ${jobId}] attempt ${attempt}: ${message}`);
    // No longer pending: a record that names no gate, so no other job's check waits on this one.
    try { writeJson(gatePath(jobsDir, jobId), { pid: null, handle: null, runId: input.runId, dir: input.dir, refused: true, at: new Date().toISOString(), attempt }); } catch {}
    return finish({ outcome: 'failed', status: null, signal: null, message });
  }

  // 4. The gate — the same code, ceilings and settlement as the in-process sweep.
  // The record is kept in memory and only ever rewritten whole: re-reading it from disk could read back nothing
  // (a torn or unreadable file) and shrink it to a record that names no gate while that gate runs.
  let recorded = null;
  let unrecorded = null;
  const record = (rec) => { writeJson(gatePath(jobsDir, jobId), rec); recorded = rec; };
  let ok = true;
  let error = null;
  try {
    await runGate({
      pool: input.pool, lane: input.lane, dir: input.dir, headSha: input.headSha, runId: input.runId,
      marker: { ...marker, suites: input.suites ?? marker.suites, startedAt: input.requestStartedAt ?? marker.startedAt },
      log,
      onSpawn: (pid) => {
        onGate(pid); // first: a SIGTERM from here on kills the gate even if the sidecar write below fails
        const base = { pid, handle: null, runId: input.runId, dir: input.dir, spawnedAt: new Date().toISOString(), attempt };
        // The pid lands BEFORE the start-time read (a `ps` that can take seconds): a supervisor that dies inside it
        // leaves a record whose process group is still checked, not a pending one found only by its leader's argv.
        try { record(base); } catch (e) {
          // A gate its record does not name cannot be found once its leader is gone: never leave one running.
          unrecorded = e;
          try { if (Number.isInteger(pid) && pid > 1) kill(-pid, 'SIGKILL'); } catch {}
          return;
        }
        let procStart = null;
        try { procStart = readStart(pid); } catch {}
        if (procStart) {
          try { record({ ...base, handle: formatJobHandle({ host: hostName(), pid, procStart }) }); } catch {} // the pid-only record stands
        }
      },
      onGateStarted: () => {
        if (recorded) record({ ...recorded, gateStartedAt: new Date().toISOString() });
      },
    });
  } catch (e) {
    ok = false;
    error = e;
  }
  const after = laneState(input.dir).marker;
  const markerOut = after ? { status: after.status, sha: after.sha ?? null, runId: after.runId ?? null } : null;
  if (unrecorded) {
    return finish({ outcome: 'failed', status: null, signal: null, marker: markerOut,
      message: `could not record the gate's pid (${String(unrecorded?.message || unrecorded).split('\n')[0]}); killed it` });
  }
  return finish({ ...classifyGateOutcome({ ok, error }), marker: markerOut });
}

/**
 * Why another gate may still be running on `input.dir`, or null when none provably is: any other gate job of this
 * lane whose recorded gate is not proven gone ({@link gateState}); a still-pending gate of an unfinished job that
 * recorded itself BEFORE ours (`own`: ordered by its `at`, then job id — two jobs starting together each see the
 * other's pending record, and only the earlier spawns); the same for a sidecar naming this lane whose job record will
 * not parse (one naming no lane, or another lane, is left to the `ps` scan — it must not hold every lane); or a
 * dispatched gate process on the lane that no sidecar names. A listing or a scan that fails is never "none".
 */
function otherLaneGate({ jobId, input, own, jobsDir, listJobs, scanLane, probe, pidExists, scan, groupExists }) {
  const kind = VERIFY_GATE_JOB_KIND.kind;
  let listing;
  try { listing = listJobs(); } catch (e) { return `the gate jobs could not be listed (${String(e?.message || e).split('\n')[0]})`; }
  const peers = [
    ...(listing?.records || []).filter((r) => r.id !== jobId && r.job?.kind === kind && r.input?.dir === input.dir)
      .map((r) => ({ id: r.id, gate: readJson(gatePath(jobsDir, r.id)), unfinished: !TERMINAL_JOB_STATUSES.includes(r.job.status) })),
    ...(listing?.corrupt || []).filter((id) => id !== jobId)
      .map((id) => ({ id, gate: readJson(gatePath(jobsDir, id)), unfinished: true })).filter((p) => p.gate?.dir === input.dir),
  ];
  const ownAt = Date.parse(own?.at || '');
  for (const { id, gate, unfinished } of peers) {
    if (gate?.pending && unfinished) {
      const at = Date.parse(gate.at || '');
      if (!Number.isFinite(at) || !Number.isFinite(ownAt) || at < ownAt || (at === ownAt && id < jobId)) {
        return `job ${id} recorded its gate (run ${gate.runId ?? '?'}) before this one and may be about to spawn it`;
      }
    }
    const state = gateState(gate, { probe, pidExists, scan, groupExists });
    if (state !== 'dead') return `job ${id}'s gate ${gate?.pid ? `pid ${gate.pid}` : `(run ${gate?.runId ?? '?'})`} may still run on this lane (${state})`;
  }
  let pids;
  try { pids = scanLane(input.dir); } catch (e) { return `the lane's gate processes could not be listed (${String(e?.message || e).split('\n')[0]})`; }
  if (pids.length) return `gate process ${pids.join(', ')} is already running on this lane`;
  return null;
}

/**
 * The supervisor's SIGTERM/SIGINT handler: a stopped supervisor (stalled, or `restartInFlight: kill`) takes its gate
 * group down with it — never an orphan. `getPid` reads the pid `onGate` captured at spawn (before the sidecar write).
 */
export function gateStopHandler({ getPid, kill = process.kill.bind(process), exit = (code) => process.exit(code) }) {
  return () => {
    const pid = getPid();
    try { if (Number.isInteger(pid) && pid > 1) kill(-pid, 'SIGKILL'); } catch {}
    exit(143);
  };
}

async function jobMain() {
  let gatePid = null;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, gateStopHandler({ getPid: () => gatePid }));
  const jobsDir = process.env.OPERATION_RUNS_DIR;
  const attempt = Number(process.env[JOB_ATTEMPT_ENV]) || 1;
  const out = await runJob({
    steps: [{
      name: 'gate',
      run: async ({ jobId, input }) => {
        // runJob has read these; the gate's own children (verify-lane, the test runner) must not inherit them.
        for (const k of [JOB_ID_ENV, JOB_ATTEMPT_ENV, JOB_HEARTBEAT_MS_ENV, 'OPERATION_RUNS_DIR']) delete process.env[k];
        return runGateStep({ jobId, input, jobsDir, attempt, onGate: (pid) => { gatePid = pid; } });
      },
    }],
  });
  process.stderr.write(`[verify-gate-job] outcome ${out.outcome}${out.error ? `: ${out.error}` : ''}\n`);
  process.exit(out.outcome === 'succeeded' ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF && existsSync(SELF)) {
  jobMain().catch((e) => {
    process.stderr.write(`[verify-gate-job] fatal: ${String(e?.stack || e)}\n`);
    process.exit(1);
  });
}
