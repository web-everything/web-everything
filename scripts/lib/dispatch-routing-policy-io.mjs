/** The only filesystem boundary for routing policy: reload, retain last-good, and forward snapshots. */
import { readFileSync } from 'node:fs';
import { ROUTING_POLICY_PATH, trustedSnapshot } from './dispatch-routing-policy-source.mjs';
import { validateRoutingPolicy, applyRoutingOverrides, DEFAULT_ROUTING_POLICY, resolveOperationRoute as resolvePureRoute, resolvePolicyModel as resolvePureModel, operationEffort } from './dispatch-routing-policy.mjs';
import { readPlatformPreferences } from './policy-cascade.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { decideDispatchRoute } from './dispatch-contracts.mjs';
import { providerQuotaHold } from './provider-quota-hold.mjs';
import { resolveRoutingOverrideRoute } from './dispatch-routing-override-route.mjs';
function initialPolicy() {
  return trustedSnapshot(process.env.WE_DISPATCH_ROUTING_SNAPSHOT) ?? DEFAULT_ROUTING_POLICY;
}
export function createRoutingPolicyReader({ path = ROUTING_POLICY_PATH, read = readFileSync, log = message => console.error(message), initial = initialPolicy(), env = process.env,
  preferences = () => readPlatformPreferences({ env }), emit = event => appendDaemonEvent(event, { env }),
} = {}) {
  let good = validateRoutingPolicy(initial), seen, lastError, applied = {};
  const signature = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  return () => {
    try {
      const text = read(path, 'utf8');
      const { prefs, errors } = preferences();
      if (errors.length) throw new Error(errors.join('; '));
      const overrides = prefs.routingOverrides === undefined ? {} : prefs.routingOverrides;
      const nextSeen = signature([text, overrides]);
      if (nextSeen !== seen) {
        const next = applyRoutingOverrides(JSON.parse(text), overrides);
        for (const key of Object.keys(overrides)) resolveRoutingOverrideRoute(key, next, { env });
        for (const name of new Set([...Object.keys(applied), ...Object.keys(overrides)])) {
          if (signature(applied[name]) === signature(overrides[name])) continue;
          const split = name.indexOf(':');
          const entry = next.operations[name];
          const detail = { operation: split < 0 ? name : name.slice(0, split), taskType: split < 0 ? null : name.slice(split + 1),
            provider: entry?.provider ?? null, model: entry?.model ?? null, cleared: !Object.hasOwn(overrides, name), source: 'platform', override: overrides[name] ?? null };
          // Best effort, as with other daemon events; logging never rejects a validated policy.
          try { Promise.resolve(emit({ kind: 'routing-override-applied', detail })).catch(error => log(`routing-override-event: ${error.message}`)); }
          catch (error) { log(`routing-override-event: ${error.message}`); }
        }
        good = next;
        applied = structuredClone(overrides);
        seen = nextSeen;
      }
      lastError = null;
    } catch (error) {
      // Report once per invalid edit; keep the last validated repo + operator snapshot.
      const errorSignature = `error:${error.message}`;
      if (lastError !== errorSignature) log(`routing-policy-invalid: keeping last good policy: ${error.message}`);
      lastError = errorSignature;
    }
    return good;
  };
}
export const readRoutingPolicy = createRoutingPolicyReader();


export function resolveOperationRoute(options = {}) {
  return resolvePureRoute({ ...options, policy: options.policy ?? readRoutingPolicy() });
}
export function resolvePolicyModel(provider, model, policy = readRoutingPolicy()) {
  return resolvePureModel(provider, model, policy);
}
export function resolveDispatchRoute(dispatch, options = {}) {
  // Production callers already supply the unprojected scorecard snapshot. Derive holds before the
  // evidence router removes quota fields; neither a backend nor its checker may run while held.
  const rawRecords = Array.isArray(options.scorecards) ? options.scorecards : options.scorecards?.records;
  const records = Array.isArray(rawRecords) ? rawRecords.filter(row => row && typeof row === 'object') : [];
  const availability = { ...options.availability };
  for (const provider of ['antigravity', 'codex']) {
    const hold = providerQuotaHold(records, provider, options.now ?? Date.now());
    if (hold) availability[provider] = hold;
  }
  return decideDispatchRoute(dispatch, { ...options, availability, routingPolicy: options.routingPolicy ?? readRoutingPolicy() });
}
export function routingPolicyEnv() {
  return { WE_DISPATCH_ROUTING_SNAPSHOT: JSON.stringify(readRoutingPolicy()) };
}

export function resolveOperationEffort(operation, provider, taskType, policy = readRoutingPolicy()) {
  return operationEffort(operation, provider, taskType, policy);
}
