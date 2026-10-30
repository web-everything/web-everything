// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';

const workers = vi.hoisted(() => []);
const realWorkers = vi.hoisted(() => []);
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    Worker: class extends EventEmitter {
      constructor(url, options) {
        super();
        if (url.protocol === 'data:') {
          const worker = new actual.Worker(url, options);
          realWorkers.push(worker);
          return worker;
        }
        this.termination = new Promise((resolve, reject) => {
          this.finishTermination = resolve;
          this.failTermination = reject;
        });
        this.terminate = vi.fn(() => this.termination);
        this.unref = vi.fn();
        workers.push(this);
      }
    },
  };
});

import { runProbeWorker } from '../health-watch-job.mjs';
import { runSweepWorker } from '../pr-sweep-job.mjs';

afterEach(async () => {
  for (const worker of workers.splice(0)) worker.finishTermination();
  vi.useRealTimers();
  await Promise.all(realWorkers.splice(0).map((worker) => worker.terminate()));
});

it('bounds a probe timeout while its real worker is blocked in execFileSync', async () => {
  const entered = new SharedArrayBuffer(4);
  const childScript = keepAliveScript({ maxLifetimeMs: 3000 });
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(`
    import { workerData } from 'node:worker_threads';
    import { execFileSync } from 'node:child_process';
    Atomics.store(new Int32Array(workerData.input.entered), 0, 1);
    execFileSync(process.execPath, ['-e', ${JSON.stringify(childScript)}], { timeout: 5000 });
  `)}`);
  let deadline;
  const outcome = await Promise.race([
    runProbeWorker({ input: { entered }, timeoutMs: 500, workerUrl }).catch((error) => ({ error: error.message })),
    new Promise((resolve) => { deadline = setTimeout(() => resolve('deadline missed'), 2500); }),
  ]).finally(() => clearTimeout(deadline));
  expect(Atomics.load(new Int32Array(entered), 0)).toBe(1);
  expect(outcome).toEqual({ error: 'gh probe worker timed out after 500ms' });
}, 10000);

describe.each([
  ['gh probe', () => runProbeWorker({ input: {}, timeoutMs: 100 }), 'gh probe worker timed out after 100ms'],
  ['PR sweep', () => runSweepWorker({}, { timeoutMs: 100 }), 'PR sweep worker timed out after 100ms'],
])('%s worker teardown', (_name, run, timeoutMessage) => {
  it('waits for termination within the grace period and ignores late worker events', async () => {
    vi.useFakeTimers();
    let settled = false;
    const result = run().then(
      (value) => ({ value }),
      (error) => ({ error }),
    ).then((outcome) => { settled = true; return outcome; });
    const worker = workers.at(-1);

    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    worker.emit('message', { probes: {} });
    worker.emit('error', new Error('late worker error'));
    worker.emit('exit', 1);
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.finishTermination(1);
    expect((await result).error?.message).toBe(timeoutMessage);
  });

  it('preserves the timeout error when termination rejects', async () => {
    vi.useFakeTimers();
    const result = run().catch((error) => error);
    const worker = workers.at(-1);
    await vi.advanceTimersByTimeAsync(100);
    worker.failTermination(new Error('termination failed'));
    expect((await result).message).toBe(timeoutMessage);
  });

  it('rejects after a bounded shutdown grace when termination never settles', async () => {
    vi.useFakeTimers();
    let outcome;
    const result = run().catch((error) => { outcome = error; return error; });
    const worker = workers.at(-1);
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(outcome).toBeUndefined();
    worker.emit('message', { probes: {} });
    worker.emit('error', new Error('late worker error'));
    worker.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(outcome?.message).toBe(timeoutMessage);
    expect(worker.unref).toHaveBeenCalledOnce();
    worker.failTermination(new Error('late termination failure'));
    expect(await result).toBe(outcome);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the timeout error if terminate throws synchronously', async () => {
    vi.useFakeTimers();
    const result = run().catch((error) => error);
    workers.at(-1).terminate.mockImplementation(() => { throw new Error('termination threw'); });
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).message).toBe(timeoutMessage);
    expect(vi.getTimerCount()).toBe(0);
  });
});
