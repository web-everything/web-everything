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

describe.each([
  ['gh probe', () => runProbeWorker({ input: {}, timeoutMs: 100 }), 'gh probe worker timed out after 100ms'],
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
