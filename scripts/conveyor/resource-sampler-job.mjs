#!/usr/bin/env node
/** Card xkuflno — one persistent, heartbeat-backed sampler job. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobStore, runJob, selfHandle } from '../lib/daemon-jobs-runtime.mjs';
import { createSampler, writeSnapshot } from '../lib/resource-sampler.mjs';

/**
 * Sample immediately, then yield between attempts; a probe/storage failure never ends the job.
 * `owns` is asked right before every snapshot write: once the job record no longer names this process (the
 * supervisor replaced it) the loop returns instead, so a replaced sampler is never a second snapshot writer.
 */
export async function runSamplerLoop({ sampler, write, intervalMs = 10000,
  sleep = ms => new Promise(done => setTimeout(done, ms)), maxIterations = Infinity,
  log = line => console.error(line), owns = () => true }) {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2147483647) throw new TypeError('intervalMs must be a positive timer interval');
  for (let i = 0; i < maxIterations; i++) {
    try {
      const snapshot = await sampler.sample();
      if (!(await owns())) return;
      await write(snapshot);
    } catch (error) { log(`${new Date().toISOString()} resource-sampler: ${error?.message ?? error}`); }
    if (i + 1 < maxIterations) await sleep(intervalMs);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Snapshot writes are synchronous/atomic. Leave the checkpoint at sample-loop; the runtime observes
  // the dead handle and resumes it on the next tick, rather than declaring an infinite job completed.
  process.once('SIGTERM', () => process.exit(0));
  const store = createJobStore(process.env.OPERATION_RUNS_DIR);
  const result = await runJob({ steps: [{ name: 'sample-loop', run: ({ jobId, input }) => {
    const { handle } = selfHandle();
    return runSamplerLoop({
      sampler: createSampler(input.checkoutRoot ? { checkoutRoot: input.checkoutRoot } : {}), write: snapshot => writeSnapshot(snapshot, { root: input.root }),
      intervalMs: input.intervalMs ?? 10000,
      // Three-way: a record naming another handle (or none) returns; an UNREADABLE record throws, which the loop
      // logs as a skipped write — no snapshot is written, but the infinite job is never ended by a read error.
      owns: () => store.read(jobId)?.job.handle === handle,
    });
  } }] });
  if (result.outcome !== 'succeeded') console.error(`resource-sampler: ${JSON.stringify(result)}`);
  // A replaced sampler stopping is the intended outcome, not a failure to retry.
  process.exitCode = result.outcome === 'succeeded' || result.code === 'superseded' ? 0 : 1;
}
