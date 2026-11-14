/** Read-only delivery policy preview; never runs a stage or changes dispatch. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const DELIVERY_FLOW_OP = 'delivery-flow';

export function deliveryFlowOperation({ readFlow } = {}) {
  if (typeof readFlow !== 'function') throw new TypeError('delivery-flow: needs readFlow');
  return op(DELIVERY_FLOW_OP, {
    input: {
      num: { type: 'string', required: false, default: '' },
      scope: { type: 'string', required: false, default: '' },
    },
    verdictFrom: 'show',
    show: compute({ reads: ['input.num', 'input.scope'], fn: ({ input }) => {
      if (input.num && input.scope) throw new Error('delivery-flow: use --num or --scope, not both');
      return readFlow(input);
    } }),
  });
}

export function finishDeliveryFlow({ run, code, lines, json = false }) {
  if (json) return { code, lines };
  const flow = run?.verdict;
  return { code, lines: flow ? [
    `delivery-flow: ${flow.class}: ${flow.stages.map(s => s.stage).join(' -> ')} (${flow.reason})`,
    `sources: ${JSON.stringify(flow.sources)}`,
  ] : lines };
}
