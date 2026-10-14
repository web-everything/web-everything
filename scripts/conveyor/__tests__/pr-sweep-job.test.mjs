/** @file pr-sweep-job.test.mjs
 * @description Card 335 — tick adoption without subprocesses.
 */
import { it, expect, vi, afterEach } from 'vitest';
import { runPrSweepJob, prSweepTickAllowed } from '../pr-sweep-job.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const config = { intervalMinutes: 30 };
function seams(records = []) { const root = mkdtempSync(join(tmpdir(), 'pr-sweep-job-')); roots.push(root); return { store: { dir: root, list: () => ({ records }) }, enqueue: vi.fn(() => ({ id: 'new' })), reattach: vi.fn(async () => ({})), evict: vi.fn(), prune: vi.fn(), codeSha: 'abc', sourceRoot: tmpdir(), snapshot: {} }; }
it('enqueues when due, spaces ticks and does not enqueue in flight', async () => {
  const s = seams(); const out = await runPrSweepJob({ now: 10000000, config, ...s }); expect(s.enqueue).toHaveBeenCalledOnce();
  await runPrSweepJob({ now: 10000001, state: out.state, config, ...s }); expect(s.enqueue).toHaveBeenCalledOnce();
  const busy = seams([{ id: 'a', job: { kind: 'health-pr-sweep', status: 'running' } }]);
  await runPrSweepJob({ now: 10000000, config, ...busy }); expect(busy.enqueue).not.toHaveBeenCalled(); expect(busy.reattach).toHaveBeenCalledOnce();
});
it('consumes finished records once', async () => {
  const s = seams([{ id: 'a', job: { kind: 'health-pr-sweep', status: 'succeeded', finishedAt: new Date(10000000).toISOString() } }]);
  const out = await runPrSweepJob({ now: 10000000, config, state: { lastEnqueuedAt: 10000000 }, ...s }); expect(out.finished).toHaveLength(1);
  const again = await runPrSweepJob({ now: 10000001, config, state: out.state, ...s }); expect(again.finished).toEqual([]);
});
it('health tick only allows enabled live ticks', () => {
  expect(prSweepTickAllowed({}, { enabled: true })).toBe(true);
  for (const flags of [{ 'dry-run': true }, { 'state-root': tmpdir() }, { 'ps-fixture': tmpdir() }, { 'logs-dir': tmpdir() }, { 'no-gh': true }, { 'credential-inventory-fixture': 'fixture' }]) expect(prSweepTickAllowed(flags, { enabled: true })).toBe(false);
  expect(prSweepTickAllowed({}, { enabled: false })).toBe(false);
});
it('prunes consumed records after retention and exposes failed jobs as probe failures once', async () => {
  const s = seams([{ id: 'old', job: { kind: 'health-pr-sweep', status: 'failed', finishedAt: new Date(1).toISOString(), error: 'child died' } }]);
  const out = await runPrSweepJob({ now: 100000000, state: { lastEnqueuedAt: 100000000 }, config, ...s });
  expect(out.failures).toEqual(['child died']); expect(s.prune).toHaveBeenCalledWith(s.store, 'old'); expect(out.state.consumed).toEqual([]);
});
it('bounds the worker lifetime without launching a real worker', async () => {
  const { EventEmitter } = await import('node:events');
  const { runSweepWorker } = await import('../pr-sweep-job.mjs');
  let worker;
  class FakeWorker extends EventEmitter {
    constructor() { super(); worker = this; }
    terminate = vi.fn(async () => {});
  }
  vi.useFakeTimers();
  try {
    const promise = runSweepWorker({}, { timeoutMs: 100, WorkerClass: FakeWorker });
    const rejection = expect(promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100); await rejection; expect(worker.terminate).toHaveBeenCalledOnce();
    const success = runSweepWorker({}, { WorkerClass: FakeWorker }); worker.emit('message', { errors: [] });
    expect(await success).toEqual({ errors: [] });
  } finally { vi.useRealTimers(); }
});
it('surfaces read errors from a completed child as probe errors once', async () => {
  const s = seams([{ id: 'read-errors', job: { kind: 'health-pr-sweep', status: 'succeeded', checkpoint: { data: { errors: ['agents: unreadable'] } }, finishedAt: new Date(10000000).toISOString() } }]);
  const out = await runPrSweepJob({ now: 10000000, state: { lastEnqueuedAt: 10000000 }, config, ...s });
  expect(out.failures).toEqual(['agents: unreadable']);
  expect((await runPrSweepJob({ now: 10000001, state: out.state, config, ...s })).failures).toEqual([]);
});
