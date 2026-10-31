/** Operator routing changes use the same declared operation surface as other delivery settings. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { applyRoutingOverrides, DEFAULT_ROUTING_POLICY, resolveOperationRoute } from '../lib/dispatch-routing-policy.mjs';
import { OPERATION_PROVIDER_ROSTERS, REVIEW_SEAT_PROVIDERS } from '../lib/dispatch-routing-providers.mjs';
import { resolveRoutingProviderCap } from './review-seat-policy.mjs';

export const ROUTING_OVERRIDE_OP = 'routing-override';
export const ROUTING_OVERRIDE_EFFECT = 'routing-override.write';
/** A task type no policy entry names, so resolution falls back to the bare review-seat entry. */
const ADDED_SEAT_PROBE_TASK = 'added-seat-override-probe';

/** Probe with the launcher's supported candidates, including inherited provider disables and, for the
 *  capped added-seat roster, the same per-provider daily cap the launcher applies (agy-gemini defaults to 0). */
export function resolveRoutingOverrideRoute(key, policy, { env = process.env } = {}) {
  if (!Object.hasOwn(policy.operations, key)) return; // Clearing a retired scoped key.
  const split = key.indexOf(':');
  const operation = split < 0 ? key : key.slice(0, split);
  // The bare review-seat entry is only ever launched as the fallback for an added seat (extra juror or
  // advisory lens) without its own entry, so probe it through that same added-seat resolution path.
  const taskType = split >= 0 ? key.slice(split + 1) : key === 'review-seat' ? ADDED_SEAT_PROBE_TASK : '';
  const entry = policy.operations[key];
  const disabled = entry.disabledProviders ?? [];
  const roster = OPERATION_PROVIDER_ROSTERS[key];
  const capped = roster === REVIEW_SEAT_PROVIDERS;
  const available = roster?.filter(provider => !disabled.includes(provider)
    && (!capped || resolveRoutingProviderCap(provider, env, entry) > 0));
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
