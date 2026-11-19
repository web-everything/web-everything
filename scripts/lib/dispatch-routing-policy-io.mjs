/** The only filesystem boundary for routing policy: reload, retain last-good, and forward snapshots. */
import { readFileSync } from 'node:fs';
import { ROUTING_POLICY_PATH, trustedSnapshot } from './dispatch-routing-policy-source.mjs';
import { validateRoutingPolicy, applyRoutingOverrides, DEFAULT_ROUTING_POLICY, resolveOperationRoute as resolvePureRoute, resolvePolicyModel as resolvePureModel, operationEffort, defaultPolicyModel } from './dispatch-routing-policy.mjs';
import { readPlatformPreferences } from './policy-cascade.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { decideDispatchRoute, MARKER_KINDS } from './dispatch-contracts.mjs';
import { BUILD_KINDS, effectiveBuilder, resolveRoutingSettings } from './routing-settings.mjs';
import { providerQuotaHold } from './provider-quota-hold.mjs';
import { chooseBuilder, launcherCapacity } from './provider-capacity.mjs';
import { observeCapacity } from './provider-capacity-io.mjs';
import { resolveRoutingOverrideRoute } from './dispatch-routing-override-route.mjs';
function initialPolicy(env) {
  return trustedSnapshot(env.WE_DISPATCH_ROUTING_SNAPSHOT) ?? DEFAULT_ROUTING_POLICY;
}
export function createRoutingPolicyReader({ path = ROUTING_POLICY_PATH, read = readFileSync, log = message => console.error(message), env = process.env, initial = initialPolicy(env),
  preferences = () => readPlatformPreferences({ env }), emit = event => appendDaemonEvent(event, { env }),
} = {}) {
  let good = validateRoutingPolicy(initial), seen, lastError, applied = {};
  // Legacy/forwarded snapshots carry values without override provenance. Protect
  // every operation until one successful read supplies values and keys together.
  let operatorKeys = Object.keys(good.operations);
  const signature = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  const reader = () => {
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
        operatorKeys = Object.keys(applied);
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
  reader.operatorKeys = () => [...operatorKeys];
  return reader;
}
export const readRoutingPolicy = createRoutingPolicyReader();


export function resolveOperationRoute(options = {}, { readPolicy = readRoutingPolicy } = {}) {
  const policy = options.policy ?? readPolicy();
  const key = `${options.operation}:${options.taskType}`;
  const settings = { ...resolveRoutingSettings({ env: options.env ?? process.env }).capacity, ...options.providerCapacity };
  if (BUILD_KINDS.includes(options.operation) && settings.enabled !== false && settings.minimumTiers?.[key] !== undefined && policy.operations[key]?.inherit) {
    const now = options.now ?? Date.now();
    let capacities = launcherCapacity(options.capacity ?? observeCapacity({ env: options.env ?? process.env, now, settings }), settings);
    const allUnknown = capacities.every(c => !c.held && !c.windows.some(w => Number.isFinite(w.usedPercent)));
    const rejections = [];
    while (capacities.length) {
      const decision = chooseBuilder({ kind: options.operation, capacities, settings: { ...settings, routeKey: key, now }, fallback: null });
      if (!decision.provider) {
        rejections.push(...decision.inputs.map(i => `${i.provider}: ${i.label}`));
        break;
      }
      const entry = { ...policy.operations[key], inherit: undefined,
        provider: decision.launcher === 'antigravity' ? decision.provider : decision.launcher ?? decision.provider,
        model: decision.model, fallback: policy.operations[key].fallback ?? [],
        disabledProviders: [...new Set([...(policy.operations[options.operation]?.disabledProviders ?? []), ...(policy.operations[key].disabledProviders ?? [])])] };
      // Policy and AI overlays can select fallbacks inside the pure resolver. Every
      // returned rung must satisfy capacity eligibility as well as caller availability.
      const available = decision.inputs.filter(input => input.allowed && (
        (!input.emergencyOnly && input.score !== null)
        || (decision.reason === 'unknown-emergency' && input.provider === decision.provider && input.account === decision.account)
      )).map(input => input.launcher === 'antigravity' ? input.provider : input.launcher ?? input.provider)
        .filter(provider => !options.available || options.available.includes(provider));
      try {
        const route = resolvePureRoute({ ...options, available, providerCapacity: settings,
          policy: { ...policy, operations: { ...policy.operations, [key]: entry } } });
        if (route) return { ...route, fallback: route.fallback.filter(rung => available.includes(rung.provider)), source: 'capacity-score' };
      } catch (error) { rejections.push(error.message); }
      capacities = capacities.filter(c => c.provider !== decision.provider || (c.account ?? null) !== (decision.account ?? null));
    }
    if (!allUnknown) throw new Error(`no eligible capacity: ${rejections.join('; ')}; wait for quota reset or clear provider hold`);
  }
  return resolvePureRoute({ ...options, policy, providerCapacity: options.providerCapacity ?? settings,
    operatorKeys: options.operatorKeys ?? (options.policy === undefined ? readPolicy.operatorKeys() : undefined) });
}
export function resolvePolicyModel(provider, model, policy = readRoutingPolicy()) {
  return resolvePureModel(provider, model, policy);
}
export function resolveDispatchRoute(dispatch, options = {}) {
  // Normalise the kind once and hand the same value to the router, so a padded or upper-cased kind can neither
  // slip past the build-kind hold here nor be read as a different kind there.
  if (typeof dispatch?.kind === 'string') {
    const kind = dispatch.kind.trim().toLowerCase();
    if (kind !== dispatch.kind) dispatch = { ...dispatch, kind };
  }
  // Production callers already supply the unprojected scorecard snapshot. Derive holds before the
  // evidence router removes quota fields; neither a backend nor its checker may run while held.
  const rawRecords = Array.isArray(options.scorecards) ? options.scorecards : options.scorecards?.records;
  const records = Array.isArray(rawRecords) ? rawRecords.filter(row => row && typeof row === 'object') : [];
  const availability = { ...options.availability };
  for (const provider of ['antigravity', 'codex']) {
    const hold = providerQuotaHold(records, provider, options.now ?? Date.now());
    if (hold) availability[provider] = hold;
  }
  // routing.builder=claude: Codex is held for build kinds only; audit and review seats still use it.
  // Resolve the builder once, so an `auto` quota reading cannot change between the refusal and the hold.
  const taskType = dispatch.kind === 'fix' ? dispatch.takeover ? 'takeover' : dispatch.rulingNotAddressed ? 'ruling-not-addressed'
    : dispatch.taskType : dispatch.taskType;
  const routeKey = taskType ? `${dispatch.kind}:${taskType}` : dispatch.kind;
  const builder = BUILD_KINDS.includes(dispatch?.kind) ? effectiveBuilder({ kind: dispatch.kind, env: options.env ?? process.env, now: options.now ?? Date.now(), records, capacity: options.capacity, routeKey, queuedDemand: options.queuedDemand ?? options.queuedDispatches?.filter(d => BUILD_KINDS.includes(d.kind)).length ?? 1, demandRatePerHour: options.demandRatePerHour }) : null;
  if (builder?.decision?.provider === null) return { outcome: 'refused', refusal: 'no eligible capacity; wait for quota reset or clear provider hold', auditTrail: [] };
  for (const input of builder?.decision?.inputs ?? []) {
    if (['held', 'exhausted'].includes(input.label)) availability[input.provider.startsWith('agy-') ? 'antigravity' : input.provider] = `capacity: ${input.label}`;
  }
  const claudeBuilds = builder?.builder === 'claude';
  // Only the marker kinds read deliveryAgent (dispatch-contracts ignores it elsewhere), so only they count as explicit.
  const explicitCodex = MARKER_KINDS.includes(dispatch?.kind) && String(dispatch?.deliveryAgent ?? '').trim().toLowerCase() === 'codex';
  if (claudeBuilds && explicitCodex && builder.settings.codexReserveForAudit) {
    return { outcome: 'refused', refusal: 'deliveryAgent=codex refused: routing.builder=claude and codexReserveForAudit is true (Codex quota is reserved for audits); set codexReserveForAudit=false or routing.builder=codex to honour it', auditTrail: [] };
  }
  // With the reserve off, an explicit deliveryAgent=codex is honoured (the refusal above promises this); every other build stays held.
  if (claudeBuilds && !explicitCodex && !availability.codex) {
    availability.codex = 'routing.builder=claude: Codex is reserved for audit';
  }
  // builder=claude asks for Claude, so a ci-heal whose probation roster is all held runs on native Claude instead of
  // being refused — unless native Claude is held too (from the caller or from a quota scorecard).
  const ciHealNativeHold = dispatch?.kind === 'ci-heal'
    ? (availability.claude || options.ciHealAvailability?.claude || providerQuotaHold(records, 'claude', options.now ?? Date.now()) || null)
    : null;
  const ciHealNativeFallback = claudeBuilds && dispatch?.kind === 'ci-heal' && !ciHealNativeHold;
  let routingPolicy = options.routingPolicy ?? readRoutingPolicy();
  if (BUILD_KINDS.includes(dispatch.kind) && (builder?.decision?.reason === 'capacity-score' || builder?.decision?.reason === 'unknown-emergency')) {
    const provider = builder.decision.launcher === 'codex' ? 'codex' : builder.builder;
    const project = (entry, parent = {}) => {
      const existing = { ...parent, ...entry };
      const next = { ...existing, provider, fallback: existing.fallback ?? [],
        ...(existing.provider !== provider ? { model: builder.decision.model ?? defaultPolicyModel(provider) } : {}) };
      if (parent.disabledProviders || entry?.disabledProviders) next.disabledProviders = [...new Set([...(parent.disabledProviders ?? []), ...(entry?.disabledProviders ?? [])])];
      delete next.inherit;
      return next;
    };
    // Capacity changes provider selection only; preserve every operation's controls and effort.
    routingPolicy = { ...routingPolicy, operations: { ...routingPolicy.operations,
      [dispatch.kind]: project(routingPolicy.operations[dispatch.kind]),
      ...Object.fromEntries(Object.keys(routingPolicy.operations).filter(k => k.startsWith(`${dispatch.kind}:`) && routingPolicy.operations[k].inherit).map(k => [k, project(routingPolicy.operations[k], routingPolicy.operations[dispatch.kind])])),
    } };
  }
  if (taskType && ['takeover', 'ruling-not-addressed'].includes(taskType)) routingPolicy = { ...routingPolicy, operations: { ...routingPolicy.operations, fix: routingPolicy.operations[`fix:${taskType}`] } };
  const result = decideDispatchRoute(dispatch, { ...options, availability, ciHealNativeFallback, routingPolicy, providerCapacity: builder?.settings.capacity ?? resolveRoutingSettings({ env: options.env ?? process.env }).capacity });
  // Account attribution is informational in the capacity decision log, never a launcher instruction.
  return result;
}
export function routingPolicyEnv() {
  return { WE_DISPATCH_ROUTING_SNAPSHOT: JSON.stringify(readRoutingPolicy()) };
}

export function resolveOperationEffort(operation, provider, taskType, policy = readRoutingPolicy()) {
  return operationEffort(operation, provider, taskType, policy);
}
