// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markClaimed, markLaunching } from '../../lib/daemon-jobs.mjs';
import { formatJobHandle } from '../../operations/job-record.mjs';
import { createJobStore, enqueueJob } from '../../lib/daemon-jobs-runtime.mjs';
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
  it('stops writing the moment the job no longer owns its record (a superseded sampler is never a second writer)', async () => {
    const sample = vi.fn().mockResolvedValue({ n: 1 });
    const write = vi.fn();
    const owns = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await runSamplerLoop({ sampler: { sample }, write, sleep: vi.fn(), intervalMs: 5, maxIterations: 10, owns });
    expect(write).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenCalledTimes(2);
  });
  it('skips the write but keeps looping when ownership is UNKNOWN (record unreadable) — never ends the infinite job', async () => {
    const sample = vi.fn().mockResolvedValue({ n: 1 });
    const write = vi.fn(); const log = vi.fn();
    const owns = vi.fn().mockRejectedValueOnce(new Error('record unreadable')).mockResolvedValue(true);
    await runSamplerLoop({ sampler: { sample }, write, sleep: vi.fn(), intervalMs: 5, maxIterations: 3, owns, log });
    expect(sample).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('record unreadable'));
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
  it('retires a live job pinned to OLDER code and queues one on the current sha (live 2026-10-09: a fix never reached the running sampler)', () => {
    const store = newStore(); const first = ensureSamplerJob({ store, ...args, codeSha: 'b'.repeat(40) });
    const retired = [];
    const next = ensureSamplerJob({ store, ...args, retire: (record) => retired.push(record.id) });
    expect(retired).toEqual([first.record.id]);
    expect(store.read(first.record.id).job).toMatchObject({ status: 'failed' });
    expect(store.read(first.record.id).job.error).toMatch(/superseded by a{7}/);
    expect(next).toMatchObject({ enqueued: true });
    expect(next.record.job.codeSha).toBe(args.codeSha);
  });
  it.each([
    ['interval', { ...args.input, intervalMs: 2500 }],
    ['root', { ...args.input, root: '/tmp/other-coordination' }],
  ])('applies a changed %s config on restart: retires the live job on the same sha and queues one with the new input', (_name, changed) => {
    const store = newStore(); const first = ensureSamplerJob({ store, ...args });
    const retired = [];
    const next = ensureSamplerJob({ store, ...args, input: changed, retire: (record) => retired.push(record.id) });
    expect(retired).toEqual([first.record.id]);
    expect(store.read(first.record.id).job).toMatchObject({ status: 'failed' });
    expect(store.read(first.record.id).job.error).toMatch(/config changed/);
    expect(next).toMatchObject({ enqueued: true });
    expect(next.record.input).toEqual(changed);
    expect(next.record.job.codeSha).toBe(args.codeSha);
  });
  it('does not restart for a different checkout path at the same sha (two checkouts must not retire each other every tick)', () => {
    const store = newStore(); const first = ensureSamplerJob({ store, ...args, input: { ...args.input, checkoutRoot: '/a' } });
    const next = ensureSamplerJob({ store, ...args, input: { ...args.input, checkoutRoot: '/b' }, retire: () => { throw new Error('must not retire'); } });
    expect(next).toMatchObject({ enqueued: false });
    expect(next.record.id).toBe(first.record.id);
  });
  it('a retire that throws never loses the process: the handle stays on the failed record and the next call retires it', () => {
    const store = newStore(); const first = ensureSamplerJob({ store, ...args, codeSha: 'b'.repeat(40) });
    const at = new Date(args.now).toISOString();
    const identity = { host: 'test-host', pid: 77, procStart: 'Fri Oct 9 18:31:02 2026' };
    const handle = formatJobHandle(identity);
    store.update(first.record.id, r => markClaimed(markLaunching(r, { at }), { at, ...identity, handle }));
    expect(() => ensureSamplerJob({ store, ...args, retire: () => { throw new Error('ps timed out'); } })).toThrow(/ps timed out/);
    expect(store.read(first.record.id).job).toMatchObject({ status: 'failed', handle: null, retiredHandle: handle });
    const retired = [];
    const next = ensureSamplerJob({ store, ...args, retire: (record) => retired.push(record.job.handle) });
    expect(retired).toEqual([handle]);
    expect(store.read(first.record.id).job.retiredHandle).toBeNull();
    expect(next).toMatchObject({ enqueued: true });
    retired.length = 0;
    ensureSamplerJob({ store, ...args, retire: (record) => retired.push(record.job.handle) });
    expect(retired).toEqual([]); // settled: not retried again
  });
  it('treats the same config with reordered keys as unchanged', () => {
    const store = newStore(); const first = ensureSamplerJob({ store, ...args });
    const next = ensureSamplerJob({ store, ...args, input: { root: args.input.root, intervalMs: args.input.intervalMs }, retire: () => { throw new Error('must not retire'); } });
    expect(next).toMatchObject({ enqueued: false });
    expect(next.record.id).toBe(first.record.id);
  });
  it('retires the process that claimed the job DURING replacement, not the unclaimed record it first read', () => {
    const store = newStore(); const first = ensureSamplerJob({ store, ...args, codeSha: 'b'.repeat(40) });
    const at = new Date(args.now).toISOString();
    const identity = { host: 'test-host', pid: 4242, procStart: 'Fri Oct 9 18:31:02 2026' };
    const handle = formatJobHandle(identity);
    store.update(first.record.id, r => markLaunching(r, { at }));
    const stale = store.read(first.record.id); // what ensure read: launching, no handle yet
    // The child claims after ensure listed the record but before it replaced it.
    const racing = { ...store, list: () => { const out = store.list(); store.update(first.record.id, r => markClaimed(r, { at, ...identity, handle })); return { ...out, records: [stale] }; } };
    const retired = [];
    ensureSamplerJob({ store: racing, ...args, retire: (record) => retired.push({ id: record.id, handle: record.job.handle }) });
    expect(retired).toEqual([{ id: first.record.id, handle }]);
    expect(store.read(first.record.id).job).toMatchObject({ status: 'failed', handle: null });
  });
  it('a child that tries to claim after the job was replaced is refused (cannot become a second writer)', async () => {
    const { runJob } = await import('../../lib/daemon-jobs-runtime.mjs');
    const store = newStore(); const first = ensureSamplerJob({ store, ...args, codeSha: 'b'.repeat(40) });
    store.update(first.record.id, r => markLaunching(r, { at: new Date(args.now).toISOString() }));
    ensureSamplerJob({ store, ...args });
    const step = vi.fn();
    const result = await runJob({ steps: [{ name: 'sample-loop', run: step }],
      env: { DAEMON_JOB_ID: first.record.id, DAEMON_JOB_ATTEMPT: '1', OPERATION_RUNS_DIR: store.dir } });
    expect(result).toMatchObject({ outcome: 'refused', code: 'already-finished' });
    expect(step).not.toHaveBeenCalled();
  });
  it('retires EVERY other live sampler job, so exactly one stays live', () => {
    const store = newStore();
    const keep = ensureSamplerJob({ store, ...args, now: args.now - 2000 });
    const extra = enqueueJob({ store, kindDef: RESOURCE_SAMPLE_KIND, id: 'resource-sample-extra', codeSha: 'c'.repeat(40), now: args.now, input: args.input });
    const retired = [];
    const next = ensureSamplerJob({ store, ...args, retire: (record) => retired.push(record.id) });
    expect(next).toMatchObject({ enqueued: false });
    expect(next.record.id).toBe(keep.record.id);
    expect(retired).toEqual([extra.id]);
    expect(store.list().records.filter(r => !['failed', 'succeeded'].includes(r.job.status))).toHaveLength(1);
  });
  it('refuses to infer absence from corrupt records', () => {
    expect(() => ensureSamplerJob({ ...args, store: { list: () => ({ records: [], corrupt: ['broken'] }) } })).toThrow(/corrupt/);
  });
});
