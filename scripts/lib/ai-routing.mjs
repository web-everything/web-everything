/** Optional resolver inputs. Launch composition and final policy checks belong to each resolver. */
import { cascadePolicy, resolveCascade, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { resolvePolicyModel, resolvePolicyEffort } from './dispatch-routing-policy.mjs';
import { CODEX_MODEL_CATALOGUE, CODEX_EFFORT_MAP, codexModelSupportsEffort } from './codex-model-routing.mjs';
import { FIX_EXECUTOR_RUNGS } from './fix-executor-chain.mjs';
import { loadAccountMap } from './claude-account.mjs';

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
    resolvePolicyModel(provider, route.model);
    if (provider === 'codex' && route.effort && route.effort !== 'inherit'
      && !codexModelSupportsEffort(route.model, route.effort)) throw new TypeError('unsupported Codex model/effort');
  }
  if (route.effort && route.effort !== 'inherit') resolvePolicyEffort(provider, route.effort);
  if (route.account && route.account !== 'inherit' && provider !== 'claude') throw new TypeError('account requires native Claude');
}
const loggedInvalid = new Set();
function diagnostic(detail, log) {
  if (log === false || loggedInvalid.has(detail)) return;
  loggedInvalid.add(detail);
  try { (log ?? console.error)(`ai-routing-invalid · ${detail}`); } catch { /* diagnostic only */ }
}

export function resolveAiRouting({ env = process.env, tool = readSettings().aiRouting, platform, log, accountMap } = {}) {
  const valid = aiRoutingValidators({ accountMap });
  const quiet = () => {};
  const { WE_AI_ROUTING: rawAiRouting, ...cascadeEnv } = env ?? {};
  // Apply WE_AI_ROUTING only in the leaf-preserving pass below.
  const resolved = cascadePolicy('aiRouting', tool, { standard: AI_ROUTING_STANDARD, valid, platform,
    env: cascadeEnv, envValues: {}, log: quiet });
  if (rawAiRouting !== undefined) {
    let envBlock;
    try { envBlock = JSON.parse(rawAiRouting); if (!object(envBlock)) throw new TypeError(); }
    catch { envBlock = rawAiRouting; }
    // Project the environment through the same leaf validator as the tool layer. The shared
    // cascade's envValues replaces whole top-level blocks, which would discard valid siblings.
    const upper = resolveCascade({ standard: resolved.value, tool: envBlock, valid });
    for (const [path, source] of Object.entries(upper.sources)) if (source === 'tool') resolved.sources[path] = 'env';
    resolved.value = upper.value;
    resolved.invalid.push(...upper.invalid.map(detail => detail.replace(/^tool/, 'env')));
  }
  for (const detail of resolved.invalid) diagnostic(detail, log);
  for (const role of AI_ROUTING_ROLES) {
    const setting = resolved.value[role];
    try {
      checkCombination(setting.coordinator);
      if (setting.executors !== 'inherit') {
        const chain = setting.executors.map(entry => typeof entry === 'string' ? resolved.value.executorProfiles[entry] : entry);
        chain.forEach(checkCombination);
        if (role === 'fix' && (setting.executors.some(entry => typeof entry !== 'string')
          || new Set(setting.executors).size !== setting.executors.length || setting.executors.at(-1) !== 'claude')) {
          throw new TypeError('fix executors must be distinct known rungs ending with Claude');
        }
        if (WRITERS.has(role) && chain.at(-1)?.provider !== 'claude') throw new TypeError('writer chain must end with Claude');
      }
    } catch (error) {
      diagnostic(`${role}: ${error.message}; using inherit`, log);
      resolved.invalid.push(`${role}: ${error.message}`);
      resolved.value[role] = inheritRole();
      for (const path of Object.keys(resolved.sources)) if (path === role || path.startsWith(`${role}.`)) delete resolved.sources[path];
      for (const key of Object.keys(inheritRole().coordinator)) resolved.sources[`${role}.coordinator.${key}`] = 'standard';
      resolved.sources[`${role}.executors`] = 'standard';
    }
  }
  // Keep the cascade's diagnostic values aligned with any role that failed combination validation.
  resolved.leafValues = {};
  for (const path of Object.keys(resolved.sources)) resolved.leafValues[path] = path.split('.').reduce((value, key) => value?.[key], resolved.value);
  logCascadeSources('aiRouting', resolved, { env, log: log === false ? quiet : log });
  return resolved;
}

/** Return only explicit inputs; an all-inherit role supplies undefined to each resolver. */
export function aiRoutingInputs(role, resolved) {
  if (!AI_ROUTING_ROLES.includes(role)) throw new TypeError(`ai-routing: unknown role ${role}`);
  const setting = resolved.value[role];
  const coordinator = Object.fromEntries(Object.entries(setting.coordinator).filter(([, value]) => value !== 'inherit'));
  return {
    coordinator: Object.keys(coordinator).length ? structuredClone(coordinator) : undefined,
    executors: setting.executors === 'inherit' ? undefined : structuredClone(setting.executors),
  };
}
