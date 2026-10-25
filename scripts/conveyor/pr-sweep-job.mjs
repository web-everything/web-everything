#!/usr/bin/env node
/**
 * @file scripts/conveyor/pr-sweep-job.mjs
 * @description Card 335 — detached health-pr-sweep job adoption, consume-once and cadence housekeeping.
 */
import { mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { HEALTH_PR_SWEEP_KIND, HEALTH_WATCH_JOB_KINDS } from '../../skills-src/conveyor/daemon-manifest.mjs';
import { createJobStore, createTickClock, enqueueJob, reattachTick, runJob } from '../lib/daemon-jobs-runtime.mjs';
import { createWarmGate, evictToTrash } from './health-watch-job.mjs';
import { daemonJobsDir, deleteRun } from '../operations/run-store.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { readGit } from '../lib/proc-read.mjs';
import { resolvePrSweepSettings } from './pr-sweep.mjs';
import { resolveStallSweepSettings } from './pr-stall-sweep.mjs';
export { resolvePrSweepSettings };
export const PR_SWEEP_JOB_KIND = HEALTH_PR_SWEEP_KIND;
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '../..');
const clocks = new Map();
export function prSweepTickAllowed(flags, config) {
  return config.enabled === true && !Object.entries(flags).some(([k, v]) => v &&
    (k.endsWith('-fixture') || ['dry-run', 'no-gh', 'state-root', 'logs-dir', 'lock-root', 'claude-jobs-root', 'tmp-sweep-root', 'lane-pool-root', 'self-sync-dir', 'builder-log-dir'].includes(k)));
}
function pruneJob(store, id) {
  deleteRun(id, store.dir);
  for (const ext of ['.log', '.result', '.json.lock']) rmSync(join(store.dir, `${id}${ext}`), { force: true });
}
export async function runPrSweepJob({ now, state = {}, config, settings, sourceRoot = ROOT, dir, env = process.env,
  store = createJobStore(daemonJobsDir('health-pr-sweep', env)), enqueue = enqueueJob, reattach = reattachTick,
  evict = evictToTrash, prune = pruneJob, snapshot, codeSha, log = console.error, warmGate = {},
  stallSettings = () => resolveStallSweepSettings({ env, log }) } = {}) {
  mkdirSync(store.dir, { recursive: true });
  const mine = () => store.list().records.filter((r) => r.job.kind === PR_SWEEP_JOB_KIND.kind);
  const consumed = new Set(Array.isArray(state.consumed) ? state.consumed : []);
  const finished = [];
  for (const r of mine()) if (TERMINAL_JOB_STATUSES.includes(r.job.status) && !consumed.has(r.id)) {
    consumed.add(r.id); finished.push({ id: r.id, status: r.job.status, error: r.job.error, errors: Array.isArray(r.job.checkpoint?.data?.errors) ? r.job.checkpoint.data.errors : [] });
    log(`pr-sweep job ${r.id}: ${r.job.status}${r.job.error ? ` ${r.job.error}` : ''}`);
  }
  const next = { ...state };
  const flight = mine().find((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status));
  const last = Number(state.lastEnqueuedAt);
  // The stall sweep rides this job: when it is on, the job runs at least as often as the stall interval.
  let stall = null; try { stall = stallSettings()?.value; } catch (e) { log(`pr-sweep stall settings: ${e.message}`); }
  const interval = stall && stall.mode !== 'off' ? Math.min(config.intervalMinutes, stall.intervalMinutes) : config.intervalMinutes;
  const due = !Number.isFinite(last) || last > now || now - last >= interval * 60000;
  let enqueued = null;
  if (due && !flight) {
    const rec = enqueue({ store, kindDef: PR_SWEEP_JOB_KIND, now, codeSha: codeSha ?? readGit(['-C', sourceRoot, 'rev-parse', 'HEAD']).trim(), input: { dir, sourceRoot, ...(settings ? { settings: { value: settings.value, sources: settings.sources, errors: settings.errors } } : { config: { prSweep: config } }) } });
    enqueued = rec.id; next.lastEnqueuedAt = now;
  }
  if (!clocks.has(store.dir)) clocks.set(store.dir, createTickClock());
  const gate = createWarmGate({ jobsDir: store.dir, sourceRoot, ...warmGate });
  await reattach({ store, kinds: HEALTH_WATCH_JOB_KINDS, maxConcurrent: 1, clock: clocks.get(store.dir), snapshot: snapshot ?? { repoDir: sourceRoot }, log, launch: gate.launch });
  const records = mine();
  try { evict({ jobsDir: store.dir, referenced: records.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)).flatMap((r) => r.job.snapshotKeys ?? []) }); } catch (e) { log(`pr-sweep eviction: ${e.message}`); }
  for (const r of records) if (consumed.has(r.id) && now - Date.parse(r.job.finishedAt) > 86400000) { try { prune(store, r.id); consumed.delete(r.id); } catch (e) { log(`pr-sweep prune ${r.id}: ${e.message}`); } }
  next.consumed = [...consumed];
  return { state: next, finished, enqueued, failures: finished.flatMap((r) => r.status === 'failed' ? [r.error ?? `job ${r.id} failed`] : r.errors) };
}
// A worker keeps synchronous agent/filesystem reads from starving the job heartbeat.
if (!isMainThread && workerData?.prSweep) {
  import('./pr-sweep.mjs').then(({ runPrSweep }) => runPrSweep(workerData.input)).then((report) => parentPort.postMessage({ idle: report.idle.length, alerts: report.alerts.length, errors: report.errors })).catch((e) => { throw e; });
}
export function runSweepWorker(input, { timeoutMs = 15 * 60000, WorkerClass = Worker } = {}) {
  return new Promise((done, fail) => {
    const worker = new WorkerClass(SELF, { workerData: { prSweep: true, input } });
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => {
      finish(fail, new Error(`PR sweep worker timed out after ${timeoutMs}ms`));
      worker.terminate().catch(() => {});
    }, timeoutMs);
    worker.once('message', (r) => finish(done, r));
    worker.once('error', (e) => finish(fail, e));
    worker.once('exit', (code) => finish(fail, new Error(`PR sweep worker exited ${code} without result`)));
  });
}
// Node resolves import.meta.url, while argv[1] may retain a symlinked directory.
function isEntry(argv1) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(SELF); } catch { return resolve(argv1) === SELF; }
}
if (isMainThread && isEntry(process.argv[1])) {
  runJob({ steps: [{ name: 'pr-sweep', run: ({ input }) => runSweepWorker(input) }] }).then((r) => { process.exitCode = r.outcome === 'succeeded' ? 0 : 1; }).catch((e) => { console.error(e); process.exitCode = 1; });
}
