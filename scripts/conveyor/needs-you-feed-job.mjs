#!/usr/bin/env node
/** Card 359 — persistent sha-pinned attention producer, supervised by health-watch. */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createWarmGate } from './health-watch-job.mjs';
import { ensureSamplerJob } from './resource-sampler-daemon.mjs';
import { defineJobKind, kindRegistry, markFailed } from '../lib/daemon-jobs.mjs';
import { createJobStore, runJob, selfHandle, reattachTick, probeHandle } from '../lib/daemon-jobs-runtime.mjs';
import { parseJobHandle, TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { daemonJobsDir } from '../operations/run-store.mjs';
import { withFileLock } from '../lib/atomic-json-file.mjs';
import { readGit } from '../lib/proc-read.mjs';
import { CHECKOUT_ROOT, runOnce, resolveSettings, readSettings, logSettings, checkedFeedPath } from '../operations/needs-you-feed.mjs';

export const NEEDS_YOU_FEED_KIND = defineJobKind({ kind: 'needs-you-feed', entry: 'scripts/conveyor/needs-you-feed-job.mjs', codeMode: 'readonly-tree', nodeModules: true, maxAttempts: 1000 });
export async function runFeedLoop({ run, owns = () => true, intervalMs = 120000,
  sleep = ms => new Promise(done => setTimeout(done, ms)), log = console.error, maxIterations = Infinity, clock = Date.now }) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 2147483647) throw new Error('needs-you-feed: invalid interval');
  for (let i = 0; i < maxIterations; i++) {
    const started = clock();
    try { if (!await owns()) return; await run(); }
    catch (error) { log(`needs-you-feed: ${error?.message ?? error}`); }
    if (i + 1 < maxIterations) await sleep(Math.max(0, intervalMs - (clock() - started)));
  }
}
/** The shared supervisor's config/sha retirement transaction, with a distinct job kind. */
export function ensureNeedsYouFeedJob(options) { return ensureSamplerJob({ ...options, kindDef: NEEDS_YOU_FEED_KIND }); }
function retireFeedJob(record) {
  if (record.job.handle && probeHandle(record.job.handle) === 'alive') {
    try { process.kill(parseJobHandle(record.job.handle).pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
/** Revoke ownership before signalling; persist the handle so an interrupted/failed signal is retried. */
function retireDisabledFeedJobs({ store, now, retire }) {
  const { records, corrupt } = store.list();
  if (corrupt.length) throw new Error(`needs-you-feed: corrupt job records: ${corrupt.join(', ')}`);
  let retireError;
  for (const record of records) {
    if (record.job.kind !== NEEDS_YOU_FEED_KIND.kind) continue;
    const failed = store.update(record.id, fresh => {
      if (TERMINAL_JOB_STATUSES.includes(fresh.job.status)) return fresh.job.retiredHandle ? fresh : null;
      const next = markFailed(fresh, { at: new Date(now).toISOString(), reason: 'needs-you-feed disabled' });
      return { ...next, job: { ...next.job,
          retiredHandle: fresh.job.handle ?? fresh.job.retiredHandle ?? null } };
    });
    if (!failed?.job.retiredHandle) continue;
    try {
      retire({ ...failed, job: { ...failed.job, handle: failed.job.retiredHandle } });
      store.update(record.id, fresh => ({ ...fresh, job: { ...fresh.job, retiredHandle: null } }));
    } catch (error) { retireError ??= error; }
  }
  if (retireError) throw retireError;
  return { disabled: true };
}
/** Tick-side IO. Serialize enqueue transactions; the runtime atomically claims launches. Jobs run in snapshots, never input.checkoutRoot. */
export async function superviseNeedsYouFeed({ checkoutRoot = CHECKOUT_ROOT, env = process.env, now = Date.now(),
  settings = resolveSettings({ env, file: readSettings(checkoutRoot) }), dir = daemonJobsDir('needs-you-feed'), log = console.error, codeSha: requestedSha,
  reattach = reattachTick, warmGate = {}, retire = retireFeedJob } = {}) {
  logSettings(settings, log);
  if (!settings.enabled.value) {
    if (!existsSync(dir)) return { disabled: true };
    return withFileLock(join(dir, 'ensure-feed.lock'), () => retireDisabledFeedJobs({ store: createJobStore(dir), now, retire }));
  }
  checkedFeedPath(settings.path.value);
  const codeSha = requestedSha ?? (basename(dirname(checkoutRoot)) === 'code' && /^[a-f0-9]{40}$/.test(basename(checkoutRoot))
    ? basename(checkoutRoot) : readGit(['rev-parse', 'HEAD'], { cwd: checkoutRoot, timeout: 10000 }).trim());
  mkdirSync(dir, { recursive: true });
  const store = createJobStore(dir);
  const result = withFileLock(join(dir, 'ensure-feed.lock'), () => ensureNeedsYouFeedJob({ store, codeSha, now, input: { intervalMs: settings.intervalMinutes.value * 60000,
      path: settings.path.value, settings }, retire }));
  const kinds = kindRegistry([NEEDS_YOU_FEED_KIND]);
  const gate = createWarmGate({ jobsDir: dir, sourceRoot: checkoutRoot, kinds, ...warmGate });
  await reattach({ store, kinds, maxConcurrent: 1, snapshot: { repoDir: checkoutRoot }, log, launch: gate.launch });
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once('SIGTERM', () => process.exit(0));
  const store = createJobStore(process.env.OPERATION_RUNS_DIR);
  const asyncExec = promisify(execFile);
  const result = await runJob({ steps: [{ name: 'feed-loop', run: ({ jobId, input }) => {
    const { handle } = selfHandle();
    const owns = () => { const record = store.read(jobId); return record?.job.handle === handle && record.job.status === 'running'; };
    // Input retains the current supervisor's resolved values AND provenance.
    const pinnedSettings = input.settings; logSettings(pinnedSettings);
    return runFeedLoop({ owns, intervalMs: input.intervalMs, run: () => runOnce({ checkoutRoot: CHECKOUT_ROOT,
      settings: pinnedSettings, owns, log: () => {}, exec: async (...args) => (await asyncExec(...args)).stdout }) });
  } }] });
  if (result.outcome !== 'succeeded') console.error(`needs-you-feed: ${JSON.stringify(result)}`);
  process.exitCode = result.outcome === 'succeeded' || result.code === 'superseded' ? 0 : 1;
}
