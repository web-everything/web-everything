// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markClaimed, markLaunching } from '../../lib/daemon-jobs.mjs';
import { formatJobHandle } from '../../operations/job-record.mjs';
import { createJobStore } from '../../lib/daemon-jobs-runtime.mjs';
import { runSamplerLoop } from '../resource-sampler-job.mjs';
import { ensureSamplerJob, RESOURCE_SAMPLE_KIND } from '../resource-sampler-daemon.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const newStore = () => { const dir = mkdtempSync(join(tmpdir(), 'resource-job-')); dirs.push(dir); return createJobStore(dir); };

describe('sampler loop', () => {
  it('samples and writes N snapshots, yielding between samples at the requested cadence', async () => {
    const sample = vi.fn().mockReturnValueOnce({ n: 1 }).mockReturnValueOnce({ n: 2 }).mockReturnValueOnce({ n: 3 });
    const write = vi.fn(); const sleep = vi.fn();
    await runSamplerLoop({ sampler: { sample }, write, sleep, intervalMs: 17, maxIterations: 3 });
    expect(write.mock.calls).toEqual([[{ n: 1 }], [{ n: 2 }], [{ n: 3 }]]);
    expect(sleep.mock.calls).toEqual([[17], [17]]);
  });
  it.each(['sample', 'write'])('logs a failing %s and continues', async (failure) => {
    const sample = vi.fn().mockResolvedValue({ n: 1 });
    const write = vi.fn(); const log = vi.fn();
    (failure === 'sample' ? sample : write).mockRejectedValueOnce(new Error('probe failed'));
    await runSamplerLoop({ sampler: { sample }, write, sleep: vi.fn(), maxIterations: 3, log });
    expect(sample).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(failure === 'sample' ? 2 : 3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('probe failed'));
  });
});

describe('ensure one sampler job', () => {
  const args = { kindDef: RESOURCE_SAMPLE_KIND, codeSha: 'a'.repeat(40), now: Date.parse('2026-10-09T22:31:02Z'), input: { intervalMs: 10000, root: '/tmp/coordination' } };
  it('queues a pinned job with its input when none exists', () => {
    const store = newStore(); const result = ensureSamplerJob({ store, ...args });
    expect(result.enqueued).toBe(true);
    expect(store.list().records).toHaveLength(1);
    expect(result.record.input).toEqual(args.input);
    expect(result.record.job).toMatchObject({ kind: 'resource-sample', status: 'queued', codeSha: args.codeSha, maxAttempts: 1000 });
  });
  it.each(['queued', 'launching', 'running'])('keeps an existing %s job across supervisor restarts', (status) => {
    const store = newStore(); const first = ensureSamplerJob({ store, ...args });
    const at = new Date(args.now).toISOString();
    const identity = { host: 'test-host', pid: 123, procStart: 'Fri Oct 9 18:31:02 2026' };
    store.update(first.record.id, r => status === 'queued' ? r : status === 'launching'
      ? markLaunching(r, { at })
      : markClaimed(markLaunching(r, { at }), { at, ...identity, handle: formatJobHandle(identity) }));
    const next = ensureSamplerJob({ store: createJobStore(store.dir), ...args });
    expect(next.enqueued).toBe(false);
    expect(next.record.id).toBe(first.record.id);
    expect(store.list().records).toHaveLength(1);
  });
  it.each(['failed', 'succeeded'])('replaces a terminal %s job even with the same timestamp', status => {
    const store = newStore(); const first = ensureSamplerJob({ store, ...args });
    store.update(first.record.id, r => ({ ...r, job: { ...r.job, status } }));
    const next = ensureSamplerJob({ store, ...args });
    expect(next.enqueued).toBe(true);
    expect(next.record.id).not.toBe(first.record.id);
    expect(store.list().records).toHaveLength(2);
  });
  it('refuses to infer absence from corrupt records', () => {
    expect(() => ensureSamplerJob({ ...args, store: { list: () => ({ records: [], corrupt: ['broken'] }) } })).toThrow(/corrupt/);
  });
});
