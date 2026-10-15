/** @file pr-sweep-job.test.mjs
 * @description Card 335 — tick adoption without subprocesses.
 */
import { it, expect, vi, afterEach } from 'vitest';
import { runPrSweepJob, prSweepTickAllowed } from '../pr-sweep-job.mjs';
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const config = { intervalMinutes: 30 };
function seams(records = []) { const root = mkdtempSync(join(tmpdir(), 'pr-sweep-job-')); roots.push(root); return { store: { dir: root, list: () => ({ records }) }, enqueue: vi.fn(() => ({ id: 'new' })), reattach: vi.fn(async () => ({})), evict: vi.fn(), prune: vi.fn(), codeSha: 'abc', sourceRoot: tmpdir(), snapshot: {} }; }
it.each(['pr-sweep-job.mjs', 'pr-sweep.mjs', 'health-watch.mjs'])('runs %s through a symlinked directory', (script) => {
  const root = mkdtempSync(join(tmpdir(), 'pr-sweep-entry-')); roots.push(root);
  const alias = join(root, 'linked-conveyor');
  symlinkSync(resolve('scripts/conveyor'), alias, 'dir');
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  for (const key of ['DAEMON_JOB_ID', 'DAEMON_JOB_ATTEMPT', 'OPERATION_RUNS_DIR']) delete env[key];
  const invoke = (path) => spawnSync(process.execPath, [path, 'invalid-command'], { env, encoding: 'utf8', timeout: 15000 });
  const path = join(alias, script);
  const direct = invoke(realpathSync(path));
  const linked = invoke(path);
  expect(direct.error).toBeUndefined(); expect(linked.error).toBeUndefined();
  expect(direct.status).toBe(script === 'pr-sweep.mjs' ? 2 : 1);
  expect(linked.status).toBe(direct.status);
  expect(linked.stdout).toBe(direct.stdout); expect(linked.stderr).toBe(direct.stderr);
});
it.each([undefined, 'missing-cli-entry'])('imports safely with argv[1]=%s', (argv1) => {
  for (const script of ['pr-sweep-job.mjs', 'pr-sweep.mjs', 'health-watch.mjs']) {
    const url = pathToFileURL(resolve('scripts/conveyor', script)).href;
    const source = `process.argv[1] = ${argv1 === undefined ? 'undefined' : JSON.stringify(argv1)}; await import(${JSON.stringify(url)});`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 15000,
    });
    expect(out.error).toBeUndefined(); expect(out.status).toBe(0);
    expect(out.stdout).toBe(''); expect(out.stderr).toBe('');
  }
});
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
