/**
 * Background prevention drain. The health-watch probe must stay fast: each pending card costs a lane acquire plus a
 * batch (30-60s), so the probe only LAUNCHES a detached, single-flight job and returns. The job drains within its own
 * time budget and exits; the next tick starts another while work remains.
 *
 * Files beside the batch states (none ends in `.json`, so state scans never mistake them for batches):
 *   <stateDir>/prevention-drain.state             the ONE job record: running | ok | failed (+ whether a failure was reported)
 *   <stateDir>/.file-locks/                        short critical sections around every record transition (withPathLock)
 *   <stateDir>/prevention-drain.state.drain.log   the job's stdout/stderr (as the seal jobs' `.seal.log`)
 * Single-flight is the record itself: `running` with a live pid (or a launch still inside its grace) blocks every other
 * launch; a worker only works while the record still carries ITS token (fencing), so a late or superseded child exits.
 */
import { spawn as spawnChild } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomicRecord, cardBatchStateDir } from './card-batch-io.mjs';
import { fileIntoBatch } from './card-batch-file.mjs';
import { landPreventionCard } from './land-prevention-card.mjs';
import { loadPreventionBatchSettings } from '../lib/card-batch-settings.mjs';
import { reconcileOwedPrevention } from '../lib/prevention-filing-owed.mjs';
import { withPathLock } from '../readiness/with-lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DRAIN_BUDGET_MS = 120_000;
/** A launched child that has not recorded a pid within this long is presumed never to have started. */
export const DRAIN_LAUNCH_GRACE_MS = 2 * 60_000;
/** After its budget a worker may still be finishing the one card in flight. */
export const DRAIN_FINISH_GRACE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 2000;

export const drainStatePath = (stateDir = cardBatchStateDir()) => join(stateDir, 'prevention-drain.state');
const readRecord = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const iso = ms => new Date(ms).toISOString();
const pidAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** Cheap, read-only: is there anything for a drain job to do? */
export function drainWorkPending(stateDir = cardBatchStateDir()) {
  const has = (dir, test) => { try { return readdirSync(dir).some(test); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const pending = has(join(stateDir, 'pending-prevention'), name => name.endsWith('.json'));
  const owedDir = join(stateDir, 'owed-prevention');
  const owed = has(owedDir, name => /^[a-f0-9]{64}\.json$/.test(name) && readRecord(join(owedDir, name))?.status !== 'done');
  return { pending, owed };
}

const lockedRecord = (statePath, fn) => withPathLock(statePath, fn, { timeoutMs: LOCK_WAIT_MS });
const isLockBusy = error => error?.code === 'ELOCKTIMEOUT';

/**
 * Tick side: never drains. Under one short lock it reports a finished-badly or vanished job once, reports a live job as
 * running (never launching a second), and otherwise claims the slot with a fresh token. The spawn happens after the lock.
 * `launch:false` only inspects. Returns reconcile result entries (error entries fail the probe).
 */
export async function startDrainJob({ stateDir = cardBatchStateDir(), clock = Date.now, launch = true, budgetMs = DRAIN_BUDGET_MS,
  spawn = spawnChild, open = openSync, alive = pidAlive } = {}) {
  const statePath = drainStatePath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  let claim;
  try {
    claim = lockedRecord(statePath, () => {
      const results = [];
      const record = readRecord(statePath);
      if (record?.status === 'running') {
        const since = record.startedAt;
        const launchedAt = Date.parse(record.launchedAt ?? since);
        const live = record.pid ? alive(record.pid) : clock() <= launchedAt + DRAIN_LAUNCH_GRACE_MS;
        if (live) {
          // A live job is normal, and a second one is NEVER launched beside it. One far past its budget is hung: an error.
          if (clock() > Date.parse(since) + 2 * (record.budgetMs ?? budgetMs) + DRAIN_FINISH_GRACE_MS) {
            return { results: [{ action: 'error', step: 'drain', reason: `drain job pid ${record.pid} exceeded its budget (running since ${since})` }] };
          }
          return { results: [{ action: 'running', step: 'drain', reason: `drain running since ${since}` }] };
        }
        // Gone without a result: record it as already reported, surface it once, and the slot is free below.
        atomicRecord(statePath, { ...record, status: 'failed', finishedAt: iso(clock()), error: 'drain job died without finishing', reported: true });
        results.push({ action: 'error', step: 'drain', reason: `drain job died without finishing (started ${since}; see ${statePath}.drain.log)` });
      } else if (record?.status === 'failed' && !record.reported) {
        atomicRecord(statePath, { ...record, reported: true });
        results.push({ action: 'error', step: 'drain', reason: `drain job failed: ${record.error} (see ${statePath}.drain.log)` });
      }
      if (!launch) return { results };
      const token = randomUUID();
      const startedAt = iso(clock());
      atomicRecord(statePath, { status: 'running', startedAt, launchedAt: startedAt, token, pid: null, budgetMs });
      return { results, token, startedAt };
    });
  } catch (error) {
    if (isLockBusy(error)) return [{ action: 'running', step: 'drain', reason: 'drain state busy' }];
    throw error;
  }
  if (!claim.token) return claim.results;

  const { token, startedAt } = claim;
  const fail = message => {
    try {
      lockedRecord(statePath, () => {
        if (readRecord(statePath)?.token === token) atomicRecord(statePath, { status: 'failed', startedAt, finishedAt: iso(clock()), error: message, reported: true, token });
      });
    } catch { /* the launch grace frees the slot */ }
    return [...claim.results, { action: 'error', step: 'drain', reason: `drain job launch failed: ${message}` }];
  };
  let child;
  try {
    let log = 'ignore';
    try { log = open(`${statePath}.drain.log`, 'a'); } catch { /* no log; the job still runs */ }
    try {
      child = spawn(process.execPath, [join(ROOT, 'scripts/operations/card-batch-drain-job.mjs'),
        `--state-dir=${stateDir}`, `--token=${token}`, `--budget-ms=${budgetMs}`],
      { cwd: ROOT, detached: true, stdio: ['ignore', log, log] });
    } finally { if (typeof log === 'number') { try { closeSync(log); } catch { /* the child holds its own copy */ } } }
    // Wait only for the OS launch, never for the job.
    await new Promise((done, reject) => { child.once('error', reject); child.once('spawn', done); child.unref(); });
  } catch (error) { return fail(error.message); }
  // Record the child's pid (fenced by token) so liveness is judged by the process, not a clock.
  try {
    lockedRecord(statePath, () => {
      const record = readRecord(statePath);
      if (record?.token === token && record.status === 'running' && !record.pid && child.pid) atomicRecord(statePath, { ...record, pid: child.pid });
    });
  } catch { /* the job records its own pid at start */ }
  return [...claim.results, { action: 'started', step: 'drain', reason: `drain job started ${startedAt}` }];
}

/**
 * Job side: drain the pending spool and the owed filings inside `budgetMs`. No card or owed filing STARTS after the
 * budget, including those nested in a filing's own spool drain; they stay durable for the next job. The worker works
 * only while the record carries its token, and records its outcome only if it still does.
 */
export async function runDrainJob({ stateDir = cardBatchStateDir(), token, budgetMs = DRAIN_BUDGET_MS, clock = Date.now,
  log = line => process.stdout.write(`${line}\n`), drain = landPreventionCard, fileOwed = landPreventionCard,
  batch = fileIntoBatch, loadFilingSettings = loadPreventionBatchSettings, owedStep = reconcileOwedPrevention } = {}) {
  const statePath = drainStatePath(stateDir);
  const startedAt = iso(clock());
  const deadline = clock() + budgetMs;
  const pendingDir = join(stateDir, 'pending-prevention');
  const fenced = token !== undefined;
  const base = { startedAt, token, pid: process.pid, budgetMs };
  const failures = [];
  const owns = () => !fenced || readRecord(statePath)?.token === token;
  const record = state => lockedRecord(statePath, () => {
    if (!owns()) return false;
    atomicRecord(statePath, { ...base, ...state });
    return true;
  });
  const budgeted = run => (input, options) => clock() >= deadline ? { batched: false, deferred: 'budget' } : run(input, { ...options, stateDir });
  const runBatch = budgeted(batch);
  mkdirSync(stateDir, { recursive: true });
  if (!record({ status: 'running', launchedAt: startedAt })) { log('drain job superseded before start; exiting'); return { ok: true, superseded: true }; }
  try {
    if (loadFilingSettings().filingEnabled === false) {
      log('prevention filing paused by prevention.filingEnabled; nothing drained');
    } else {
      const { pending, owed } = drainWorkPending(stateDir);
      if (pending) {
        const result = await drain({ drainPending: true, session: `card-batch-drain-${randomUUID()}` }, {
          pendingDir, write: line => log(line.trimEnd()), batch: runBatch,
        });
        if (!result.ok) failures.push(result.reason ?? 'pending drain failed');
      }
      if (owed && clock() < deadline) {
        const results = await owedStep({ stateDir,
          // Re-checked before EVERY owed filing: past the budget it is left owed (ok + skipped never marks it done).
          file: input => clock() >= deadline ? { ok: true, skipped: true, deferred: 'budget' }
            : fileOwed(input, { owedClaimed: true, loadFilingSettings, pendingDir, batch: runBatch, write: line => log(line.trimEnd()) }),
        });
        for (const result of results) if (!result.ok) failures.push(result.reason ?? 'owed filing failed');
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
    record({ status: 'ok', finishedAt: iso(clock()), remaining: drainWorkPending(stateDir) });
    log(`drain finished ${iso(clock())}`);
    return { ok: true };
  } catch (error) {
    log(`drain failed: ${error.message}`);
    try { record({ status: 'failed', finishedAt: iso(clock()), error: error.message, reported: false }); } catch { /* the probe sees a dead pid */ }
    return { ok: false, reason: error.message };
  }
}

/** One-shot in-process drain with `startDrainJob`'s signature: for tests and manual runs that want the work done inline. */
export async function drainInline({ stateDir, launch = true, deps = {} } = {}) {
  if (!launch) return [];
  const result = await runDrainJob({ stateDir, ...deps });
  return result.ok ? [] : [{ action: 'error', step: 'drain', reason: result.reason }];
}
