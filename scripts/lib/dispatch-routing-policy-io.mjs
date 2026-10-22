/** The only filesystem boundary for routing policy: reload, retain last-good, and forward snapshots. */
import { readFileSync } from 'node:fs';
import { ROUTING_POLICY_PATH, trustedSnapshot } from './dispatch-routing-policy-source.mjs';
import { validateRoutingPolicy, DEFAULT_ROUTING_POLICY, resolveOperationRoute as resolvePureRoute, resolvePolicyModel as resolvePureModel, operationEffort } from './dispatch-routing-policy.mjs';
import { decideDispatchRoute } from './dispatch-contracts.mjs';
import { providerQuotaHold } from './provider-quota-hold.mjs';
import { directLaunchLogLine } from './direct-launch-settings.mjs';
import { isUnderTest } from './under-test.mjs';

const defaultLog = message => { if (!isUnderTest()) console.error(message); };
function initialPolicy() {
  return trustedSnapshot(process.env.WE_DISPATCH_ROUTING_SNAPSHOT) ?? DEFAULT_ROUTING_POLICY;
}
export function createRoutingPolicyReader({ path = ROUTING_POLICY_PATH, read = readFileSync, log = message => console.error(message), initial = initialPolicy() } = {}) {
  let good = validateRoutingPolicy(initial), seen, lastError;
  return () => {
    try {
      const text = read(path, 'utf8');
      if (text !== seen) {
        seen = text;
        good = validateRoutingPolicy(JSON.parse(text));
        lastError = null;
      }
    } catch (error) {
      // Report once per bad content, but retry after a later valid edit (including a repaired missing file).
      const signature = `error:${error.message}`;
      if (lastError !== signature) log(`routing-policy-invalid: keeping last good policy: ${error.message}`);
      lastError = signature;
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
  const route = decideDispatchRoute(dispatch, { ...options, availability, routingPolicy: options.routingPolicy ?? readRoutingPolicy() });
  try { (options.log ?? defaultLog)(directLaunchLogLine({ kind: dispatch?.kind })); }
  catch { /* Logging must not prevent dispatch from returning its route. */ }
  return route;
}
export function routingPolicyEnv() {
  return { WE_DISPATCH_ROUTING_SNAPSHOT: JSON.stringify(readRoutingPolicy()) };
}

export function resolveOperationEffort(operation, provider, taskType, policy = readRoutingPolicy()) {
  return operationEffort(operation, provider, taskType, policy);
}
