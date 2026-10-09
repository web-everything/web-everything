/**
 * @file scripts/conveyor/__tests__/health-watch-job.test.mjs
 * @description #4131 — the health-gh-probe JOB CHILD, for real: a detached process launched by the shared
 *   runtime from a pinned snapshot, whose probe body BLOCKS its worker thread the way a synchronous `execFileSync`
 *   read does. The heartbeat keeps advancing during the block (the job's own event loop is free), the result
 *   sidecar lands, and the tick side consumes it once. Plus the step's idempotent sidecar write and the worker
 *   timeout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runGhProbeJobs, ghProbeStep, runProbeWorker, RESULT_SUFFIX } from '../health-watch-job.mjs';
import { createJobStore, enqueueJob } from '../../lib/daemon-jobs-runtime.mjs';
import { HEALTH_GH_PROBE_KIND } from '../../../skills-src/conveyor/daemon-manifest.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let dir;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'health-job-child-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snapshot = {
  materialize: (into) => {
    for (const d of ['scripts', 'skills-src']) cpSync(join(REPO, d), join(into, d), { recursive: true, filter: (s) => !s.includes('__tests__') });
    for (const f of ['package.json', 'package-lock.json']) cpSync(join(REPO, f), join(into, f));
  },
  install: (into) => symlinkSync(join(REPO, 'node_modules'), join(into, 'node_modules'), 'dir'),
};

describe('health-gh-probe job child', () => {
  it('heartbeats while its worker is blocked, writes its result, and the tick consumes it once', async () => {
    const store = createJobStore(join(dir, 'jobs'));
    mkdirSync(store.dir, { recursive: true });
    const job = enqueueJob({ store, kindDef: HEALTH_GH_PROBE_KIND, codeSha: 'test-snapshot', input: { sourceRoot: REPO, proofBlockMs: 2500 } });
    const opts = { store, codeSha: 'test-snapshot', snapshot, input: { sourceRoot: REPO }, reattachOpts: { heartbeatIntervalMs: 200 } };
    let state = {};
    const beats = new Set();
    let consumed = null;
    for (let i = 0; i < 100 && !consumed; i += 1) {
      const out = await runGhProbeJobs({ ...opts, now: Date.now(), due: false, state });
      state = out.state;
      const rec = store.read(job.id);
      if (rec?.job.status === 'running') beats.add(rec.job.heartbeatAt);
      if (out.result) consumed = out.result;
      await sleep(250);
    }
    if (!consumed) console.error(JSON.stringify(store.read(job.id)?.job), existsSync(join(store.dir, `${job.id}.log`)) ? readFileSync(join(store.dir, `${job.id}.log`), 'utf8') : 'no log');
    expect(consumed?.jobId).toBe(job.id);
    expect(beats.size).toBeGreaterThanOrEqual(4); // the heartbeat moved during the 2.5 s block
    const rec = store.read(job.id);
    expect(rec.job.status).toBe('succeeded');
    expect(rec.job.attempts).toBe(1);
    expect(rec.job.checkpoint.data.resultFile).toBe(`${job.id}${RESULT_SUFFIX}`);
    const again = await runGhProbeJobs({ ...opts, now: Date.now(), due: false, state });
    expect(again.result).toBeNull();
  }, 60000);

  it('the step writes its sidecar atomically and is idempotent on a rerun', async () => {
    const d = mkdtempSync(join(dir, 'step-'));
    const runWorker = async ({ input }) => ({ probes: { prs: [{ number: input.now }] }, errors: {} });
    const a = await ghProbeStep({ jobId: 'job-x', input: {}, dir: d, runWorker, now: () => 5 });
    const b = await ghProbeStep({ jobId: 'job-x', input: {}, dir: d, runWorker, now: () => 6 });
    expect(a.resultFile).toBe(b.resultFile);
    const body = JSON.parse(readFileSync(join(d, `job-x${RESULT_SUFFIX}`), 'utf8'));
    expect(body.probes.prs[0].number).toBe(6);
    expect(existsSync(join(d, `job-x${RESULT_SUFFIX}.tmp-${process.pid}`))).toBe(false);
  });

  it('a worker that does not answer in time is terminated and the step fails', async () => {
    const t0 = Date.now();
    await expect(runProbeWorker({ input: { proofBlockMs: 10_000 }, timeoutMs: 500 })).rejects.toThrow(/timed out after 500ms/);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15000);
});
