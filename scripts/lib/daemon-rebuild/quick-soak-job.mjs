#!/usr/bin/env node
/** Detached, single-attempt post-adopt soak. Pending state and results survive either process dying.
 * Adoption/settlement/recovery hold the clone write lock; checks hold a read slot so the adopted tree
 * cannot move underneath them. A failed completion lock leaves a durable result for the next tick.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { cloneKey } from '../daemon-overlays.mjs';
import { withReadLock, withWriteLock } from '../daemon-clone-lock.mjs';
import { runLiveSmoke, rollbackToSha } from '../daemon-live-smoke.mjs';
import { gitRun } from '../main-staleness.mjs';
import { runBounded, installChildReaper } from '../bounded-child.mjs';
import { alertsFilePath, stateDir, readRebuildState, writeRebuildState } from './state.mjs';
import { QUICK_SOAK_CHECKS, QUICK_SOAK_MAX_MS, decideQuickSoakResult } from './quick.mjs';
import { makeGit, verifyRev } from './shared.mjs';
import { defineJobKind, kindRegistry, markFailed } from '../daemon-jobs.mjs';
import { createJobStore, enqueueJob, launchJob, probeHandle, readProcStart, reattachTick, runJob } from '../daemon-jobs-runtime.mjs';
import { daemonJobsDir } from '../../operations/run-store.mjs';
import { formatJobHandle, TERMINAL_JOB_STATUSES } from '../../operations/job-record.mjs';
import { cloneNodeModulesInstaller } from './rebuild-job.mjs';

const SELF = fileURLToPath(import.meta.url);
export const QUICK_SOAK_JOB_KIND = defineJobKind({
  kind: 'daemon-quick-soak', entry: 'scripts/lib/daemon-rebuild/quick-soak-job.mjs',
  codeMode: 'readonly-tree', serial: true, nodeModules: true, maxAttempts: 1,
});
const KINDS = kindRegistry([QUICK_SOAK_JOB_KIND]);
// Job-store failure text (markFailed's `reason` key); consts keep it out of the rebuild-reason inventory.
const JOB_FAIL_LAUNCHER = 'quick soak launcher unavailable';
const JOB_FAIL_NO_COMPLETION = 'single-attempt quick soak worker exited without completion';
const jobsDir = (root, env) => daemonJobsDir(`quick-soak-${cloneKey(root)}`, env);
const resultPath = (root, env, marker) => join(stateDir(env),
  `${cloneKey(root)}.quick-soak-${createHash('sha256').update(String(marker.token)).digest('hex').slice(0, 16)}.json`);
const same = (a, b) => a?.quick === true && a.token === b?.token && a.sha === b?.sha;
const lockOptions = env => ({ waitMs: 60_000, ...(env.WE_DAEMON_CLONE_LOCK_ROOT ? { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT } : {}) });
function alert(root, env, kind, detail, log = console) {
  log.error?.(`daemon-rebuild: ${kind} ${JSON.stringify(detail)}`);
  const file = alertsFilePath(root, env);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), kind, detail })}\n`, 'utf8');
  } catch { /* same best-effort audit trail as the rebuild's other alerts; console remains visible */ }
}

/** Caller holds the write lock. A mismatched token can never settle or roll back a newer adoption. */
export function settleQuickSoak({ root, env = process.env, marker, outcome, reason, run = gitRun, log = console, now = Date.now }) {
  const state = readRebuildState(root, env);
  if (!same(state.unverified, marker)) return { settled: false };
  marker = state.unverified;
  const head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
  let rollback = null;
  if (!['passed', 'failed', 'unavailable'].includes(outcome)) outcome = 'unavailable';
  if (!head || head !== marker.sha || state.adopted?.head !== marker.sha) {
    outcome = 'unavailable'; reason = 'adopted-head-changed-or-unreadable';
    // A provably different head is never reset by an old soak. Do not certify a pending adopted record
    // merely because something else moved HEAD; preserve an independently recorded newer adoption.
    if (!head || state.adopted?.head === marker.sha) {
      state.quarantine = { prevHead: marker.prevHead, reason: 'quick-soak-unavailable' };
      state.adopted = marker.lastGood ?? null;
    }
  } else if (outcome !== 'passed') {
    try { rollback = rollbackToSha({ root, sha: marker.prevHead, run }); }
    catch { rollback = { ok: false, reason: 'rollback-threw' }; }
    const rejected = { inputsKey: state.adopted?.inputsKey, reason: `quick-soak-${outcome}`, at: new Date(now()).toISOString() };
    if (rollback.ok) {
      state.adopted = marker.lastGood ?? null;
      state.rejected = rejected;
      state.held = { since: rejected.at, updatedAt: rejected.at, reason: rejected.reason,
        lastGood: marker.prevHead, target: marker.sha };
    } else {
      state.quarantine = { prevHead: marker.prevHead, reason: 'quick-soak-rollback-failed' };
      // A failed rollback is never promoted to a verified last-good build.
      state.adopted = marker.lastGood ?? null;
    }
  }
  state.unverified = null;
  if (state.adopted?.head === marker.sha) delete state.adopted.unverified;
  writeRebuildState(root, state, env);
  if (outcome !== 'passed' && marker.jobId) {
    try {
      createJobStore(jobsDir(root, env)).update(marker.jobId, record => TERMINAL_JOB_STATUSES.includes(record.job.status) ? null
        : markFailed(record, { at: new Date(now()).toISOString(), reason: `quick-soak-${outcome}` }));
    } catch { /* clone state and alert are authoritative even if the job journal is unavailable */ }
  }
  try { unlinkSync(resultPath(root, env, marker)); } catch { /* no result after launch failure */ }
  alert(root, env, `quick-soak-${outcome}`, { sha: marker.sha, lastGood: marker.prevHead,
    ...(reason ? { reason } : {}), ...(rollback ? { rollback } : {}) }, log);
  return { settled: true, outcome, rollback };
}

/** Atomic result handoff, outside the live tree. Consumers require the adoption's token AND sha. */
export function recordQuickSoakResult({ root, env, marker, outcome, reason }) {
  const file = resultPath(root, env, marker);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ token: marker.token, sha: marker.sha, outcome, reason }));
  renameSync(tmp, file);
}

const alive = marker => {
  if (marker.host !== hostname()) return false;
  if (!marker.procStart) return false;
  return probeHandle(formatJobHandle({ host: marker.host, pid: marker.pid, procStart: marker.procStart })) === 'alive';
};

/** Caller holds the write lock. Dead/missing workers and the hard one-hour bound have an explicit fallback. */
export function recoverQuickSoak({ root, env, state = readRebuildState(root, env), now = Date.now, pidAlive = alive, run = gitRun, log = console }) {
  const marker = state.unverified;
  if (marker?.quick !== true) return { pending: false };
  let result;
  try { result = JSON.parse(readFileSync(resultPath(root, env, marker), 'utf8')); } catch { /* no completed evidence */ }
  const nowMs = now();
  const adoptedMs = Date.parse(marker.adoptedAt);
  let workerAlive = false;
  try { workerAlive = Number.isSafeInteger(marker.pid) && marker.pid > 0 && pidAlive(marker) === true; } catch { /* unknown = unavailable */ }
  if (result?.token === marker.token && result.sha === marker.sha && ['passed', 'failed', 'unavailable'].includes(result.outcome)) {
    settleQuickSoak({ root, env, marker, outcome: result.outcome,
      reason: result.outcome === 'unavailable' ? 'soak-could-not-run' : undefined, run, log, now });
  } else if (workerAlive && Number.isFinite(adoptedMs) && adoptedMs <= nowMs && Number.isFinite(marker.deadline)
    && marker.deadline > nowMs && marker.deadline <= adoptedMs + QUICK_SOAK_MAX_MS) {
    return { pending: true };
  } else {
    settleQuickSoak({ root, env, marker, outcome: 'unavailable', reason: 'worker-dead-missing-or-expired', run, log, now });
  }
  Object.assign(state, readRebuildState(root, env));
  return { pending: false };
}

/** Caller holds the write lock. Await only the OS spawn handshake; never the smoke. */
export async function launchQuickSoak({ root, env, marker, run = gitRun, log = console, spawnFn = spawn, readStart = readProcStart }) {
  let store; let queued;
  try {
    store = createJobStore(jobsDir(root, env));
    mkdirSync(store.dir, { recursive: true });
    queued = enqueueJob({ store, kindDef: QUICK_SOAK_JOB_KIND, codeSha: marker.sha, input: { root, token: marker.token } });
    // Snapshot preparation (including npm ci if required) belongs to this detached launcher, never the tick.
    const child = spawnFn(process.execPath, [SELF, root, marker.token, '--launch', queued.id], { cwd: root, env, detached: true, stdio: 'ignore' });
    await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('missing pid');
    const state = readRebuildState(root, env);
    if (same(state.unverified, marker)) {
      state.unverified.pid = child.pid;
      state.unverified.host = hostname();
      state.unverified.procStart = readStart(child.pid);
      state.unverified.jobId = queued.id;
      writeRebuildState(root, state, env);
    }
    child.unref();
    return { started: true };
  } catch {
    if (queued) {
      try { store.update(queued.id, record => markFailed(record, { at: new Date().toISOString(), reason: JOB_FAIL_LAUNCHER })); } catch { /* state recovery still runs */ }
    }
    return settleQuickSoak({ root, env, marker, outcome: 'unavailable', reason: 'worker-launch-failed', run, log });
  }
}

/** Job entry. One attempt: both deferred checks, then tree-stays-clean; incomplete evidence never passes. */
export async function runQuickSoak({ root, env = process.env, marker, token, run = gitRun, smoke = runLiveSmoke, log = console }) {
  marker ??= readRebuildState(root, env).unverified;
  if (!marker?.quick || (token && marker.token !== token)) return;
  let outcome = 'unavailable'; let reason = 'soak-could-not-run';
  try {
    // Wait for the adopting writer's spawn handshake/state write to finish before taking a read slot.
    const barrier = await withWriteLock(root, () => same(readRebuildState(root, env).unverified, marker), lockOptions(env));
    if (barrier.ok && barrier.value) {
      const checked = await withReadLock(root, async () => {
        if (verifyRev(makeGit({ run, cwd: root, env }), 'HEAD') !== marker.sha) return null;
        const deadline = Math.min(marker.deadline, Date.now() + QUICK_SOAK_MAX_MS);
        if (!(deadline > Date.now())) return null;
        const runChild = (cmd, args, opts = {}) => {
          const remaining = deadline - Date.now();
          if (!(remaining > 0)) throw new Error('quick soak deadline exhausted');
          return runBounded(cmd, args, { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? remaining, remaining) });
        };
        return smoke({ root, env, onlyChecks: QUICK_SOAK_CHECKS, changedFiles: null, reuseCode: false, runChild });
      }, lockOptions(env));
      const result = checked.ok ? checked.value : null;
      outcome = decideQuickSoakResult(result);
      if (outcome !== 'unavailable') reason = undefined;
    }
  } catch { /* unavailable is durable evidence too */ }
  recordQuickSoakResult({ root, env, marker, outcome, reason });
  return withWriteLock(root, () => settleQuickSoak({ root, env, marker, outcome, reason, run, log }), lockOptions(env));
}

/** Detached launcher: the shared runtime pins/installs code off-tick, then owns the real job record/handle.
 * Remain alive until its child exits so pending-state recovery also covers snapshot preparation. No relaunch:
 * every unavailable launch/run records the owed soak as unavailable and lets the tick roll back.
 */
async function launchPinnedSoak({ root, token, jobId, env = process.env }) {
  const store = createJobStore(jobsDir(root, env));
  let child;
  let completion;
  const launched = launchJob({
    store, id: jobId, kindDef: QUICK_SOAK_JOB_KIND, env,
    snapshot: { repoDir: root, install: cloneNodeModulesInstaller(root) },
    spawnFn: ({ entryPath, cwd, env: childEnv, logPath }) => {
      const fd = openSync(logPath, 'a');
      try { child = spawn(process.execPath, [entryPath], { cwd, env: childEnv, detached: true, stdio: ['ignore', fd, fd] }); }
      finally { closeSync(fd); }
      completion = new Promise(resolveDone => {
        child.once('error', () => resolveDone());
        child.once('close', () => resolveDone());
      });
      return child.pid;
    },
  });
  if (child) await completion;
  // One dead-handle reconciliation closes an import/launch failure in the standard job store, capped at 1.
  await reattachTick({ store, kinds: KINDS, maxConcurrent: 0 });
  store.update(jobId, record => TERMINAL_JOB_STATUSES.includes(record.job.status) ? null
    : markFailed(record, { at: new Date().toISOString(), reason: JOB_FAIL_NO_COMPLETION }));
  const marker = readRebuildState(root, env).unverified;
  if (marker?.quick && marker.token === token) {
    // A worker may have persisted its result but failed its completion lock. Consume that evidence first.
    if (!launched || !child) recordQuickSoakResult({ root, env, marker, outcome: 'unavailable', reason: 'worker-launch-failed' });
    await withWriteLock(root, () => recoverQuickSoak({ root, env, pidAlive: () => false }), lockOptions(env));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const launching = process.argv[4] === '--launch';
  const record = !launching && process.env.DAEMON_JOB_ID && process.env.OPERATION_RUNS_DIR
    ? createJobStore(process.env.OPERATION_RUNS_DIR).read(process.env.DAEMON_JOB_ID) : null;
  const root = launching ? process.argv[2] : record?.input?.root;
  const token = launching ? process.argv[3] : record?.input?.token;
  if (!launching) installChildReaper();
  const marker = readRebuildState(root).unverified;
  // Independent of individual child budgets: a stuck job exits, leaving unavailable evidence for the
  // next tick's locked rollback. SIGKILL/import failures are recovered by the same dead-PID path.
  const remaining = Number.isFinite(marker?.deadline) ? Math.max(1, Math.min(QUICK_SOAK_MAX_MS, marker.deadline - Date.now())) : 1;
  const watchdog = setTimeout(() => {
    if (same(marker, { token, sha: marker?.sha })) {
      try { recordQuickSoakResult({ root, env: process.env, marker, outcome: 'unavailable', reason: 'soak-deadline' }); } catch { /* recovery sees dead PID */ }
    }
    process.exit(1);
  }, remaining + 60_000); // leave the bounded completion-lock wait time to settle normally first
  const work = launching ? launchPinnedSoak({ root, token, jobId: process.argv[5] })
    : runJob({ steps: [{ name: 'post-adopt-soak', run: () => {
      const smokeEnv = { ...process.env };
      for (const key of ['DAEMON_JOB_ID', 'DAEMON_JOB_ATTEMPT', 'DAEMON_JOB_HEARTBEAT_MS', 'OPERATION_RUNS_DIR']) delete smokeEnv[key];
      return runQuickSoak({ root, token, env: smokeEnv });
    } }] });
  work.catch(async () => {
    try {
      const pending = readRebuildState(root).unverified;
      if (pending?.quick && pending.token === token) {
        recordQuickSoakResult({ root, env: process.env, marker: pending, outcome: 'unavailable', reason: 'worker-fatal' });
        await withWriteLock(root, () => settleQuickSoak({ root, marker: pending, outcome: 'unavailable', reason: 'worker-fatal' }), lockOptions(process.env));
      }
    } catch { /* the next tick sees the dead PID and recovers under its write lock */ }
    process.exitCode = 1;
  }).finally(() => clearTimeout(watchdog));
}
