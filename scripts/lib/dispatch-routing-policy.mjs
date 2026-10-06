/** Pure validation and resolution for the declarative routing policy. */
import { CODEX_EFFORT_MAP } from './codex-model-routing.mjs';
import { initialRoutingPolicy as defaults } from './dispatch-routing-policy-source.mjs';

const CATALOG = Object.freeze({
  claude: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-opus-5'],
  codex: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'],
  antigravity: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gemini-3.8-flash-high', 'gemini-3.8-flash', 'gemini-3.1-pro'],
  // Card 84 — agy 1.3.0 serves the 5.5 family with the effort baked into the id (`agy models`, 2026-10-06).
  'agy-claude': ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
    'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low'],
  'agy-gemini': ['gemini-3.8-flash-high', 'gemini-3.8-flash', 'gemini-3.1-pro'],
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new TypeError(`routing policy: ${message}`); };
function keys(value, allowed, path) {
  if (!object(value)) fail(`${path} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key} is unknown`);
}
function modelFor(policy, provider, model, path) {
  if (!Object.hasOwn(CATALOG, provider)) fail(`${path}: unknown provider ${JSON.stringify(provider)}`);
  const resolved = policy.aliases?.[provider]?.[model] ?? model;
  if (!CATALOG[provider].includes(resolved)) fail(`${path}: unknown model/alias ${JSON.stringify(model)} for ${provider}`);
  return resolved;
}
const EFFORTS = { codex: Object.keys(CODEX_EFFORT_MAP), claude: ['low', 'medium', 'high', 'xhigh', 'max'], antigravity: ['low', 'medium', 'high'], 'agy-claude': ['low', 'medium', 'high'], 'agy-gemini': ['low', 'medium', 'high'] };
export function resolvePolicyEffort(provider, effort = 'medium') {
  if (!EFFORTS[provider]?.includes(effort)) fail(`unknown effort ${JSON.stringify(effort)} for ${provider}; expected ${(EFFORTS[provider] ?? []).join('|')}`);
  return effort;
}
function validateEffort(value, provider) {
  if (value === undefined) return;
  if (object(value)) {
    for (const [p, effort] of Object.entries(value)) resolvePolicyEffort(p, effort);
  } else resolvePolicyEffort(provider, value);
}
export function operationEffort(operation, provider, taskType, policy = DEFAULT_ROUTING_POLICY) {
  const entry = policy.operations[`${operation}:${taskType}`] ?? policy.taskTypes[taskType] ?? policy.operations[operation] ?? policy.operations[String(operation).split(':')[0]] ?? policy.operations['*'];
  return resolvePolicyEffort(provider, typeof entry?.effort === 'string' ? entry.effort : entry?.effort?.[provider] ?? 'medium');
}
function freeze(value) {
  if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function validateRoutingPolicy(input) {
  const policy = structuredClone(input);
  keys(policy, ['_howTo', 'version', 'aliases', 'criticalWorkGate', 'operations', 'taskTypes', 'smallPrepare'], 'policy');
  if (policy.version !== 1) fail('version must be 1');
  if (!object(policy.aliases)) fail('aliases must be an object');
  for (const [provider, aliases] of Object.entries(policy.aliases)) {
    if (!Object.hasOwn(CATALOG, provider)) fail(`aliases: unknown provider ${provider}`);
    if (!object(aliases)) fail(`aliases.${provider} must be an object`);
    for (const [alias, model] of Object.entries(aliases)) {
      if (!/^[\w.-]+$/.test(alias) || !CATALOG[provider].includes(model)) fail(`aliases.${provider}.${alias}: unknown model ${JSON.stringify(model)}`);
    }
  }
  const gate = policy.criticalWorkGate;
  keys(gate, ['kinds', 'openForNonCritical', 'basis', 'reason'], 'criticalWorkGate');
  if (!Array.isArray(gate.kinds) || gate.kinds.some(k => typeof k !== 'string' || !k.trim()) || new Set(gate.kinds).size !== gate.kinds.length) fail('criticalWorkGate.kinds must contain distinct operation names');
  if (!object(gate.openForNonCritical) || Object.values(gate.openForNonCritical).some(v => typeof v !== 'boolean')) fail('criticalWorkGate.openForNonCritical must contain booleans');
  if (policy.smallPrepare) {
    keys(policy.smallPrepare, ['maxSize', 'route'], 'smallPrepare');
    if (!Number.isInteger(policy.smallPrepare.maxSize) || policy.smallPrepare.maxSize < 1) fail('smallPrepare.maxSize must be a positive integer');
  }
  const groups = { operations: policy.operations, taskTypes: policy.taskTypes, ...(policy.smallPrepare ? { smallPrepare: { route: policy.smallPrepare.route } } : {}) };
  for (const [group, entries] of Object.entries(groups)) {
    if (!object(entries)) fail(`${group} must be an object`);
    for (const [name, entry] of Object.entries(entries)) {
      const path = `${group}.${name}`;
      if (!name.trim()) fail(`${group} has an empty key`);
      if (entry?.inherit === true) { keys(entry, ['inherit', 'effort'], path); validateEffort(entry.effort); continue; }
      keys(entry, ['provider', 'model', 'effort', 'fallback', 'mode'], path);
      // Card 84 — `mode: "shadow"`: the primary provider runs as a recorded shadow beside the first Claude route in
      // `fallback`, which alone counts. Only review seats read it (we:scripts/lib/review-seat-provider.mjs).
      if (entry.mode !== undefined && (entry.mode !== 'shadow' || !entry.fallback?.some?.((f) => f?.provider === 'claude'))) {
        fail(`${path}.mode must be "shadow", with a claude route in fallback to count`);
      }
      modelFor(policy, entry.provider, entry.model, path);
      validateEffort(entry.effort, entry.provider);
      if (!Array.isArray(entry.fallback)) fail(`${path}.fallback must be an array`);
      for (const [i, next] of entry.fallback.entries()) {
        keys(next, ['provider', 'model', 'effort'], `${path}.fallback[${i}]`);
        modelFor(policy, next.provider, next.model, `${path}.fallback[${i}]`);
        validateEffort(next.effort, next.provider);
      }
    }
  }
  if (!policy.operations['*']) fail('operations.* is required');
  return freeze(policy);
}
/** Null means retain the existing evidence/tier decision. Availability is supplied by the launch boundary. */
export function resolveOperationRoute({ operation, taskType, size, designQuestion, wellScoped, available, gateClosed = false, vetoes = [], policy = DEFAULT_ROUTING_POLICY } = {}) {
  let entry = policy.operations[`${operation}:${taskType}`] ?? policy.operations[operation] ?? policy.operations[String(operation).split(':')[0]];
  if (['prepare', 'prepare-item'].includes(operation) && policy.smallPrepare && Number.isFinite(size) && size > 0 && size <= policy.smallPrepare.maxSize && designQuestion === false && wellScoped === true) entry = policy.smallPrepare.route;
  else if (['prepare', 'prepare-item'].includes(operation) && (size >= 5 || designQuestion === true)) entry = policy.operations['prepare-decision'];
  if (!entry || entry.inherit) entry = policy.taskTypes[taskType] ?? entry ?? policy.operations['*'];
  if (entry.inherit) return null;
  const chain = [entry, ...entry.fallback].map(({ provider, model, effort }) => ({ provider, model: modelFor(policy, provider, model, operation), effort: resolvePolicyEffort(provider, typeof effort === 'string' ? effort : effort?.[provider] ?? operationEffort(operation, provider, taskType, policy)) }))
    .filter(route => (!gateClosed || route.provider === 'claude') && (route.provider === 'claude' || !vetoes.some(veto => veto.model === route.model && veto.provider === (route.provider.startsWith('agy-') ? 'antigravity' : route.provider))));
  const selected = chain.find(route => (!gateClosed || route.provider === 'claude') && (!available || available.includes(route.provider)));
  if (!selected) fail(`${operation}: no available route${gateClosed ? ' permitted by critical-work gate' : ''}`);
  return { ...selected, fallback: chain.slice(chain.indexOf(selected) + 1), source: 'routing-policy', ...(entry.mode && selected === chain[0] ? { mode: entry.mode } : {}) };
}

/**
 * The `--model` a `claude` CLI spawn gets: the tier ALIAS (haiku|sonnet|opus), never a pinned id, so a worker always runs the
 * current model of its tier (see `dispatch-lane-io.mjs#CLAUDE_SPAWN_MODEL_BY_TIER`, #3906). Policy/record ids stay pinned for
 * trust keys; only the spawn boundary maps them. A non-catalogue value passes through untouched.
 */
export function claudeSpawnAlias(model) {
  if (!CATALOG.claude.includes(model)) return model;
  return ['haiku', 'sonnet', 'opus'].find(tier => model.includes(tier)) ?? model;
}

/** Validate explicit CLI pins through the same provider-specific catalogue as policy aliases. */
export function resolvePolicyModel(provider, model, policy = DEFAULT_ROUTING_POLICY) {
  return modelFor(policy, provider, model, 'explicit model');
}

export const DEFAULT_ROUTING_POLICY = validateRoutingPolicy(defaults);
