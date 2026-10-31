/** Worker deadlines must not terminate an isolate while its ESM graph is still evaluating (Node 22 aborts). */
import { Worker } from 'node:worker_threads';

const READY = 'worker-deadline-ready';

/** Call after ALL imports, immediately before synchronous work. A timed-out startup must never do work. */
export async function workerDeadlineReady(data, port) {
  // The entry module itself may still be evaluating when its async entry function starts.
  await new Promise((r) => setImmediate(r));
  if (Atomics.load(data.deadlineCancel, 0) !== 0) return false;
  port.postMessage({ [READY]: true });
  return true;
}

/**
 * Cancel work at the deadline. During startup, let imports drain and skip the work; once ready, terminate
 * synchronous work. Reject only after worker exit, so callers cannot tear down its parent isolate mid-import.
 * Cancellation during loading drains module evaluation rather than forcibly interrupting the loader.
 */
export function runDeadlineWorker(url, { workerData, timeoutMs, timeoutMessage, exitMessage, WorkerClass = Worker }) {
  return new Promise((resolve, reject) => {
    const deadlineCancel = new Int32Array(new SharedArrayBuffer(4));
    const worker = new WorkerClass(url, { workerData: { ...workerData, deadlineCancel } });
    let ready = false;
    let timedOut = false;
    let settled = false;
    const timeoutError = new Error(timeoutMessage);
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const terminate = () => { worker.terminate().catch(() => {}); };
    const timer = setTimeout(() => {
      timedOut = true;
      Atomics.store(deadlineCancel, 0, 1);
      if (ready) terminate();
    }, timeoutMs);
    worker.on('message', (message) => {
      if (message?.[READY] === true) {
        ready = true;
        if (timedOut) terminate();
      } else if (!timedOut) done(resolve, message);
    });
    worker.once('error', (error) => done(reject, timedOut ? timeoutError : error));
    worker.once('exit', (code) => done(reject, timedOut ? timeoutError : new Error(exitMessage(code))));
  });
}
