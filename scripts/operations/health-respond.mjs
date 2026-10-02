/** Pure read-only declaration. The CLI injects the bounded diagnostic reader; there are no sinks. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
export const HEALTH_RESPOND_OP = 'health-respond';
export function healthRespondOperation({ readDecisions } = {}) {
  if (typeof readDecisions !== 'function') throw new TypeError('health-respond requires a readDecisions reader');
  return op(HEALTH_RESPOND_OP, { input: {}, verdictFrom: 'decisions',
    decisions: compute({ reads: [], fn: () => readDecisions() }),
  });
}
