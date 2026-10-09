#!/usr/bin/env node
/** Card xkuflno — one persistent, heartbeat-backed sampler job. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob } from '../lib/daemon-jobs-runtime.mjs';
import { createSampler, writeSnapshot } from '../lib/resource-sampler.mjs';

/** Sample immediately, then yield between attempts; a probe/storage failure never ends the job. */
export async function runSamplerLoop({ sampler, write, intervalMs = 10000,
  sleep = ms => new Promise(done => setTimeout(done, ms)), maxIterations = Infinity,
  log = line => console.error(line) }) {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2147483647) throw new TypeError('intervalMs must be a positive timer interval');
  for (let i = 0; i < maxIterations; i++) {
    try { await write(await sampler.sample()); }
    catch (error) { log(`${new Date().toISOString()} resource-sampler: ${error?.message ?? error}`); }
    if (i + 1 < maxIterations) await sleep(intervalMs);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Snapshot writes are synchronous/atomic. Leave the checkpoint at sample-loop; the runtime observes
  // the dead handle and resumes it on the next tick, rather than declaring an infinite job completed.
  process.once('SIGTERM', () => process.exit(0));
  const result = await runJob({ steps: [{ name: 'sample-loop', run: ({ input }) => runSamplerLoop({
    sampler: createSampler(), write: snapshot => writeSnapshot(snapshot, { root: input.root }),
    intervalMs: input.intervalMs ?? 10000,
  }) }] });
  if (result.outcome !== 'succeeded') console.error(`resource-sampler: ${JSON.stringify(result)}`);
  process.exitCode = result.outcome === 'succeeded' ? 0 : 1;
}
