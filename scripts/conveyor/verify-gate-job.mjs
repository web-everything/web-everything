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
 *      (kills it first when its handle proves it alive), re-checks that the marker is still this request, takes
 *      the LANE CLAIM, records the gate (`<id>.gate`, written BEFORE the spawn), runs it, writes `<id>.result`.
 *
 *   THE RULE (operator ruling 2026-10-10 on PR 4764, the same rule as daemon design O15): a new gate starts on a lane
 *   only once the previous one is CONFIRMED gone — by pid + process start time, and its whole process group. A
 *   record that cannot be read, a foreign or malformed handle, a pid with no start time, a gate recorded only as
 *   pending: each means "possibly running", never "none". Such a lane is held (with a health alert) until it is
 *   proven gone, or an operator releases it ({@link releaseLaneByOperator}).
 *
 *   THE LANE CLAIM ({@link claimLane}) is what makes "one gate per lane" hold between jobs: a job takes it BEFORE it
 *   records or spawns a gate, by creating the lane's next numbered claim file exclusively (`link`, never a
 *   write-in-place), so two jobs racing for a lane cannot both win, whatever their clocks say. A claim passes to
 *   another job only once its holder's supervisor (its own handle, written into the claim) and its gate are proven
 *   gone. The tick reads the same claims: a lane whose claim is not provably released stays held, in job mode and
 *   in rollback alike.
 */
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execRead, readGit } from '../lib/proc-read.mjs';

import { defineJobKind, kindRegistry } from '../lib/daemon-jobs.mjs';
import {
  createJobStore, createTickClock, enqueueJob, probeHandle, readProcStart, reattachTick, runJob, stopHandle,
  hostName, selfHandle, JOB_ID_ENV, JOB_ATTEMPT_ENV, JOB_HEARTBEAT_MS_ENV,
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
const errLine = (e) => String(e?.message || e).split('\n')[0];

/**
 * A job's gate sidecar, read strictly: `null` only when the file does not exist (a gate is recorded BEFORE it is
 * spawned, so no file means no gate was ever spawned); `{unreadable}` for anything else that is not a record — a
 * torn or empty file, an error other than ENOENT, a value that is not an object. Never "no gate" by accident.
 */
export function readGate(dir, id) {
  let text;
  try { text = readFileSync(gatePath(dir, id), 'utf8'); } catch (e) {
    return e?.code === 'ENOENT' ? null : { unreadable: e?.code || errLine(e) };
  }
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { unreadable: 'not a record' };
  } catch { return { unreadable: 'not JSON' }; }
}

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
 * Is a recorded gate still running? Only positive proof answers `dead` or `alive`; everything else is `unknown`,
 * which every caller treats as "may still be running" (held, never killed).
 * - `alive`: the handle (`host:pid:procStart`) probes alive on this host — the pid AND its start time match.
 * - `dead`: the handle probes dead (the pid is gone, or now has another start time) and the gate's process GROUP is
 *   gone; or a handle-less record whose pid no longer exists at all and whose group is gone; or a record that says
 *   it started no gate (`none`).
 * - `unknown`: a probe that throws; a foreign-host or malformed handle; a leader gone while its group has members; a
 *   handle-less pid that still exists (no start time, so it may be our gate or a reused pid — an argv match is not
 *   identity); a `pending` record (no pid was recorded, so nothing can prove it gone); an unreadable record
 *   ({@link readGate}); any shape not listed here.
 * `null` (no sidecar file) reads `dead`: callers use it only where no gate can still be spawned for that record.
 */
export function gateState(gate, { probe = probeHandle, pidExists = pidExistsDefault, groupExists = groupExistsDefault } = {}) {
  if (!gate) return 'dead';
  if (gate.unreadable) return 'unknown';
  if (gate.none === true && gate.pid == null && !gate.handle) return 'dead';
  // The gate is a process GROUP (verify-lane leads it; its test runners share it). A leader that is gone while its
  // group still exists (crash, OOM, a kill of the leader alone) is not a dead gate: a second gate must not start
  // beside the surviving members. Never killed on that basis either — the group id alone proves no identity.
  const groupGone = (pid) => {
    if (!Number.isInteger(pid) || pid <= 1) return 'unknown';
    try { return groupExists(pid) ? 'unknown' : 'dead'; } catch { return 'unknown'; }
  };
  if (gate.handle) {
    const parsed = parseJobHandle(gate.handle);
    if (!parsed) return 'unknown';
    try {
      const s = probe(gate.handle);
      if (s === 'alive') return 'alive';
      if (s !== 'dead') return 'unknown';
      // The leader is provably gone. If its pid already belongs to another process, our group is gone too (a pid is
      // never handed out while it is a live process group's id), so that group, if any, is not ours.
      return pidExists(parsed.pid) ? 'dead' : groupGone(parsed.pid);
    } catch { return 'unknown'; }
  }
  if (gate.pid == null) return 'unknown'; // pending, or a record that names no gate and does not say so
  const pid = Number(gate.pid);
  if (!Number.isInteger(pid) || pid <= 1) return 'unknown';
  try { return pidExists(pid) ? 'unknown' : groupGone(pid); } catch { return 'unknown'; }
}

/** The gate process recorded by a job's supervisor: `{gate, state, alive}` ({@link gateState}; `alive` = proven alive). */
export function liveGate(dir, id, { probe = probeHandle, pidExists = pidExistsDefault, groupExists = groupExistsDefault } = {}) {
  const g = readGate(dir, id);
  const state = gateState(g, { probe, pidExists, groupExists });
  return { gate: g, state, alive: state === 'alive' };
}

// ── the lane claim ──────────────────────────────────────────────────────────────────────────────────────────

/** Claims live in their own folder: the run store reads every `*.json` in the jobs dir as a job record. */
export const LANE_CLAIM_DIR = 'lanes';
const CLAIM_KEEP = 8;
const claimDirOf = (jobsDir) => join(jobsDir, LANE_CLAIM_DIR);
/** One lane's key: the hash of its resolved dir (the same dir the job input, the sweep and `--repo=` all carry). */
export const laneKey = (dir) => createHash('sha1').update(resolve(String(dir))).digest('hex').slice(0, 16);
const claimFile = (key, seq, ext) => `${key}.${String(seq).padStart(8, '0')}.${ext}`;
const CLAIM_RE = /^([0-9a-f]{16})\.(\d{8})\.claim$/;
const JOB_ID_RE = /^[\w.-]{1,128}$/;

/** Create `path` with `value` only if it does not exist — atomically and complete (`link` of a written temp file). */
function createExclusive(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  try { linkSync(tmp, path); return true; } catch (e) { if (e?.code === 'EEXIST') return false; throw e; } finally { rmSync(tmp, { force: true }); }
}

/**
 * The lane's CURRENT claim — the highest-numbered one: `{key, seq, claim, unreadable, released}`; `seq: 0` when the
 * lane was never claimed. Throws when the claims folder cannot be listed (that is never "no claim").
 */
export function readLaneClaim(jobsDir, dir) {
  const key = laneKey(dir);
  let names;
  try { names = readdirSync(claimDirOf(jobsDir)); } catch (e) { if (e?.code === 'ENOENT') return { key, seq: 0 }; throw e; }
  let seq = 0;
  for (const n of names) { const m = n.match(CLAIM_RE); if (m && m[1] === key) seq = Math.max(seq, Number(m[2])); }
  if (!seq) return { key, seq: 0 };
  let claim = null;
  let unreadable = null;
  try {
    const v = JSON.parse(readFileSync(join(claimDirOf(jobsDir), claimFile(key, seq, 'claim')), 'utf8'));
    if (v && typeof v === 'object' && JOB_ID_RE.test(String(v.jobId ?? ''))) claim = v; else unreadable = 'not a claim';
  } catch (e) { unreadable = e?.code || 'not JSON'; }
  return { key, seq, claim, unreadable, released: existsSync(join(claimDirOf(jobsDir), claimFile(key, seq, 'released'))) };
}

/**
 * Is a claim's holder provably gone? `true` only when its supervisor's handle probes dead (pid + start time) AND
 * its gate is proven gone — or it recorded no gate at all (no sidecar: a gate is recorded before it is spawned, and a
 * dead supervisor spawns nothing more). Otherwise the reason it may still be running.
 */
export function claimHolderGone(claim, jobsDir, { probe = probeHandle, pidExists = pidExistsDefault, groupExists = groupExistsDefault } = {}) {
  const id = claim?.jobId;
  let sup;
  try { sup = parseJobHandle(claim?.supervisor) ? probe(claim.supervisor) : 'unidentified'; } catch { sup = 'unprobeable'; }
  if (sup === 'alive') return `job ${id} holds the lane (its supervisor is running)`;
  if (sup !== 'dead') return `job ${id} holds the lane and its supervisor cannot be proven gone (${sup})`;
  const gate = readGate(jobsDir, id);
  if (gate === null) return true;
  const state = gateState(gate, { probe, pidExists, groupExists });
  if (state === 'dead') return true;
  const which = gate.unreadable ? `record unreadable: ${gate.unreadable}` : gate.pid ? `pid ${gate.pid}` : `run ${gate.runId ?? '?'}, no pid recorded`;
  return `job ${id} holds the lane and its gate (${which}) may still run (${state})`;
}

/**
 * Take the lane's claim for `holder` ({jobId, runId, dir, attempt, supervisor}). The next claim number is created
 * exclusively, so of two jobs racing for a lane exactly one wins; a held claim passes over only when
 * `holderGone(claim) === true` (the holder's own previous attempt included). Re-checked after the create: a reader
 * that judged a stale claim never outranks a newer one. Returns `{ok:true, key, seq}` or `{ok:false, why}`.
 */
export function claimLane({ jobsDir, dir, holder, holderGone }) {
  try { mkdirSync(claimDirOf(jobsDir)); } catch (e) { if (e?.code !== 'EEXIST') return { ok: false, why: `the lane claims cannot be written (${errLine(e)})` }; }
  for (let i = 0; i < 5; i += 1) {
    let cur;
    try { cur = readLaneClaim(jobsDir, dir); } catch (e) { return { ok: false, why: `the lane claims cannot be listed (${errLine(e)})` }; }
    if (cur.seq > 0 && !cur.released) {
      if (cur.unreadable) return { ok: false, why: `the lane's claim ${cur.seq} cannot be read (${cur.unreadable}) — a gate may be running` };
      const gone = holderGone(cur.claim);
      if (gone !== true) return { ok: false, why: gone };
    }
    const seq = cur.seq + 1;
    let made;
    try { made = createExclusive(join(claimDirOf(jobsDir), claimFile(cur.key, seq, 'claim')), { ...holder, at: new Date().toISOString() }); }
    catch (e) { return { ok: false, why: `the lane claim cannot be written (${errLine(e)})` }; }
    if (!made) continue; // another job took this number first: judge its claim
    let now;
    try { now = readLaneClaim(jobsDir, dir); } catch (e) { return { ok: false, why: `the lane claims cannot be listed (${errLine(e)})` }; }
    if (now.seq !== seq) continue; // a newer claim exists (ours was a stale number): judge that one
    pruneClaims(jobsDir, cur.key, seq);
    return { ok: true, key: cur.key, seq };
  }
  return { ok: false, why: 'the lane claim kept changing under this job' };
}

/** Mark claim `seq` released. Only after its gate is proven gone (or by an operator). Idempotent. */
export function releaseLaneClaim(jobsDir, { key, seq }, note) {
  if (!key || !seq) return false;
  return createExclusive(join(claimDirOf(jobsDir), claimFile(key, seq, 'released')), { ...note, at: new Date().toISOString() });
}

function pruneClaims(jobsDir, key, seq) {
  try {
    for (const n of readdirSync(claimDirOf(jobsDir))) {
      const m = n.match(/^([0-9a-f]{16})\.(\d{8})\.(claim|released)$/);
      if (m && m[1] === key && Number(m[2]) <= seq - CLAIM_KEEP) rmSync(join(claimDirOf(jobsDir), n), { force: true });
    }
  } catch {}
}

/** This supervisor's own handle (pid + start time), or null when it cannot be read — no claim is taken without it. */
function selfHandleOrNull() {
  try { const h = selfHandle().handle; return parseJobHandle(h) ? h : null; } catch { return null; }
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
 *   evict?:Function, kill?:Function, launchJobs?:boolean, scanLane?:(dir:string)=>number[]}} o `launchJobs: false`
 *   (rollback, `WE_VERIFY_GATE_AS_JOB=0`): the reattach pass still stops stalled supervisors and records dead ones,
 *   but starts no supervisor — queued or relaunched — so only the in-process sweep starts gates; a queued job then
 *   holds no lane (it never runs), while every claim a job already took still does.
 */
export function createVerifyGateJobs({
  store = createJobStore(verifyJobsDir()), cloneRoot = CLONE_ROOT, log = (m) => process.stderr.write(`${m}\n`),
  maxConcurrent = 8, reattach = reattachTick, snapshot, readHead = () => readHeadOf(cloneRoot), probe = probeHandle,
  now = () => Date.now(), onSettled = () => {}, evict = evictSnapshots, kill = process.kill.bind(process),
  pidExists = pidExistsDefault, groupExists = groupExistsDefault, launchJobs = true, scanLane = findLaneGatePidsDefault,
} = {}) {
  mkdirSync(store.dir, { recursive: true });
  const kind = VERIFY_GATE_JOB_KIND.kind;
  const clock = createTickClock();
  const snap = snapshot ?? { repoDir: cloneRoot, install: cloneNodeModulesInstaller(cloneRoot) };
  const deps = { probe, pidExists, groupExists };
  const startLogged = new Set();
  const survivorLogged = new Set();
  const alerted = new Set();
  // A dead handle never comes back (its start time is part of it): skip re-probing it each tick.
  const goneHandles = new Set();
  /** A finished job's gate that may still run: `{gate, state}` with state `alive` or `unknown` ({@link gateState}); null once provably gone. */
  const survivorOf = (id) => {
    const gate = readGate(store.dir, id);
    const key = typeof gate?.handle === 'string' ? gate.handle : null;
    if (!gate || (key && goneHandles.has(key))) return null;
    const state = gateState(gate, deps);
    if (state === 'dead') { if (key) goneHandles.add(key); return null; }
    return { gate, state };
  };
  /**
   * Why lane `dir` may not get a new gate right now, from the lane claims alone (plus, with `scanProcs`, any
   * dispatched gate process on it): `{why, claim?}`, or null when it is provably free. A claim whose holder is proven
   * gone is released here, so the next job takes it at once. Every hold is a health alert, logged once per claim.
   */
  const laneHold = (dir, { scanProcs = false } = {}) => {
    let held = null;
    let cur = null;
    try { cur = readLaneClaim(store.dir, dir); } catch (e) { held = { why: `its gate claims cannot be listed (${errLine(e)})` }; }
    if (cur && cur.seq > 0 && !cur.released) {
      if (cur.unreadable) held = { why: `its gate claim ${cur.seq} cannot be read (${cur.unreadable}) — a gate may be running` };
      else {
        const gone = claimHolderGone(cur.claim, store.dir, deps);
        if (gone === true) {
          try { releaseLaneClaim(store.dir, cur, { by: 'verify-daemon', why: 'holder supervisor and gate proven gone' }); } catch {}
        } else held = { why: gone, claim: cur.claim };
      }
    }
    if (!held && scanProcs) {
      try { const pids = scanLane(dir); if (pids.length) held = { why: `gate process ${pids.join(', ')} is running on it (no claim names it)` }; }
      catch (e) { held = { why: `its gate processes could not be listed (${errLine(e)})` }; }
    }
    const tag = held && `${dir}\u0000${cur?.seq ?? '-'}\u0000${held.claim?.jobId ?? held.why}`;
    if (held && !alerted.has(tag)) {
      alerted.add(tag);
      log(`verify-daemon: ⚠ HEALTH lane ${dir} is held — ${held.why}. No gate starts there until it is proven gone; if it is gone and cannot be proven, release it: node scripts/conveyor/verify-gate-job.mjs release-lane --dir=${dir}`);
    }
    return held;
  };
  /** Does job `r` hold its lane's current, unreleased claim (or might it — the claims cannot be read)? Never pruned then. */
  const holdsClaim = (r) => {
    try {
      const cur = readLaneClaim(store.dir, r.input.dir);
      return cur.seq > 0 && !cur.released && (!!cur.unreadable || cur.claim.jobId === r.id);
    } catch { return true; }
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
          log: (m) => log(`verify-daemon: ${m}`), ...(launchJobs ? {} : { launch: () => null }) });
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
          if (!launchJobs && r.job.status === 'queued') continue; // never runs in rollback; any claim it took still holds
          live.add(r.id);
          // A probe that throws (ps timeout) must not abort the whole sync: treat the gate as not yet seen this tick.
          const { gate, alive } = liveGate(store.dir, r.id, deps); // a throwing probe reads as `unknown`, not an abort
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
      // The lane claims have the last word: a lane whose claim is not provably released stays held even when no record
      // or sidecar of the job holding it can be read (or the record was removed by hand).
      const lanes = new Map();
      for (const r of records) if (r.input?.dir) lanes.set(r.input.dir, r.input);
      for (const [dir, e] of inFlight) if (e.jobId && !lanes.has(dir)) lanes.set(dir, e);
      for (const [dir, where] of lanes) {
        if (holders.has(dir)) continue;
        const held = laneHold(dir);
        if (!held) continue;
        const prev = inFlight.get(dir);
        const jobId = held.claim?.jobId ?? `lane-claim:${laneKey(dir)}`;
        live.add(jobId);
        holders.set(dir, { pool: where.pool, lane: where.lane, dir, runId: held.claim?.runId ?? null, sha: where.headSha ?? where.sha ?? null,
          suites: null, treeHash: null, requestStartedAt: null, jobId, pid: null,
          startedMs: prev?.jobId === jobId ? prev.startedMs : now(), heldBy: held.why });
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
        if (holdsClaim(r)) continue; // its sidecar is what proves the claim's gate gone: never delete it first
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
        const { gate, alive } = liveGate(store.dir, r.id, deps);
        if (alive) killGateGroup(gate, kill);
      }
    },
    /**
     * The dispatch sweep's last check before it starts (or queues) a gate on `dir`: why the lane is held, or null.
     * With `scanProcs` (rollback, where no job child runs the check) a dispatched gate process no claim names holds it too.
     * @returns {string|null}
     */
    laneHeld(dir, { scanProcs = false } = {}) {
      return laneHold(dir, { scanProcs })?.why ?? null;
    },
    /**
     * The dispatch sweep's supersede kill for a gate JOB's entry: re-read the job's sidecar and signal its group
     * only when the handle proves, right now, that it is still the gate. The registry `pid` was proven at the last
     * sync; by the time a newer request supersedes the entry the gate may have exited and its pid been reused.
     * @returns {boolean} whether a kill was attempted
     */
    killJobGate(entry) {
      if (!entry?.jobId) return false;
      const { gate, alive } = liveGate(store.dir, entry.jobId, deps);
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
  groupExists = groupExistsDefault, listJobs = () => createJobStore(jobsDir).list(), scanLane = findLaneGatePidsDefault,
  supervisorHandle = selfHandleOrNull,
}) {
  const deps = { probe, pidExists, groupExists };
  const where = `${input.pool}/lane-${input.lane} @ ${String(input.headSha).slice(0, 8)}`;
  const finish = (result) => {
    const full = { ...result, attempt, finishedAt: new Date().toISOString(), ...gateCeilings() };
    writeJson(resultPath(jobsDir, jobId), full);
    log(`[verify-gate-job ${jobId}] ${full.finishedAt} ${where}: ${full.outcome}`);
    return { outcome: full.outcome };
  };

  const refuse = (message) => {
    log(`[verify-gate-job ${jobId}] attempt ${attempt}: ${message}`);
    return finish({ outcome: 'failed', status: null, signal: null, message });
  };

  // 1. A previous attempt's gate that outlived its supervisor: stop it before anything else runs on this lane.
  // Only a PROVEN-dead gate lets the run go on: `unknown` (a probe that threw, a foreign-host or malformed handle, a
  // pid with no start time that still exists, a pending record, an unreadable record) is refused, and never killed
  // (no proof the pid is still that gate). The lane then stays held until it is proven gone or an operator releases it.
  const prior = liveGate(jobsDir, jobId, deps);
  let state = prior.state;
  if (state === 'alive') {
    log(`[verify-gate-job ${jobId}] attempt ${attempt}: previous gate pid ${prior.gate.pid} still alive — killing its group`);
    killGateGroup(prior.gate, kill);
    for (let i = 0; i < 50; i += 1) {
      state = gateState(prior.gate, deps);
      if (state !== 'alive') break;
      await sleep(100);
    }
    // A bounded kill attempt is not proof of death: never start a second gate beside one that still owns the marker.
    if (state === 'alive') state = gateState(prior.gate, deps);
  }
  if (state !== 'dead') {
    const g = prior.gate;
    const which = g?.unreadable ? `(record unreadable: ${g.unreadable})` : g?.pid ? `pid ${g.pid}` : `(no pid recorded, run ${g?.runId ?? '?'})`;
    return refuse(state === 'alive'
      ? `previous gate ${which} survived SIGKILL; refusing to start a second gate on this lane`
      : `previous gate ${which} cannot be proven gone (liveness unknown); refusing to start a second gate on this lane`);
  }

  // 2. Run nothing unless the marker is still this request (a relaunch may find it settled or superseded).
  const { marker, headSha } = laneState(input.dir);
  if (!markerStillOurs(marker, headSha, input)) {
    return finish({ outcome: 'stale', marker: marker ? { status: marker.status, sha: marker.sha ?? null, runId: marker.runId ?? null } : null,
      headSha: headSha ?? null });
  }

  // 3. Claim the lane BEFORE recording or spawning anything. One job holds a lane's claim at a time; it passes over
  // only once its holder's supervisor and gate are proven gone (this job's own previous attempt included).
  const me = (() => { try { return supervisorHandle(); } catch { return null; } })();
  if (!parseJobHandle(me)) return refuse('this supervisor cannot read its own handle (pid + start time), so it cannot claim the lane; not started');
  const claim = claimLane({ jobsDir, dir: input.dir, holder: { jobId, runId: input.runId, dir: input.dir, attempt, supervisor: me },
    holderGone: (c) => claimHolderGone(c, jobsDir, deps) });
  if (!claim.ok) return refuse(`${claim.why}; refusing to start a second gate on this lane`);
  // Only once this job's gate is proven gone (or none was started) does the lane pass on; otherwise the tick does it later.
  const release = (why) => { try { releaseLaneClaim(jobsDir, claim, { by: jobId, why }); } catch {} };
  const noGate = (why) => {
    try { writeJson(gatePath(jobsDir, jobId), { pid: null, handle: null, none: true, why, runId: input.runId, dir: input.dir, at: new Date().toISOString(), attempt }); }
    catch { return; } // the record still says pending: the lane stays held (never "none" by accident)
    release(why);
  };

  // 3a. Record the gate BEFORE spawning it: a supervisor that dies between the spawn and the pid write must not leave
  // a gate no sidecar names. A pending record proves nothing gone (it has no pid), so it holds the lane until a person
  // releases it — that window is a crash inside a synchronous spawn.
  try {
    writeJson(gatePath(jobsDir, jobId), { pid: null, handle: null, pending: true, runId: input.runId, dir: input.dir, at: new Date().toISOString(), attempt });
  } catch (e) {
    release('no gate recorded or started');
    return refuse(`could not record the gate before spawning it (${errLine(e)}); not started`);
  }

  // 3b. A backstop beside the claim: no other job's gate on this lane may still run (a job of a store that predates the
  // claim, a record nothing released), and no dispatched gate process no sidecar names (another store, a rolled-back
  // in-process sweep). Only proven gone lets the run go on; such a gate is never killed from here.
  const blocker = otherLaneGate({ jobId, input, jobsDir, listJobs, scanLane, deps });
  if (blocker) {
    noGate('refused');
    return refuse(`${blocker}; refusing to start a second gate on this lane`);
  }

  // 4. The gate — the same code, ceilings and settlement as the in-process sweep.
  // The record is kept in memory and only ever rewritten whole: re-reading it from disk could read back nothing
  // (a torn or unreadable file) and shrink it to a record that names no gate while that gate runs.
  let recorded = null;
  let unrecorded = null;
  let spawnedPid = null;
  const record = (rec) => { writeJson(gatePath(jobsDir, jobId), rec); recorded = rec; };
  let ok = true;
  let error = null;
  try {
    await runGate({
      pool: input.pool, lane: input.lane, dir: input.dir, headSha: input.headSha, runId: input.runId,
      marker: { ...marker, suites: input.suites ?? marker.suites, startedAt: input.requestStartedAt ?? marker.startedAt },
      log,
      onSpawn: (pid) => {
        spawnedPid = pid;
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
  if (spawnedPid == null) noGate('not spawned');
  // A gate whose record never landed keeps the lane: its sidecar still says pending, which nothing can prove gone.
  else if (!unrecorded && gateState(recorded ?? { pid: spawnedPid, handle: null }, deps) === 'dead') release('gate proven gone');
  else log(`[verify-gate-job ${jobId}] attempt ${attempt}: gate pid ${spawnedPid} is not yet proven gone — the lane stays claimed until it is`);
  if (unrecorded) {
    return finish({ outcome: 'failed', status: null, signal: null, marker: markerOut,
      message: `could not record the gate's pid (${errLine(unrecorded)}); killed it` });
  }
  return finish({ ...classifyGateOutcome({ ok, error }), marker: markerOut });
}

/**
 * Why another gate may still be running on `input.dir`, or null when none provably is: any other gate job of this
 * lane whose recorded gate is not proven gone ({@link gateState} — a pending or unreadable record included); any
 * unfinished one recording a gate it may be about to spawn (no clock ordering: the claim already decided who runs);
 * the same for a sidecar naming this lane whose job record will not parse; or a dispatched gate process on the lane
 * that no sidecar names. A listing or a scan that fails is never "none".
 */
function otherLaneGate({ jobId, input, jobsDir, listJobs, scanLane, deps }) {
  const kind = VERIFY_GATE_JOB_KIND.kind;
  let listing;
  try { listing = listJobs(); } catch (e) { return `the gate jobs could not be listed (${errLine(e)})`; }
  const peers = [
    ...(listing?.records || []).filter((r) => r.id !== jobId && r.job?.kind === kind && r.input?.dir === input.dir)
      .map((r) => ({ id: r.id, gate: readGate(jobsDir, r.id) })),
    ...(listing?.corrupt || []).filter((id) => id !== jobId)
      .map((id) => ({ id, gate: readGate(jobsDir, id) })).filter((p) => p.gate?.dir === input.dir),
  ];
  for (const { id, gate } of peers) {
    const state = gateState(gate, deps);
    if (state !== 'dead') {
      const which = gate?.unreadable ? `(record unreadable: ${gate.unreadable})` : gate?.pid ? `pid ${gate.pid}` : `(run ${gate?.runId ?? '?'}, no pid recorded)`;
      return `job ${id}'s gate ${which} may still run on this lane (${state})`;
    }
  }
  let pids;
  try { pids = scanLane(input.dir); } catch (e) { return `the lane's gate processes could not be listed (${errLine(e)})`; }
  if (pids.length) return `gate process ${pids.join(', ')} is already running on this lane`;
  return null;
}

/**
 * The operator's release of a held lane (`release-lane --dir=<lane>`), for a gate that IS gone but cannot be proven
 * gone (a pending record, a pid with no start time, an unreadable record). Releases the lane's current claim and sets
 * aside every record of that lane's jobs that still reads "may be running", keeping the original next to it.
 * @returns {{claim:number|null, setAside:string[]}}
 */
export function releaseLaneByOperator({ jobsDir, dir, who = 'operator', deps = {} }) {
  const cur = readLaneClaim(jobsDir, dir);
  const claim = cur.seq > 0 && !cur.released && releaseLaneClaim(jobsDir, cur, { by: who, why: 'release-lane' }) ? cur.seq : null;
  const setAside = [];
  const listing = createJobStore(jobsDir).list();
  const ids = [...listing.records.filter((r) => r.job?.kind === VERIFY_GATE_JOB_KIND.kind && r.input?.dir === dir).map((r) => r.id),
    ...(listing.corrupt || []).filter((id) => readGate(jobsDir, id)?.dir === dir)];
  if (cur.claim?.jobId && !ids.includes(cur.claim.jobId)) ids.push(cur.claim.jobId);
  for (const id of ids) {
    const gate = readGate(jobsDir, id);
    if (!gate || gateState(gate, deps) === 'dead') continue;
    const path = gatePath(jobsDir, id);
    renameSync(path, `${path}.released-${Date.now()}`);
    writeJson(path, { pid: null, handle: null, none: true, why: `released by ${who}`, dir, at: new Date().toISOString() });
    setAside.push(id);
  }
  return { claim, setAside };
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

/** `release-lane --dir=<lane> [--jobs-dir=<dir>]`: the operator's release of a held lane ({@link releaseLaneByOperator}). */
function releaseLaneMain(argv) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const dir = arg('dir');
  if (!dir) { process.stderr.write('usage: verify-gate-job.mjs release-lane --dir=<lane dir> [--jobs-dir=<dir>]\n'); process.exit(64); }
  const out = releaseLaneByOperator({ jobsDir: arg('jobs-dir') || verifyJobsDir(), dir, who: `operator (pid ${process.pid})` });
  process.stdout.write(`${JSON.stringify({ dir, ...out })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF && existsSync(SELF) && process.argv[2] === 'release-lane') {
  releaseLaneMain(process.argv.slice(3));
} else if (process.argv[1] && resolve(process.argv[1]) === SELF && existsSync(SELF)) {
  jobMain().catch((e) => {
    process.stderr.write(`[verify-gate-job] fatal: ${String(e?.stack || e)}\n`);
    process.exit(1);
  });
}
