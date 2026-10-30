// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => []);
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    Worker: class extends EventEmitter {
      constructor() {
        super();
        this.termination = new Promise((resolve, reject) => {
          this.finishTermination = resolve;
          this.failTermination = reject;
        });
        this.terminate = vi.fn(() => this.termination);
        workers.push(this);
      }
    },
  };
});

import { runProbeWorker } from '../health-watch-job.mjs';
import { runSweepWorker } from '../pr-sweep-job.mjs';

afterEach(() => {
  for (const worker of workers.splice(0)) worker.finishTermination();
  vi.useRealTimers();
});

// The gh probe worker uses the shared deadline protocol (`worker-deadline.mjs`): a worker still loading modules is
// never terminated, only a worker that announced readiness is; both reject after worker EXIT, not after terminate().
describe('gh probe worker teardown', () => {
  const timeoutMessage = 'gh probe worker timed out after 100ms';
  const READY = { 'worker-deadline-ready': true };
  const start = () => {
    vi.useFakeTimers();
    let settled = false;
    const result = runProbeWorker({ input: {}, timeoutMs: 100 }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ).then((outcome) => { settled = true; return outcome; });
    return { worker: workers.at(-1), result, isSettled: () => settled };
  };

  it('terminates a ready worker at the deadline, rejects only after exit, and ignores late worker events', async () => {
    const { worker, result, isSettled } = start();
    worker.emit('message', READY);

    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(isSettled()).toBe(false);
    worker.emit('message', { probes: {} });
    await Promise.resolve();
    expect(isSettled()).toBe(false);

    worker.emit('exit', 1);
    expect((await result).error?.message).toBe(timeoutMessage);
  });

  it('never terminates a worker that is still loading; it drains until exit', async () => {
    const { worker, result, isSettled } = start();

    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(isSettled()).toBe(false);

    worker.emit('exit', 0);
    expect((await result).error?.message).toBe(timeoutMessage);
  });

  it('terminates a worker that becomes ready after the deadline, without starting its probes', async () => {
    const { worker, result } = start();
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.emit('message', READY);
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.emit('exit', 1);
    expect((await result).error?.message).toBe(timeoutMessage);
  });

  it('preserves the timeout error when termination rejects', async () => {
    const { worker, result } = start();
    worker.emit('message', READY);
    await vi.advanceTimersByTimeAsync(100);
    worker.failTermination(new Error('termination failed'));
    await Promise.resolve();
    worker.emit('exit', 1);
    expect((await result).error?.message).toBe(timeoutMessage);
  });
});

describe.each([
  ['PR sweep', () => runSweepWorker({}, { timeoutMs: 100 }), 'PR sweep worker timed out after 100ms'],
])('%s worker teardown', (_name, run, timeoutMessage) => {
  it('keeps the timeout pending until termination completes and ignores late worker events', async () => {
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
});
