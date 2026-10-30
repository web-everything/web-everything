/** R258: macOS load averages include IO/lock waiters. Expose measured capacity as a read-only operation. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { renderHostCapacity } from '../readiness/host-capacity-render.mjs';
export const HOST_CAPACITY_OP = 'host-capacity';
export function hostCapacityOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('host-capacity needs a collect reader');
  return op(HOST_CAPACITY_OP, { input: {}, verdictFrom: 'read',
    read: compute({ reads: [], fn: () => collect() }),
  });
}
export function finishHostCapacity({ run, code, lines, json = false }) {
  return json || !run?.verdict ? { code, lines } : { code, lines: [renderHostCapacity(run.verdict)] };
}
