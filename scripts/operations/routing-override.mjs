/** Operator routing changes use the same declared operation surface as other delivery settings. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { applyRoutingOverrides, DEFAULT_ROUTING_POLICY } from '../lib/dispatch-routing-policy.mjs';

export const ROUTING_OVERRIDE_OP = 'routing-override';
export const ROUTING_OVERRIDE_EFFECT = 'routing-override.write';

export function planRoutingOverride(input, policy = DEFAULT_ROUTING_POLICY) {
  const { operation, taskType, provider, model, clear } = input;
  const key = taskType ? `${operation}:${taskType}` : operation;
  if (!Object.hasOwn(policy.operations, key)) throw new TypeError(`routing-override: unknown operation ${key}`);
  if (clear && (provider || model)) throw new TypeError('routing-override: --clear cannot accompany --provider or --model');
  if (!clear && !provider) throw new TypeError('routing-override: --provider or --clear is required');
  const patch = clear ? null : { provider, ...(model ? { model } : {}) };
  if (patch) applyRoutingOverrides(policy, { [key]: patch });
  return { key, patch, source: 'platform', cleared: clear };
}

export function routingOverrideOperation() {
  return op(ROUTING_OVERRIDE_OP, {
    input: {
      operation: 'string',
      taskType: { type: 'string', required: false, default: '' },
      provider: { type: 'string', required: false, default: '' },
      model: { type: 'string', required: false, default: '' },
      clear: { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'plan',
    plan: compute({ reads: ['input.operation', 'input.taskType', 'input.provider', 'input.model', 'input.clear'],
      fn: view => planRoutingOverride(view.input) }),
    write: effect({ reads: ['verdict'], effects: view => [{ type: ROUTING_OVERRIDE_EFFECT,
      idempotent: true, payload: view.verdict }] }),
  });
}
