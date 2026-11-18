/** R313/R349 — read-only SHADOW worker-capacity op: measured cap beside the R349 step rule. IO is injected. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { assessWorkerCapacity, renderWorkerCapacity } from '../lib/worker-capacity.mjs';

export const WORKER_CAPACITY_OP = 'worker-capacity';

export function workerCapacityOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('worker-capacity needs a collect reader');
  return op(WORKER_CAPACITY_OP, { input: {}, verdictFrom: 'assess',
    read: compute({ reads: [], fn: () => collect() }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assessWorkerCapacity(findings.read) }),
  });
}

/** Shadow log: append the row on every run; a log failure never fails the op. */
export function finishWorkerCapacity({ log } = {}) {
  return ({ run, code, lines, json = false }) => {
    if (run?.verdict) { try { log?.(run.verdict); } catch { /* evidence only */ } }
    return json || !run?.verdict ? { code, lines } : { code, lines: [renderWorkerCapacity(run.verdict)] };
  };
}
