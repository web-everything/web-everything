/** Optional resolver inputs. Launch composition and final policy checks belong to each resolver. */
import { cascadePolicy, resolveCascade, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { resolvePolicyModel, resolvePolicyEffort } from './dispatch-routing-policy.mjs';
import { CODEX_MODEL_CATALOGUE, CODEX_EFFORT_MAP, codexModelSupportsEffort } from './codex-model-routing.mjs';
import { FIX_EXECUTOR_RUNGS } from './fix-executor-chain.mjs';
import { loadAccountMap } from './claude-account.mjs';
import { createRoutingOverrideLogger } from '../operations/routing-override.mjs';

const sessionObservers = new WeakMap();
const defaultSessionLog = event => console.error(JSON.stringify(event));

export const AI_ROUTING_ROLES = Object.freeze(['review', 'red-team', 'red-team-recheck', 'fix', 'build', 'prepare', 'ci-heal', 'worker', 'judge', 'helper']);
const WRITERS = new Set(['fix', 'build', 'prepare', 'ci-heal', 'worker']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inheritRole = () => ({ coordinator: { provider: 'inherit', model: 'inherit', effort: 'inherit', account: 'inherit' }, executors: 'inherit' });
const freeze = value => {
  if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const AI_ROUTING_STANDARD = freeze({
  executorProfiles: Object.fromEntries(Object.entries(FIX_EXECUTOR_RUNGS).map(([id, rung]) => [id,
    { provider: rung.executor, ...rung.policyRoute, model: rung.policyRoute?.model ?? 'inherit', effort: rung.policyRoute?.effort ?? 'inherit', account: 'inherit' }])),
  ...Object.fromEntries(AI_ROUTING_ROLES.map(role => [role, inheritRole()])),
});
const providers = ['claude', 'codex', 'agy-claude', 'agy-gemini', 'antigravity'];
const modelValid = value => typeof value === 'string' && (Object.hasOwn(CODEX_MODEL_CATALOGUE, value)
  || providers.some(provider => { try { resolvePolicyModel(provider, value); return true; } catch { return false; } }));

/** Unknown paths and invalid leaves retain their lower-layer values. */
export function aiRoutingValidators({ accountMap = loadAccountMap() } = {}) {
  const fields = {
    provider: value => value === 'inherit' || providers.includes(value),
    model: value => value === 'inherit' || modelValid(value),
    effort: value => value === 'inherit' || (typeof value === 'string' && Object.hasOwn(CODEX_EFFORT_MAP, value)),
    account: value => value === 'inherit' || (typeof value === 'string' && Object.hasOwn(accountMap?.accounts ?? {}, value)),
  };
  const route = value => object(value) && Object.entries(value).every(([key, entry]) => Object.hasOwn(fields, key) && fields[key](entry));
  const chain = value => value === 'inherit' || (Array.isArray(value) && value.length > 0
    && value.every(entry => typeof entry === 'string' ? Object.hasOwn(FIX_EXECUTOR_RUNGS, entry) : route(entry)));
  const valid = { '': () => false };
  for (const role of AI_ROUTING_ROLES) {
    const coordinatorFields = role === 'fix' ? { account: fields.account } : fields;
    const coordinator = value => object(value) && Object.entries(value).every(([key, entry]) => Object.hasOwn(coordinatorFields, key) && coordinatorFields[key](entry));
    valid[role] = value => object(value) && Object.entries(value).every(([key, entry]) => key === 'coordinator' ? coordinator(entry) : key === 'executors' && chain(entry));
    valid[`${role}.coordinator`] = coordinator;
    valid[`${role}.executors`] = chain;
    for (const [key, check] of Object.entries(coordinatorFields)) valid[`${role}.coordinator.${key}`] = check;
  }
  for (const id of Object.keys(FIX_EXECUTOR_RUNGS)) {
    valid[`executorProfiles.${id}`] = route;
    for (const [key, check] of Object.entries(fields)) valid[`executorProfiles.${id}.${key}`] = check;
  }
  return new Proxy(valid, { get: (target, key) => Object.hasOwn(target, key) ? target[key] : () => false });
}

function checkCombination(route) {
  const provider = route.provider;
  if (!provider || provider === 'inherit') return;
  if (route.model && route.model !== 'inherit') {
    const model = resolvePolicyModel(provider, route.model);
    if (provider === 'codex' && route.effort && route.effort !== 'inherit'
      && !codexModelSupportsEffort(model, route.effort)) throw new TypeError('unsupported Codex model/effort');
  }
  if (route.effort && route.effort !== 'inherit') resolvePolicyEffort(provider, route.effort);
  if (route.account && route.account !== 'inherit' && provider !== 'claude') throw new TypeError('account requires native Claude');
}
function checkCoordinator(route) {
  const explicit = value => value !== undefined && value !== 'inherit';
  if (explicit(route.provider) !== explicit(route.model)) throw new TypeError('coordinator provider and model must be supplied together');
  checkCombination(route);
}
const loggedInvalid = new Set();
function diagnostic(detail, log) {
  if (log === false || loggedInvalid.has(detail)) return;
  loggedInvalid.add(detail);
  try { (log ?? console.error)(`ai-routing-invalid · ${detail}`); } catch { /* diagnostic only */ }
}

function checkExecutors(role, value) {
  const executors = value[role].executors;
  if (executors === 'inherit') return;
  const chain = executors.map(entry => typeof entry === 'string' ? value.executorProfiles[entry] : entry);
  chain.forEach(checkCombination);
  if (role === 'fix' && (executors.some(entry => typeof entry !== 'string')
    || new Set(executors).size !== executors.length || executors.at(-1) !== 'claude')) {
    throw new TypeError('fix executors must be distinct known rungs ending with Claude');
  }
  if (WRITERS.has(role) && chain.at(-1)?.provider !== 'claude') throw new TypeError('writer chain must end with Claude');
}

export function resolveAiRouting({ env = process.env, tool = readSettings().aiRouting, platform, log, accountMap,
  session = false, routing, routingPlatform, available = ['codex', 'claude'], resume = {}, operatorOverride } = {}) {
  const valid = aiRoutingValidators({ accountMap });
  const quiet = () => {};
  const { WE_AI_ROUTING: rawAiRouting, ...cascadeEnv } = env ?? {};
  // Read the platform once, then validate combinations at each layer boundary.
  const base = cascadePolicy('aiRouting', undefined, { standard: AI_ROUTING_STANDARD, valid, platform,
    env: cascadeEnv, envValues: {}, operatorOverride, log: quiet });
  let envBlock;
  if (rawAiRouting !== undefined) {
    try { envBlock = JSON.parse(rawAiRouting); if (!object(envBlock)) throw new TypeError(); }
    catch { envBlock = rawAiRouting; }
  }
  let resolved = resolveCascade({ standard: AI_ROUTING_STANDARD, valid });
  for (const [layer, block] of [['platform', base.platform], ['tool', tool], ['env', envBlock]]) {
    const lower = resolved;
    // Use leaf merging even for env; top-level env replacement loses valid siblings.
    const next = resolveCascade({ standard: lower.value, tool: block, valid });
    next.sources = Object.fromEntries(Object.entries(next.sources).map(([path, source]) =>
      [path, source === 'tool' ? layer : lower.sources[path]]));
    next.invalid = [...lower.invalid, ...next.invalid.map(detail => detail.replace(/^tool/, layer))];
    const retain = path => {
      const parts = path.split('.');
      const parent = parts.slice(0, -1).reduce((value, key) => value[key], next.value);
      parent[parts.at(-1)] = structuredClone(parts.reduce((value, key) => value[key], lower.value));
      for (const key of Object.keys(next.sources)) if (key === path || key.startsWith(`${path}.`)) delete next.sources[key];
      for (const [key, source] of Object.entries(lower.sources)) if (key === path || key.startsWith(`${path}.`)) next.sources[key] = source;
    };
    // Profiles are shared dependencies. Reject a profile set that breaks an existing
    // chain before considering role changes, preserving those lower-layer restrictions.
    try {
      Object.values(next.value.executorProfiles).forEach(checkCombination);
      const profileProjection = { ...lower.value, executorProfiles: next.value.executorProfiles };
      for (const role of AI_ROUTING_ROLES) checkExecutors(role, profileProjection);
    } catch (error) {
      next.invalid.push(`${layer}.executorProfiles: ${error.message}; retaining lower layer`);
      retain('executorProfiles');
    }
    for (const role of AI_ROUTING_ROLES) {
      for (const [part, check] of [['coordinator', () => checkCoordinator(next.value[role].coordinator)],
        ['executors', () => checkExecutors(role, next.value)]]) {
        try { check(); }
        catch (error) {
          next.invalid.push(`${layer}.${role}.${part}: ${error.message}; retaining lower layer`);
          retain(`${role}.${part}`);
        }
      }
    }
    resolved = next;
  }
  if (session) resolveSessions(resolved, { env, routing, routingPlatform, available, resume, operatorOverride, log, valid });
  for (const detail of resolved.invalid) diagnostic(detail, log);
  // Values and provenance describe the same retained snapshot.
  resolved.leafValues = {};
  for (const path of Object.keys(resolved.sources)) resolved.leafValues[path] = path.split('.').reduce((value, key) => value?.[key], resolved.value);
  logCascadeSources('aiRouting', resolved, { env, log: log === false ? quiet : log });
  return resolved;
}

/** Return explicit routing inputs. Account selection stays in settings until its PR1b consumer exists. */
export function aiRoutingInputs(role, resolved) {
  if (!AI_ROUTING_ROLES.includes(role)) throw new TypeError(`ai-routing: unknown role ${role}`);
  if (resolved.session && !resolved.sessionRoles.includes(role)) throw new TypeError(`ai-routing: missing route for ${role}; restore routing.providerOrder or supply an explicit valid route`);
  const setting = resolved.value[role];
  const coordinator = Object.fromEntries(Object.entries(setting.coordinator).filter(([key, value]) => key !== 'account' && value !== 'inherit'));
  return {
    coordinator: Object.keys(coordinator).length ? structuredClone(coordinator) : undefined,
    executors: setting.executors === 'inherit' ? undefined : structuredClone(setting.executors),
  };
}

/** New sessions opt in at the launch boundary; existing override-only callers retain their
 * evidence/tier routers. Legacy explicit role pins win over the shared order; persisted
 * resume identities win over both and are never re-aliased. No orchestrator model is read.
 */
function resolveSessions(resolved, { env, routing, routingPlatform, available, resume, operatorOverride, log, valid }) {
  const standard = { providerOrder: ['codex', 'claude'] };
  const policy = cascadePolicy('routing', routing ?? readSettings().routing, {
    standard, platform: routingPlatform, env, operatorOverride,
    envValues: { providerOrder: env.WE_ROUTING_PROVIDER_ORDER === undefined ? undefined
      : (() => { try { return JSON.parse(env.WE_ROUTING_PROVIDER_ORDER); } catch { return null; } })() },
    valid: { providerOrder: value => Array.isArray(value) && value.length > 0 && value.length <= 2
      && new Set(value).size === value.length && value.every(p => ['codex', 'claude'].includes(p)),
      '': () => false }, log: () => {},
  });
  resolved.session = true;
  resolved.sessionRoles = [];
  const orderInvalid = policy.invalid.length > 0;
  if (orderInvalid) resolved.invalid.push(`routing.providerOrder invalid (${policy.invalid.join('; ')}); restore a distinct codex/claude providerOrder (at most two providers) or ask the operator to repair policy`);
  resolved.sources['routing.providerOrder'] = policy.sources.providerOrder;
  // Conservative routine tiers: helper alone can use a small model. Preparation keeps
  // Astra and review/judge roles retain full-capability models and high effort.
  const security = new Set(['review', 'red-team', 'red-team-recheck', 'judge']);
  for (const role of AI_ROUTING_ROLES) {
    const old = resolved.value[role].coordinator;
    const persisted = resume[role];
    try {
      if (Object.hasOwn(resume, role) && (!object(persisted)
        || typeof persisted.provider !== 'string' || persisted.provider === 'inherit'
        || typeof persisted.model !== 'string' || persisted.model === 'inherit')) {
        throw new TypeError('resume requires explicit provider and model');
      }
      if (persisted && (!valid[`${role}.coordinator`](persisted)
        || typeof persisted.effort !== 'string' || persisted.effort === 'inherit')) {
        throw new TypeError(role === 'fix' ? 'resume violates fix coordinator account-only validator'
          : 'resume has invalid coordinator fields or lacks explicit effort');
      }
      // Fix models belong to executor rungs, never to the account-only coordinator.
      // Refuse before borrowing a routine model from providerOrder, even when that
      // provider is unavailable; callers must use the fix executor-chain resolver.
      if (role === 'fix') throw new TypeError('fix coordinator is account-only; use the fix executor chain for model selection');
      if (orderInvalid && !persisted) throw new TypeError('invalid providerOrder');
      const pinned = old.provider !== 'inherit';
      const provider = persisted?.provider ?? (pinned ? old.provider : policy.value.providerOrder.find(p => available.includes(p)));
      if (!provider) throw new TypeError('no available provider');
      const model = persisted?.model ?? (pinned ? old.model : provider === 'codex'
        ? (role === 'helper' ? 'luna' : role === 'prepare' ? 'astra' : 'sol')
        : (role === 'helper' ? 'haiku' : 'sonnet'));
      if (!model || model === 'inherit') throw new TypeError('explicit model required');
      const canonical = resolvePolicyModel(provider, model);
      if (security.has(role) && /luna|haiku|flash/.test(canonical)) throw new TypeError('security floor excludes small models');
      if (!persisted && !available.includes(provider)) throw new TypeError('pinned provider unavailable');
      const coordinator = persisted ? structuredClone(persisted) : { provider, model: canonical,
        effort: old.effort !== 'inherit' ? old.effort : security.has(role) ? 'high' : role === 'helper' ? 'low' : 'medium',
        account: old.account };
      if (!valid[`${role}.coordinator`](coordinator)) {
        throw new TypeError('invalid coordinator fields');
      }
      checkCoordinator(coordinator);
      resolved.value[role].coordinator = coordinator;
      for (const key of Object.keys(coordinator)) resolved.sources[`${role}.coordinator.${key}`] = persisted ? 'resume'
        : pinned ? resolved.sources[`${role}.coordinator.${key}`] ?? 'standard' : policy.sources.providerOrder;
      resolved.sessionRoles.push(role);
      if (log !== false) {
        const sink = log ?? defaultSessionLog;
        if (!sessionObservers.has(sink)) sessionObservers.set(sink, createRoutingOverrideLogger({ log: sink }));
        sessionObservers.get(sink)({ key: role, provider: coordinator.provider, model: coordinator.model,
          effort: coordinator.effort, source: resolved.sources[`${role}.coordinator.model`] });
      }
    } catch (error) {
      resolved.invalid.push(`${role}: missing route (${error.message}); restore routing.providerOrder or supply an explicit valid route`);
    }
  }
}
