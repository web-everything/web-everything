/** R755: the tick queues work; the shared job runtime owns its snapshot and liveness. */
import { statSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defineJobKind, kindRegistry } from './daemon-jobs.mjs';
import { createJobStore, enqueueJob, reattachTick, runJob } from './daemon-jobs-runtime.mjs';
import { withFileLock } from './atomic-json-file.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { reapDeadReviewRuns } from './reap-dead-review-runs.mjs';

export const REVIEW_RUN_REAP_KIND = defineJobKind({ kind: 'review-run-reap',
  entry: 'scripts/lib/review-run-reap-job.mjs', codeMode: 'readonly-tree', serial: true,
  nodeModules: true, maxAttempts: 1000 });
export const REAP_INTERVAL_MS = 15 * 60000;

/** Caller holds the ensure lock across the fresh read and enqueue. Unknown cadence refuses. */
export function ensureReviewRunReapJob({ store, codeSha, input, now }) {
  if (!Number.isFinite(now)) throw Error('review-run-reap: unreadable clock; inspect daemon clock');
  const { records, corrupt } = store.list();
  if (corrupt.length) throw Error('review-run-reap: corrupt job records; repair job store');
  const jobs = records.filter(r => r.job.kind === REVIEW_RUN_REAP_KIND.kind);
  if (jobs.some(r => !TERMINAL_JOB_STATUSES.includes(r.job.status))) return { enqueued: false, reason: 'live-job' };
  const finishes = jobs.map(r => Date.parse(r.job.finishedAt));
  if (finishes.some(t => !Number.isFinite(t) || t > now)) throw Error('review-run-reap: unreadable terminal cadence; repair job record');
  if (finishes.length && now - Math.max(...finishes) < REAP_INTERVAL_MS) return { enqueued: false, reason: 'cadence' };
  return { enqueued: true, record: enqueueJob({ store, kindDef: REVIEW_RUN_REAP_KIND,
    id: `job-review-run-reap-${randomUUID()}`, codeSha, input, now }) };
}

export async function tickReviewRunReap({ dir, codeSha, input, now = Date.now(), snapshot, env = process.env,
  log = console.error, reattach = reattachTick, ...runtime } = {}) {
  mkdirSync(dir, { recursive: true });
  const store = createJobStore(dir);
  const queued = withFileLock(join(dir, 'ensure-reap.lock'), () => ensureReviewRunReapJob({ store, codeSha, input, now }));
  log(`review-run-reap: ${queued.enqueued ? 'enqueued' : queued.reason}`);
  return reattach({ store, kinds: kindRegistry([REVIEW_RUN_REAP_KIND]), maxConcurrent: 1, snapshot, env, log, ...runtime });
}

export function validateReapInput(input) {
  if (!input || !['reviewRunsDir', 'repo', 'OPERATION_REVIEW_JOBS_DIR'].every(k => typeof input[k] === 'string' && input[k].trim())
    || !['checkout', 'pool', 'poolRoot'].every(k => typeof input.probeContext?.[k] === 'string' && input.probeContext[k].trim())) {
    throw Error('review-run-reap: missing-context; restore daemon authority input');
  }
  if (!statSync(input.reviewRunsDir).isDirectory()) throw Error('review-run-reap: reviewRunsDir is not a directory');
}

export function runReviewRunReapJob({ env = process.env, reap = reapDeadReviewRuns, reaperOptions = {}, ...runtime } = {}) {
  return runJob({ ...runtime, env, steps: [{ name: 'reap-dead-review-runs', run: async ({ input }) => {
    validateReapInput(input);
    const result = await reap({ ...reaperOptions, dir: resolve(input.reviewRunsDir), repo: input.repo,
      probeContext: input.probeContext, env: { ...env, OPERATION_REVIEW_JOBS_DIR: input.OPERATION_REVIEW_JOBS_DIR }, apply: true });
    return { result };
  } }] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runReviewRunReapJob();
  console.log(JSON.stringify(result));
  if (result.outcome !== 'succeeded') process.exitCode = 1;
}
