/** Pure validation and resolution for the declarative routing policy. */
import { CODEX_EFFORT_MAP } from './codex-model-routing.mjs';
import { initialRoutingPolicy as defaults } from './dispatch-routing-policy-source.mjs';

const CATALOG = Object.freeze({
  claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'],
  // Historical ids remain valid for persisted runs; aliases select the current family.
  antigravity: ['claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gemini-3.8-flash-high', 'gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-4-argon-high'],
  // Card 84 — agy 1.3.0 serves the 5.5 family with the effort baked into the id (`agy models`, 2026-10-06).
  'agy-claude': ['claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
    'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low'],
  'agy-gemini': ['gemini-3.8-flash-high', 'gemini-3.8-flash', 'gemini-3.1-pro'],
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new TypeError(`routing policy: ${message}`); };
// These settings-backed seats use review-seat-provider's Claude/agy adapters.
// Added review seats (including red-team) have a separate, wider provider roster.
const SETTINGS_SEAT_TASKS = ['mandatory:correctness', 'mandatory:security', 'advisory:agy-correctness'];
const SETTINGS_SEAT_PROVIDERS = ['claude', 'agy-claude', 'agy-gemini'];
const OPTIONAL_ADVISORY_SEAT = 'review-seat:advisory:agy-correctness';
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
      validateProviderControls(entry, path);
      if (entry?.inherit === true) { keys(entry, ['inherit', 'effort', 'enabledProviders', 'disabledProviders'], path); validateEffort(entry.effort); continue; }
      keys(entry, ['provider', 'model', 'effort', 'fallback', 'mode', 'enabledProviders', 'disabledProviders'], path);
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
      if (group === 'operations' && SETTINGS_SEAT_TASKS.some(task => name === `review-seat:${task}`)) {
        for (const route of [entry, ...entry.fallback]) {
          if (!SETTINGS_SEAT_PROVIDERS.includes(route.provider)) fail(`${path}: unsupported seat provider ${route.provider}`);
        }
      }
    }
  }
  if (!policy.operations['*']) fail('operations.* is required');
  // Validate the same projection used during review-pr initialization, including
  // inherited/generic entries and disables that exhaust a mandatory seat's chain.
  for (const taskType of SETTINGS_SEAT_TASKS) {
    const route = resolveOperationRoute({ operation: 'review-seat', taskType, available: SETTINGS_SEAT_PROVIDERS, policy });
    if (route?.mode === 'shadow' && !route.fallback.some(next => next.provider === 'claude')) {
      fail(`review-seat:${taskType}: shadow requires an enabled claude provider to count`);
    }
  }
  return freeze(policy);
}
/** Provider controls are operation-local and validated even on inherited routes. */
function validateProviderControls(entry, path) {
  for (const key of ['enabledProviders', 'disabledProviders']) {
    if (entry?.[key] !== undefined && (!Array.isArray(entry[key]) || entry[key].some(p => !Object.hasOwn(CATALOG, p)) || new Set(entry[key]).size !== entry[key].length)) fail(`${path}.${key} must contain distinct known providers`);
  }
  if (entry?.enabledProviders?.some(p => entry.disabledProviders?.includes(p))) fail(`${path}: provider cannot be both enabled and disabled`);
}

export function defaultPolicyModel(provider) {
  const model = { claude: 'sonnet', codex: 'default', antigravity: 'sonnet', 'agy-claude': 'sonnet', 'agy-gemini': 'flash' }[provider];
  if (!model) fail(`unknown provider ${JSON.stringify(provider)}`);
  return model;
}

/** Arrays replace; nested effort maps merge. Overrides never mutate the repo snapshot. */
export function applyRoutingOverrides(base, overrides = {}) {
  if (!object(overrides)) fail('routingOverrides must be an object');
  const policy = structuredClone(base);
  for (const [name, patch] of Object.entries(overrides)) {
    if (!Object.hasOwn(policy.operations, name)) fail(`routingOverrides: unknown operation ${name}`);
    keys(patch, ['provider', 'model', 'effort', 'fallback', 'mode', 'enabledProviders', 'disabledProviders'], `routingOverrides.${name}`);
    const entry = { ...policy.operations[name], ...patch };
    if (object(patch.effort)) entry.effort = { ...(object(policy.operations[name].effort) ? policy.operations[name].effort : {}), ...patch.effort };
    if (patch.provider !== undefined) {
      delete entry.inherit;
      entry.model = patch.model ?? (patch.provider === policy.operations[name].provider ? policy.operations[name].model : defaultPolicyModel(patch.provider));
      entry.fallback ??= [];
      // Selecting a provider explicitly is also a live enable, including a default-zero Gemini cap.
      entry.enabledProviders = [...new Set([...(entry.enabledProviders ?? []), patch.provider])];
    }
    policy.operations[name] = entry;
  }
  return validateRoutingPolicy(policy);
}

/** Null retains the evidence/tier decision, or omits the optional agy advisory seat.
 * Constrained inheritance requires an explicit route, except added seats with filtered candidates.
 * Availability is supplied by the launch boundary. */
export function resolveOperationRoute({ operation, taskType, size, designQuestion, wellScoped, available, availability = {}, gateClosed = false, vetoes = [], policy = DEFAULT_ROUTING_POLICY } = {}) {
  let entry = policy.operations[`${operation}:${taskType}`] ?? policy.operations[operation] ?? policy.operations[String(operation).split(':')[0]];
  const disabledProviders = new Set(entry?.disabledProviders ?? []);
  const optionalAdvisory = (taskType ? `${operation}:${taskType}` : operation) === OPTIONAL_ADVISORY_SEAT;
  const inheritRoute = () => {
    // Added-seat callers pass this same candidate list to selectReviewSeatProvider after null.
    // Other callers may select outside `available`, so retain their explicit-route requirement.
    const filteredAddedSeat = operation === 'review-seat' && taskType && !SETTINGS_SEAT_TASKS.includes(taskType)
      && !gateClosed && Array.isArray(available) && available.every(provider => !disabledProviders.has(provider));
    if (disabledProviders.size && !optionalAdvisory && !filteredAddedSeat) fail(`${operation}: inherited route cannot enforce disabled providers; configure an explicit provider and fallback`);
    return null;
  };
  if (['prepare', 'prepare-item'].includes(operation) && policy.smallPrepare && Number.isFinite(size) && size > 0 && size <= policy.smallPrepare.maxSize && designQuestion === false && wellScoped === true) entry = policy.smallPrepare.route;
  else if (['prepare', 'prepare-item'].includes(operation) && (size >= 5 || designQuestion === true)) entry = policy.operations['prepare-decision'];
  for (const provider of entry?.disabledProviders ?? []) disabledProviders.add(provider);
  if (!entry || entry.inherit) entry = policy.taskTypes[taskType] ?? entry ?? policy.operations['*'];
  for (const provider of entry.disabledProviders ?? []) disabledProviders.add(provider);
  if (entry.inherit) {
    if (!gateClosed) return inheritRoute();
    // An inherited task route must still honour the operation's configured Claude fallback
    // when the critical-work gate closes. The chain below removes every external provider.
    entry = policy.operations[operation] ?? policy.operations[String(operation).split(':')[0]];
    if (!entry || entry.inherit) return inheritRoute();
  }
  const chain = [entry, ...entry.fallback].map(({ provider, model, effort }) => ({ provider, model: modelFor(policy, provider, model, operation), effort: resolvePolicyEffort(provider, typeof effort === 'string' ? effort : effort?.[provider] ?? operationEffort(operation, provider, taskType, policy)) }))
    .filter(route => !disabledProviders.has(route.provider) && !entry.disabledProviders?.includes(route.provider))
    .filter(route => (!gateClosed || route.provider === 'claude') && (route.provider === 'claude' || !vetoes.some(veto => veto.model === route.model && veto.provider === (route.provider.startsWith('agy-') ? 'antigravity' : route.provider))))
    .filter(route => !availability?.[route.provider]
      && !(route.provider.startsWith('agy-') && availability?.antigravity)
      && !(route.model.startsWith('gemini-') && availability?.codex));
  const selected = chain.find(route => (!gateClosed || route.provider === 'claude') && (!available || available.includes(route.provider)));
  // This optional seat may be switched off without preventing mandatory review.
  if (!selected && optionalAdvisory && disabledProviders.size) return null;
  if (!selected) fail(`${operation}: no available route${gateClosed ? ' permitted by critical-work gate' : ''}`);
  return { ...selected, fallback: chain.slice(chain.indexOf(selected) + 1), source: 'routing-policy', ...(vetoes.length ? { vetoes: structuredClone(vetoes) } : {}), ...(entry.mode && selected === chain[0] ? { mode: entry.mode } : {}) };
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
