/**
 * Background prevention drain. The health-watch probe must stay fast: each pending card costs a lane acquire plus a
 * batch (30-60s), so the probe only LAUNCHES a detached, single-flight job and returns. The job drains within its own
 * time budget and exits; the next tick starts another while work remains.
 *
 * Files beside the batch states (none ends in `.json`, so state scans never mistake them for batches):
 *   <stateDir>/prevention-drain.state          job record: running | ok | failed (+ whether a failure was reported)
 *   <stateDir>/prevention-drain.state.lock     single-flight lease, held from launch until the job exits
 *   <stateDir>/prevention-drain.state.drain.log  the job's stdout/stderr (as the seal jobs' `.seal.log`)
 */
import { spawn as spawnChild } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireLease, atomicRecord, cardBatchStateDir, tokenOf } from './card-batch-io.mjs';
import { fileIntoBatch } from './card-batch-file.mjs';
import { landPreventionCard } from './land-prevention-card.mjs';
import { loadPreventionBatchSettings } from '../lib/card-batch-settings.mjs';
import { reconcileOwedPrevention } from '../lib/prevention-filing-owed.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DRAIN_BUDGET_MS = 120_000;
/** The lease outlives the budget by the time one in-flight card can still take after the budget is spent. */
export const DRAIN_GRACE_MS = 5 * 60_000;

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

/**
 * Tick side: never drains. Reports a finished-badly or vanished job once, reports a live job as running, and otherwise
 * launches one detached job when `launch` is true. Returns reconcile result entries (error entries fail the probe).
 */
export async function startDrainJob({ stateDir = cardBatchStateDir(), clock = Date.now, launch = true, budgetMs = DRAIN_BUDGET_MS,
  spawn = spawnChild, open = openSync, alive = pidAlive } = {}) {
  const statePath = drainStatePath(stateDir);
  const lockPath = `${statePath}.lock`;
  const results = [];
  const record = readRecord(statePath);
  if (record?.status === 'running') {
    const since = record.startedAt;
    const dead = record.pid ? !alive(record.pid) : clock() > Date.parse(since) + budgetMs + DRAIN_GRACE_MS;
    if (!dead) {
      // A live job is normal. One that has outrun its budget plus grace is hung, and that is a real error.
      if (clock() > Date.parse(since) + 2 * budgetMs + DRAIN_GRACE_MS) {
        return [{ action: 'error', step: 'drain', reason: `drain job pid ${record.pid} exceeded its budget (running since ${since})` }];
      }
      return [{ action: 'running', step: 'drain', reason: `drain running since ${since}` }];
    }
    // The job vanished without recording a result: surface that once and free the single-flight slot.
    atomicRecord(statePath, { ...record, status: 'failed', finishedAt: iso(clock()), error: 'drain job died without finishing', reported: true });
    if (tokenOf(lockPath) === record.token) rmSync(lockPath, { force: true });
    results.push({ action: 'error', step: 'drain', reason: `drain job died without finishing (started ${since}; see ${statePath}.drain.log)` });
  } else if (record?.status === 'failed' && !record.reported) {
    atomicRecord(statePath, { ...record, reported: true });
    results.push({ action: 'error', step: 'drain', reason: `drain job failed: ${record.error} (see ${statePath}.drain.log)` });
  }
  if (!launch) return results;

  const lease = acquireLease(lockPath, `drain-probe:${process.pid}:${randomUUID()}`, clock(), budgetMs + DRAIN_GRACE_MS);
  if (!lease) return [...results, { action: 'running', step: 'drain', reason: 'drain running (lease held)' }];
  const startedAt = iso(clock());
  let child;
  try {
    mkdirSync(stateDir, { recursive: true });
    atomicRecord(statePath, { status: 'running', startedAt, token: lease.token, pid: null, budgetMs });
    let log = 'ignore';
    try { log = open(`${statePath}.drain.log`, 'a'); } catch { /* no log; the job still runs */ }
    try {
      child = spawn(process.execPath, [join(ROOT, 'scripts/operations/card-batch-drain-job.mjs'),
        `--state-dir=${stateDir}`, `--token=${lease.token}`, `--budget-ms=${budgetMs}`],
      { cwd: ROOT, detached: true, stdio: ['ignore', log, log] });
    } finally { if (typeof log === 'number') { try { closeSync(log); } catch { /* the child holds its own copy */ } } }
    // Wait only for the OS launch, never for the job.
    await new Promise((done, reject) => { child.once('error', reject); child.once('spawn', done); child.unref(); });
  } catch (error) {
    atomicRecord(statePath, { status: 'failed', startedAt, finishedAt: iso(clock()), error: `launch failed: ${error.message}`, reported: true });
    if (tokenOf(lockPath) === lease.token) rmSync(lockPath, { force: true });
    return [...results, { action: 'error', step: 'drain', reason: `drain job launch failed: ${error.message}` }];
  }
  return [...results, { action: 'started', step: 'drain', reason: `drain job started ${startedAt}` }];
}

/**
 * Job side: drain the pending spool and the owed filings inside `budgetMs`. A card that has not started when the budget
 * is spent stays in the spool for the next job. Always records its outcome and releases the single-flight lease.
 */
export async function runDrainJob({ stateDir = cardBatchStateDir(), token, budgetMs = DRAIN_BUDGET_MS, clock = Date.now,
  log = line => process.stdout.write(`${line}\n`), drain = landPreventionCard, fileOwed = landPreventionCard,
  batch = fileIntoBatch, loadFilingSettings = loadPreventionBatchSettings, owedStep = reconcileOwedPrevention } = {}) {
  const statePath = drainStatePath(stateDir);
  const lockPath = `${statePath}.lock`;
  const startedAt = iso(clock());
  const deadline = clock() + budgetMs;
  const pendingDir = join(stateDir, 'pending-prevention');
  const base = { startedAt, token, pid: process.pid, budgetMs };
  const failures = [];
  atomicRecord(statePath, { ...base, status: 'running' });
  try {
    if (loadFilingSettings().filingEnabled === false) {
      log('prevention filing paused by prevention.filingEnabled; nothing drained');
    } else {
      const { pending, owed } = drainWorkPending(stateDir);
      if (pending) {
        const result = await drain({ drainPending: true, session: `card-batch-drain-${randomUUID()}` }, {
          pendingDir, write: line => log(line.trimEnd()),
          batch: (input, options) => clock() >= deadline
            ? { batched: false, deferred: 'budget' }
            : batch(input, { ...options, stateDir }),
        });
        if (!result.ok) failures.push(result.reason ?? 'pending drain failed');
      }
      if (owed && clock() < deadline) {
        const results = await owedStep({ stateDir,
          file: input => fileOwed(input, { owedClaimed: true, loadFilingSettings, pendingDir,
            batch: (card, options) => batch(card, { ...options, stateDir }), write: line => log(line.trimEnd()) }),
        });
        for (const result of results) if (!result.ok) failures.push(result.reason ?? 'owed filing failed');
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
    atomicRecord(statePath, { ...base, status: 'ok', finishedAt: iso(clock()), remaining: drainWorkPending(stateDir) });
    log(`drain finished ${iso(clock())}`);
    return { ok: true };
  } catch (error) {
    log(`drain failed: ${error.message}`);
    try { atomicRecord(statePath, { ...base, status: 'failed', finishedAt: iso(clock()), error: error.message, reported: false }); } catch { /* the lease expiry still frees the slot */ }
    return { ok: false, reason: error.message };
  } finally {
    try { if (token && tokenOf(lockPath) === token) rmSync(lockPath, { force: true }); } catch { /* expires on its own */ }
  }
}

/** One-shot in-process drain with `startDrainJob`'s signature: for tests and manual runs that want the work done inline. */
export async function drainInline({ stateDir, launch = true, deps = {} } = {}) {
  if (!launch) return [];
  const result = await runDrainJob({ stateDir, ...deps });
  return result.ok ? [] : [{ action: 'error', step: 'drain', reason: result.reason }];
}
