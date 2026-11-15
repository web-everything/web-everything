/** Read-only S1 delivery-capacity operation; collection is bound by the caller. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { renderCapacityLine } from '../lib/delivery-capacity-render.mjs';

const defaultDeps = { tune: null }; // IO is bound in run.mjs

export const DELIVERY_CAPACITY_OP = 'delivery-capacity';
export function deliveryCapacityOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('delivery-capacity needs a collect reader');
  return op(DELIVERY_CAPACITY_OP, { input: {}, verdictFrom: 'read',
    read: compute({ reads: [], fn: () => collect() }),
  });
}
export function finishDeliveryCapacity({ run, code, lines, json = false }, deps = defaultDeps) {
  const original = json || !run?.verdict ? { code, lines } : { code, lines: [renderCapacityLine(run.verdict)] };
  if (!run?.verdict) return original;
  try {
    const tuned = deps?.tune?.(run.verdict);
    if (!tuned) return original;
    return { code, lines: json ? [JSON.stringify({ ...run.verdict, autoTune: tuned.row })]
      : [renderCapacityLine(run.verdict), tuned.line] };
  } catch { return original; }
}
