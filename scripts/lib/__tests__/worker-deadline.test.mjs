import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDeadlineWorker } from '../worker-deadline.mjs';

let worker;
class FakeWorker extends EventEmitter {
  constructor(url, options) { super(); worker = this; this.data = options.workerData; }
  terminate = vi.fn(async () => { this.emit('exit', 1); });
}
const run = () => runDeadlineWorker('fixture', { WorkerClass: FakeWorker, workerData: { input: 'kept' },
  timeoutMs: 100, timeoutMessage: 'deadline exceeded', exitMessage: (code) => `exit ${code}` });
afterEach(() => vi.useRealTimers());

describe('worker deadlines during ESM startup', () => {
  it('cancels startup without termination, ignores late results, and rejects after the loader exits', async () => {
    vi.useFakeTimers();
    const promise = run();
    const rejection = expect(promise).rejects.toThrow('deadline exceeded');
    expect(worker.data.input).toBe('kept');
    await vi.advanceTimersByTimeAsync(100);
    expect(Atomics.load(worker.data.deadlineCancel, 0)).toBe(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit('message', { stale: 'result' });
    worker.emit('exit', 0);
    await rejection;
  });

  it('terminates ready work at the deadline and preserves the timeout diagnosis', async () => {
    vi.useFakeTimers();
    const promise = run();
    const rejection = expect(promise).rejects.toThrow('deadline exceeded');
    worker.emit('message', { 'worker-deadline-ready': true });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('handles readiness racing with the deadline without accepting a late success', async () => {
    vi.useFakeTimers();
    const promise = run();
    const rejection = expect(promise).rejects.toThrow('deadline exceeded');
    await vi.advanceTimersByTimeAsync(100);
    worker.emit('message', { 'worker-deadline-ready': true });
    worker.emit('message', { stale: 'success' });
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('returns a successful result and clears its deadline', async () => {
    vi.useFakeTimers();
    const promise = run();
    worker.emit('message', { 'worker-deadline-ready': true });
    worker.emit('message', { result: 'ok' });
    expect(await promise).toEqual({ result: 'ok' });
    await vi.advanceTimersByTimeAsync(200);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(Atomics.load(worker.data.deadlineCancel, 0)).toBe(0);
  });

  it('reports worker load errors and exits without results', async () => {
    const failed = run();
    worker.emit('error', new Error('module load failed'));
    await expect(failed).rejects.toThrow('module load failed');
    const exited = run();
    worker.emit('exit', 3);
    await expect(exited).rejects.toThrow('exit 3');
  });

  it('drains a real delayed ESM import, skips cancelled work, and exits without a native loader crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-deadline-import-'));
    try {
      const helper = pathToFileURL(resolve('scripts/lib/worker-deadline.mjs')).href;
      const entry = join(dir, 'entry.mjs');
      writeFileSync(entry, `import { workerData, parentPort } from 'node:worker_threads';
import { workerDeadlineReady } from ${JSON.stringify(helper)};
await new Promise((r) => setTimeout(r, 450));
Atomics.store(workerData.input.state, 0, 1);
if (await workerDeadlineReady(workerData, parentPort)) {
  Atomics.store(workerData.input.state, 1, 1);
  parentPort.postMessage({ result: 'must not run' });
}
`);
      const probe = join(dir, 'probe.mjs');
      writeFileSync(probe, `import { runDeadlineWorker } from ${JSON.stringify(helper)};
const state = new Int32Array(new SharedArrayBuffer(8));
try {
  await runDeadlineWorker(new URL(${JSON.stringify(pathToFileURL(entry).href)}), { workerData: { input: { state } },
    timeoutMs: 20, timeoutMessage: 'startup cancelled', exitMessage: (code) => 'unexpected exit ' + code });
  throw new Error('unexpected success');
} catch (error) {
  console.log(JSON.stringify({ error: error.message, imported: Atomics.load(state, 0), ran: Atomics.load(state, 1) }));
}
`);
      const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 15_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ error: 'startup cancelled', imported: 1, ran: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
