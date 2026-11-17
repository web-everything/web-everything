/** Optional resolver inputs. Launch composition and final policy checks belong to each resolver. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cascadePolicy, resolveCascade, logCascadeSources, readPlatformPreferences } from './policy-cascade.mjs';
import { readSettings, readDeclaredSettings, mergeSettingsLayers, SETTINGS_DIR, LEGACY_SETTINGS_PATH } from './settings-files.mjs';
import { resolvePolicyModel, resolvePolicyEffort, resolveOperationRoute, operationEffort, defaultPolicyModel,
  DEFAULT_ROUTING_POLICY, validateRoutingPolicy } from './dispatch-routing-policy.mjs';
import { resolveCodexTaskRoute } from './codex-task-route.mjs';
import { workerTierFor, selectReviewSeatProvider, decideCriticalWorkGate } from './provider-routing.mjs';
import { criticalWorkVerdict } from './critical-work.mjs';
import { CODEX_MODEL_CATALOGUE, CODEX_EFFORT_MAP, codexModelSupportsEffort } from './codex-model-routing.mjs';
import { FIX_EXECUTOR_RUNGS, resolveFixExecutorChain, pickChainRung } from './fix-executor-chain.mjs';
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

export function resolveAiRouting({ env = process.env, tool = readSettings().aiRouting, platform, log, accountMap } = {}) {
  const valid = aiRoutingValidators({ accountMap });
  const quiet = () => {};
  const { WE_AI_ROUTING: rawAiRouting, ...cascadeEnv } = env ?? {};
  // Read the platform once, then validate combinations at each layer boundary.
  const base = cascadePolicy('aiRouting', undefined, { standard: AI_ROUTING_STANDARD, valid, platform,
    env: cascadeEnv, envValues: {}, log: quiet });
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
  const setting = resolved.value[role];
  const coordinator = Object.fromEntries(Object.entries(setting.coordinator).filter(([key, value]) => key !== 'account' && value !== 'inherit'));
  return {
    coordinator: Object.keys(coordinator).length ? structuredClone(coordinator) : undefined,
    executors: setting.executors === 'inherit' ? undefined : structuredClone(setting.executors),
  };
}

/** A refusal is actionable evidence: fix/remove the named setting, or escalate to the operator. */
export class AiRoutingRefusal extends Error {
  constructor(code, role, siteKey, detail) {
    super(`ai-routing refusal (${code}) ${role}@${siteKey}: ${detail}; correct the input or ask the operator`);
    this.name = 'AiRoutingRefusal';
    Object.assign(this, { code, role, siteKey, detail });
  }
}

// Codex families intentionally have no relative ordering (F4). Cross-family changes refuse.
export const AI_ROUTING_MODEL_RANKS = freeze({
  claude: { 'claude-haiku-5-5': 1, 'claude-sonnet-5-5': 2, 'claude-opus-5-5': 3 },
  codex: Object.fromEntries(Object.keys(CODEX_MODEL_CATALOGUE).map(model => [model, 1])),
  'agy-claude': { 'claude-sonnet-5-5': 2, 'claude-sonnet-5-5-low': 2,
    'claude-sonnet-5-5-medium': 2, 'claude-sonnet-5-5-high': 2,
    'claude-opus-5-5-low': 3, 'claude-opus-5-5-medium': 3, 'claude-opus-5-5-high': 3 },
});
export const AI_ROUTING_EFFORT_RANKS = freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 });
export const AI_ROUTING_FLOORS = freeze({
  review: 'raise-only', 'red-team': 'provider-only', 'red-team-recheck': 'claude-only',
  judge: 'raise-only-same-model', 'ci-heal': 'raise-only-claude-only', helper: 'raise-only-claude-only',
  fix: 'none', build: 'none', prepare: 'none', worker: 'none',
});

// PR0 sites are deliberately just the role names. Adding a real call site is a separate migration.
const launchSites = freeze({
  review: { role: 'review', operation: 'review-seat', kind: 'review', readsRepo: false },
  'red-team': { role: 'red-team', operation: 'review-seat', taskType: 'red-team', kind: 'review', readsRepo: false },
  'red-team-recheck': { role: 'red-team-recheck', operation: 'review-recheck', kind: 'review', readsRepo: true },
  judge: { role: 'judge', operation: 'judge', kind: 'review', readsRepo: false },
  helper: { role: 'helper', operation: 'precedent-draft', kind: 'worker', readsRepo: true },
  'ci-heal': { role: 'ci-heal', operation: 'ci-heal', kind: 'ci-heal', readsRepo: true },
  fix: { role: 'fix', operation: 'fix', kind: 'fix', readsRepo: true },
  build: { role: 'build', operation: 'build', kind: 'build', readsRepo: true },
  prepare: { role: 'prepare', operation: 'prepare-item', kind: 'prepare', readsRepo: true },
  worker: { role: 'worker', operation: 'worker', kind: 'worker', readsRepo: true },
});

function scanLaunchLayer(block, path, valid, refuse) {
  if (!object(block) || !Object.keys(block).length) refuse('invalid-setting', `${path}: expected a nonempty object`);
  for (const [key, value] of Object.entries(block)) {
    const leaf = path.includes('.') ? `${path.slice(path.indexOf('.') + 1)}.${key}` : key;
    if (object(value)) {
      // Only declared object nodes may be traversed; this also rejects prototype keys.
      const node = leaf === 'executorProfiles' || AI_ROUTING_ROLES.includes(leaf)
        || AI_ROUTING_ROLES.some(role => leaf === `${role}.coordinator`)
        || Object.keys(FIX_EXECUTOR_RUNGS).some(id => leaf === `executorProfiles.${id}`);
      if (!node) refuse('invalid-setting', `${path}.${key}: unknown object`);
      scanLaunchLayer(value, `${path}.${key}`, valid, refuse);
    } else if (value === null || Array.isArray(value) || !valid[leaf](value)) {
      refuse('invalid-setting', `${path}.${key}: invalid value`);
    }
  }
}

function launchBaseline(site, ctx, policy, options, refuse) {
  let route = resolveOperationRoute(options);
  if (!route && site.operation === 'review-seat' && options.taskType === 'advisory:agy-correctness') {
    refuse('omitted-seat', 'the optional advisory seat has no active route');
  }
  if (!route && site.role === 'fix') {
    if (ctx.repo === undefined) {
      const declared = readDeclaredSettings();
      if (declared.errors.length || declared.duplicates.length) {
        refuse('settings-read', 'fix routing settings are unreadable or ambiguous');
      }
    }
    const chain = resolveFixExecutorChain({ env: ctx.env, platform: ctx.chainPlatform ?? {}, repo: ctx.repo });
    const picked = pickChainRung({ ...ctx, chain: chain.value,
      critical: options.gateClosed, criticalClaudeFromRung: chain.criticalClaudeFromRung });
    route = { provider: picked.executor, ...picked.policyRoute };
  }
  if (!route && ['review', 'red-team'].includes(site.role) && !ctx.mandatoryLens) {
    const picked = selectReviewSeatProvider({ ...ctx, lens: options.taskType ?? site.role });
    if (!picked.provider) throw new TypeError('no available review seat provider');
    route = { provider: picked.provider };
  }
  route ??= { provider: 'claude' };
  if (route.provider === 'codex') {
    const codex = resolveCodexTaskRoute({ ...ctx, kind: site.kind, env: ctx.env,
      tool: ctx.codexTool ?? {}, platform: ctx.codexPlatform ?? {}, log: false,
      vetoes: options.vetoes,
      // The policy/chain has already selected these leaves. Task defaults, including env,
      // must not replace them before they become floor evidence. Caller pins still win.
      ...(route.model ? { model: ctx.model ?? route.model } : {}),
      ...(route.effort ? { effort: ctx.effort ?? route.effort } : {}) });
    route = { ...route, model: codex.model, effort: codex.effort };
  } else {
    const tier = workerTierFor({ ...ctx, kind: site.kind }).tier;
    route = { ...route, model: resolvePolicyModel(route.provider,
      ctx.model ?? route.model ?? (route.provider === 'claude' ? tier : defaultPolicyModel(route.provider)), policy),
    effort: resolvePolicyEffort(route.provider, ctx.effort ?? route.effort
      ?? operationEffort(site.operation, route.provider, options.taskType, policy)) };
  }
  return route;
}

// Retain the entries consulted by resolveOperationRoute before concretizing inheritance.
function launchPolicyEntries({ operation, taskType, policy, size, designQuestion, wellScoped }) {
  const initial = policy.operations[`${operation}:${taskType}`] ?? policy.operations[operation]
    ?? policy.operations[operation.split(':')[0]];
  let entry = initial;
  if (['prepare', 'prepare-item'].includes(operation) && policy.smallPrepare && Number.isFinite(size)
    && size > 0 && size <= policy.smallPrepare.maxSize && designQuestion === false && wellScoped === true) {
    entry = policy.smallPrepare.route;
  } else if (['prepare', 'prepare-item'].includes(operation) && (size >= 5 || designQuestion === true)) {
    entry = policy.operations['prepare-decision'];
  }
  const effective = !entry || entry.inherit ? policy.taskTypes[taskType] ?? entry ?? policy.operations['*'] : entry;
  return [initial, entry, effective].filter(Boolean);
}

// Read and validate one snapshot of every contributor before the shared settings merger sees it.
// settingsFiles uses the declared reader's dir/legacyPath seams for hermetic file fixtures.
function readLaunchToolSettings(settingsFiles = {}, valid, refuse) {
  const { dir = SETTINGS_DIR, legacyPath = LEGACY_SETTINGS_PATH } = settingsFiles;
  const layers = [];
  const load = (source, path, optional = false) => {
    let raw;
    try { raw = readFileSync(path, 'utf8'); }
    catch (error) {
      if (optional && error.code === 'ENOENT') return;
      refuse('settings-read', `${source}: ${error.message}`);
    }
    let data;
    try { data = JSON.parse(raw); }
    catch (error) { refuse('settings-read', `${source}: ${error.message}`); }
    if (!object(data)) refuse('settings-read', `${source}: expected a settings object`);
    if (Object.hasOwn(data, 'aiRouting')) {
      scanLaunchLayer(data.aiRouting, 'tool', valid, (code, detail) => refuse(code, `${source}: ${detail}`));
    }
    layers.push({ source, data });
  };
  if (legacyPath) load('dispatch-settings.json', legacyPath, !Object.hasOwn(settingsFiles, 'legacyPath'));
  let names;
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')).sort(); }
  catch (error) { refuse('settings-read', `settings directory: ${error.message}`); }
  for (const name of names) load(`settings/${name}`, join(dir, name));
  const merged = mergeSettingsLayers(layers);
  if (merged.duplicates.length) refuse('settings-read', 'declared settings are ambiguous');
  return merged.settings.aiRouting;
}

function checkLaunchFloor(base, route, rule, refuse) {
  if (rule === 'none') return;
  const beforeEffort = AI_ROUTING_EFFORT_RANKS[base.effort];
  const afterEffort = AI_ROUTING_EFFORT_RANKS[route.effort];
  if (beforeEffort === undefined || afterEffort === undefined || afterEffort < beforeEffort) {
    refuse('floor', 'effort is below the baseline or unranked');
  }
  if (rule === 'provider-only') {
    // Red-team may select another provider's native model; within one provider the pair is fixed.
    if (base.provider === route.provider && (base.model !== route.model || base.effort !== route.effort)) {
      refuse('floor', 'red-team permits provider changes only');
    }
    return;
  }
  if (rule === 'raise-only-same-model' && base.model !== route.model) refuse('floor', 'judge model is fixed');
  if (base.provider === 'codex' || route.provider === 'codex') {
    if (base.provider !== route.provider || base.model !== route.model) refuse('floor', 'Codex model ordering is unknown; keep the same model');
  } else if (base.model !== route.model || base.provider !== route.provider) {
    const before = AI_ROUTING_MODEL_RANKS[base.provider]?.[base.model];
    const after = AI_ROUTING_MODEL_RANKS[route.provider]?.[route.model];
    if (before === undefined || after === undefined || after < before) refuse('floor', 'model is below the baseline or unranked');
  }
}

/**
 * Resolve a launch without consulting ambient environment. ctx.env is the full launch environment.
 * ctx.platform / ctx.tool are raw aiRouting blocks; omit them to read the declared files.
 * Route evidence (policy, operatorKeys, availability, vetoes, pins, care, scope) is supplied in ctx.
 * budget is launch-owned and copied unchanged; settings cannot supply it. No consumer opts in in PR0.
 */
export function resolveLaunchSpec(role, siteKey, ctx) {
  const refuse = (code, detail) => { throw new AiRoutingRefusal(code, role, siteKey, detail); };
  try {
    if (!object(ctx) || !Object.hasOwn(ctx, 'env') || !object(ctx.env)) refuse('environment', 'ctx.env is required');
    const site = Object.hasOwn(launchSites, siteKey) && launchSites[siteKey];
    if (!site || site.role !== role) refuse('site', 'unknown site or role mismatch');
    const valid = aiRoutingValidators({ accountMap: ctx.accountMap ?? { accounts: {} } });
    let platform = ctx.platform;
    if (!Object.hasOwn(ctx, 'platform')) {
      if (ctx.env.WE_PLATFORM_PREFERENCES_FILE) {
        // An explicitly selected file is required evidence, including when it does not exist.
        try { readFileSync(ctx.env.WE_PLATFORM_PREFERENCES_FILE, 'utf8'); }
        catch (error) { refuse('settings-read', error.message); }
      }
      const loaded = readPlatformPreferences({ env: ctx.env, warn: () => {}, readFile: (path, encoding) => {
        const raw = readFileSync(path, encoding);
        const parsed = JSON.parse(raw);
        if (object(parsed) && Object.hasOwn(parsed, 'aiRouting')) scanLaunchLayer(parsed.aiRouting, 'platform', valid, refuse);
        return raw;
      } });
      if (loaded.errors.length) refuse('settings-read', loaded.errors.join('; '));
      platform = loaded.prefs.aiRouting;
    }
    let tool = ctx.tool;
    if (!Object.hasOwn(ctx, 'tool')) {
      tool = readLaunchToolSettings(ctx.settingsFiles, valid, refuse);
    }
    let envBlock;
    if (ctx.env.WE_AI_ROUTING !== undefined) {
      if (typeof ctx.env.WE_AI_ROUTING !== 'string') refuse('invalid-setting', 'WE_AI_ROUTING must be JSON text');
      envBlock = JSON.parse(ctx.env.WE_AI_ROUTING);
    }
    for (const [layer, block] of [['platform', platform], ['tool', tool], ['env', envBlock]]) {
      if (block === undefined) continue;
      if (AI_ROUTING_FLOORS[role] === 'none' && object(block) && block[role]) {
        const changes = value => object(value) ? Object.values(value).some(changes) : value !== 'inherit';
        if (changes(block[role])) refuse('writer', 'writer settings cannot change this launch');
      }
      scanLaunchLayer(block, layer, valid, refuse);
    }
    const resolved = resolveAiRouting({ platform: platform ?? {}, tool: tool ?? {}, env: ctx.env,
      log: ctx.log ?? false, accountMap: ctx.accountMap ?? { accounts: {} } });
    if (resolved.invalid.length) refuse('invalid-setting', resolved.invalid.join('; '));
    const inputs = aiRoutingInputs(role, resolved);
    if (inputs.executors) refuse('unsupported-overlay', 'executor changes have no PR0 launch consumer');
    if (resolved.value[role].coordinator.account !== 'inherit') refuse('unsupported-overlay', 'account changes have no PR0 launch consumer');
    const policy = validateRoutingPolicy(ctx.policy ?? DEFAULT_ROUTING_POLICY);
    const gate = decideCriticalWorkGate(policy.criticalWorkGate, site.kind, ctx.taskType ?? site.taskType,
      { criticalWork: criticalWorkVerdict(ctx), criticalMisses: ctx.criticalMisses });
    const options = { ...ctx, operation: site.operation, taskType: ctx.taskType ?? site.taskType, policy,
      gateClosed: ctx.gateClosed === true || gate?.open === false,
      vetoes: [...(ctx.vetoes ?? []), ...(gate?.vetoes ?? [])] };
    const baseline = launchBaseline(site, ctx, policy, options, refuse);
    const locked = ctx.mandatoryLens || ctx.care || ctx.pinned || ctx.resume || ctx.model !== undefined || ctx.effort !== undefined;
    const overlay = locked ? undefined : inputs.coordinator;
    // Concretize inherited routes with their actual legacy selection, then run the SAME validator.
    // Keep policy fallback/mode and operator keys so overlays cannot bypass operator decisions.
    const key = options.taskType ? `${site.operation}:${options.taskType}` : site.operation;
    const effectivePolicy = { ...policy, operations: { ...policy.operations,
      [key]: { provider: baseline.provider, model: baseline.model, effort: baseline.effort,
        fallback: baseline.fallback ?? [], ...(baseline.mode ? { mode: baseline.mode } : {}) } } };
    // Include taskTypes and wildcard inheritance, not just operation-local controls.
    const entries = launchPolicyEntries(options);
    const selectedEntry = entries.at(-1);
    if (selectedEntry?.enabledProviders) effectivePolicy.operations[key].enabledProviders = [...selectedEntry.enabledProviders];
    for (const entry of entries) {
      if (entry?.disabledProviders) effectivePolicy.operations[key].disabledProviders =
        [...new Set([...(effectivePolicy.operations[key].disabledProviders ?? []), ...entry.disabledProviders])];
    }
    const route = resolveOperationRoute({ ...options, policy: effectivePolicy, aiRouting: overlay });
    if (!route) refuse('route', 'no concrete launch route');
    const countingRequired = route.mode === 'shadow' || baseline.mode === 'shadow'
      || entries.some(entry => entry.mode === 'shadow');
    const countingPrimary = route.provider === 'claude' && route.mode !== 'shadow';
    const countingFallback = route.fallback.some(candidate => candidate.provider === 'claude'
      && (!options.available || options.available.includes('claude')));
    if (site.kind === 'review' && countingRequired && !countingPrimary && !countingFallback) {
      refuse('counting-reviewer', 'shadow review requires an available counting Claude reviewer');
    }
    const readsRepo = site.readsRepo || ctx.readsRepo === true;
    const claudeOnly = ['red-team-recheck', 'ci-heal', 'helper'].includes(role);
    for (const candidate of [route, ...route.fallback]) {
      // Legacy policy matching also groups agy providers under antigravity. An exact
      // launch veto is independently binding, including provider-wide vetoes and fallbacks.
      if (options.vetoes.some(veto => veto?.provider === candidate.provider
        && (veto.model == null || veto.model === candidate.model))) {
        refuse('veto', `launch route ${candidate.provider}/${candidate.model} is explicitly vetoed`);
      }
      checkCombination(candidate);
      const changed = ['provider', 'model', 'effort'].some(field => candidate[field] !== baseline[field]);
      if ((claudeOnly || (changed && readsRepo)) && candidate.provider !== 'claude') {
        refuse('provider', 'this seat requires native Claude');
      }
      // A shadow's counting Claude seat has its own legacy floor, distinct from
      // the non-counting shadow primary. Preserve that explicitly recorded contract.
      const candidateFloor = candidate !== route && baseline.mode === 'shadow' && candidate.provider === 'claude'
        ? baseline.fallback.find(next => next.provider === 'claude') ?? baseline : baseline;
      checkLaunchFloor(candidateFloor, candidate, AI_ROUTING_FLOORS[role], refuse);
    }
    return freeze({ provider: route.provider, model: route.model, effort: route.effort, env: structuredClone(ctx.env),
      fallback: structuredClone(route.fallback), ...(route.mode ? { mode: route.mode } : {}),
      readsRepo, budget: structuredClone(ctx.budget ?? null),
      floor: { rule: AI_ROUTING_FLOORS[role], provider: baseline.provider, model: baseline.model, effort: baseline.effort,
        fallback: structuredClone(baseline.fallback ?? []), ...(baseline.mode ? { mode: baseline.mode } : {}) },
      sources: { baseline: siteKey, settings: resolved.sources }, overlay: overlay ? structuredClone(overlay) : null });
  } catch (error) {
    if (error instanceof AiRoutingRefusal) throw error;
    refuse('resolver', error instanceof Error ? error.message : String(error));
  }
}
