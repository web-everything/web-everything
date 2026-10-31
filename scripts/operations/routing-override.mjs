/** Operator routing changes use the same declared operation surface as other delivery settings. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { applyRoutingOverrides, DEFAULT_ROUTING_POLICY, resolveOperationRoute } from '../lib/dispatch-routing-policy.mjs';
import { OPERATION_PROVIDER_ROSTERS } from '../lib/dispatch-routing-providers.mjs';

export const ROUTING_OVERRIDE_OP = 'routing-override';
export const ROUTING_OVERRIDE_EFFECT = 'routing-override.write';

/** Probe with the launcher's supported candidates, including inherited provider disables. */
export function resolveRoutingOverrideRoute(key, policy) {
  if (!Object.hasOwn(policy.operations, key)) return; // Clearing a retired scoped key.
  const split = key.indexOf(':');
  const operation = split < 0 ? key : key.slice(0, split);
  const taskType = split < 0 ? '' : key.slice(split + 1);
  const disabled = policy.operations[key].disabledProviders ?? [];
  const available = OPERATION_PROVIDER_ROSTERS[key]?.filter(provider => !disabled.includes(provider));
  if (available?.length === 0) throw new TypeError(`routing policy: ${key}: no available route`);
  return resolveOperationRoute({ operation, taskType, available, policy });
}

export function planRoutingOverride(input, policy = DEFAULT_ROUTING_POLICY) {
  const { operation, taskType, provider, model, clear } = input;
  const key = taskType ? `${operation}:${taskType}` : operation;
  // A scoped key must remain removable even after its operation or task type disappears.
  if (!Object.hasOwn(policy.operations, key) && !(clear && taskType)) {
    throw new TypeError(`routing-override: unknown operation ${key}`);
  }
  if (clear && (provider || model)) throw new TypeError('routing-override: --clear cannot accompany --provider or --model');
  if (!clear && !provider) throw new TypeError('routing-override: --provider or --clear is required');
  const allowedProviders = OPERATION_PROVIDER_ROSTERS[key];
  if (!clear && allowedProviders && !allowedProviders.includes(provider)) {
    throw new TypeError(`routing-override: ${key}: unsupported provider ${provider}; expected ${allowedProviders.join('|')}`);
  }
  const patch = clear ? null : { provider, ...(model ? { model } : {}) };
  if (patch) resolveRoutingOverrideRoute(key, applyRoutingOverrides(policy, { [key]: patch }));
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
