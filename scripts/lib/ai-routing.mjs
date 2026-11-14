/** Role routing facade. Existing launch sites migrate separately; inherit calls their current resolvers. */
import { cascadePolicy, readPlatformPreferences, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { workerTierFor } from './provider-routing.mjs';
import { resolveOperationRoute, readRoutingPolicy } from './dispatch-routing-policy-io.mjs';
import { applyRoutingOverrides, resolvePolicyModel, resolvePolicyEffort } from './dispatch-routing-policy.mjs';
import { resolveCodexTaskRoute } from './codex-task-route.mjs';
import { CODEX_MODEL_CATALOGUE, CODEX_EFFORT_MAP, codexModelSupportsEffort } from './codex-model-routing.mjs';
import { FIX_EXECUTOR_RUNGS, resolveFixExecutorChain, pickChainRung } from './fix-executor-chain.mjs';
import { resolveClaudeHelperRoute } from './claude-helper-route.mjs';
import { resolveAccount, loadAccountMap } from './claude-account.mjs';

export const AI_ROUTING_ROLES = Object.freeze(['review', 'red-team', 'red-team-recheck', 'fix', 'build', 'prepare', 'ci-heal', 'worker', 'judge', 'helper']);
const WRITERS = new Set(['fix', 'build', 'ci-heal', 'prepare', 'worker']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const inheritRole = () => ({ coordinator: { provider: 'inherit', model: 'inherit', effort: 'inherit', account: 'inherit' }, executors: 'inherit' });
const freeze = v => { if (object(v) || Array.isArray(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
export const AI_ROUTING_STANDARD = freeze({
  providers: { claude: true, codex: true, 'agy-claude': true, 'agy-gemini': true, local: false },
  executorProfiles: Object.fromEntries(Object.entries(FIX_EXECUTOR_RUNGS).map(([id, rung]) => [id,
    { provider: rung.executor, ...rung.policyRoute, model: rung.policyRoute?.model ?? 'inherit', effort: rung.policyRoute?.effort ?? 'inherit', account: 'inherit' }])),
  ...Object.fromEntries(AI_ROUTING_ROLES.map(role => [role, inheritRole()])),
});
const providers = ['claude', 'codex', 'agy-claude', 'agy-gemini', 'antigravity'];
const modelValid = v => typeof v === 'string' && (Object.hasOwn(CODEX_MODEL_CATALOGUE, v)
  || providers.some(provider => { try { resolvePolicyModel(provider, v); return true; } catch { return false; } }));
const loggedInvalid = new Set();
function invalidRole(role, detail, log) {
  const key = `${role}:${detail}`;
  if (!loggedInvalid.has(key)) {
    loggedInvalid.add(key);
    try { (log === false ? () => {} : log ?? console.error)(`ai-routing-invalid · ${role}: ${detail}; using inherit`); } catch { /* diagnostic only */ }
  }
}

/** Per-dotted-path predicates; unknown paths refuse values rather than silently expanding the schema. */
export function aiRoutingValidators({ accountMap = loadAccountMap() } = {}) {
  const fields = {
    provider: v => v === 'inherit' || providers.includes(v),
    model: v => v === 'inherit' || modelValid(v),
    effort: v => v === 'inherit' || Object.hasOwn(CODEX_EFFORT_MAP, v),
    account: v => v === 'inherit' || (typeof v === 'string' && Object.hasOwn(accountMap?.accounts ?? {}, v)),
  };
  const route = v => object(v) && Object.entries(v).every(([key, value]) => Object.hasOwn(fields, key) && fields[key](value));
  const chain = v => v === 'inherit' || (Array.isArray(v) && v.length > 0 && v.length <= 16
    && v.every(entry => typeof entry === 'string' ? Object.hasOwn(AI_ROUTING_STANDARD.executorProfiles, entry) : route(entry)));
  const role = v => object(v) && Object.entries(v).every(([key, value]) => key === 'coordinator' ? route(value) : key === 'executors' && chain(value));
  const valid = { '': () => false };
  for (const name of AI_ROUTING_ROLES) {
    valid[name] = role;
    valid[`${name}.coordinator`] = route;
    valid[`${name}.executors`] = chain;
    for (const [key, check] of Object.entries(fields)) valid[`${name}.coordinator.${key}`] = check;
  }
  valid.providers = v => object(v) && Object.entries(v).every(([p, enabled]) => valid[`providers.${p}`]?.(enabled) === true);
  for (const p of Object.keys(AI_ROUTING_STANDARD.providers)) valid[`providers.${p}`] = v => typeof v === 'boolean' && (p !== 'local' || v === false);
  for (const id of Object.keys(AI_ROUTING_STANDARD.executorProfiles)) {
    valid[`executorProfiles.${id}`] = route;
    for (const [key, check] of Object.entries(fields)) valid[`executorProfiles.${id}.${key}`] = check;
  }
  return new Proxy(valid, { get: (target, key) => Object.hasOwn(target, key) ? target[key] : () => false });
}
function checkCombination(route, settings) {
  const provider = route.provider;
  if (!provider || provider === 'inherit') return;
  if (settings.providers[provider] === false || (provider === 'antigravity'
    && settings.providers[route.model?.startsWith('gemini-') ? 'agy-gemini' : 'agy-claude'] === false)) throw new TypeError('provider disabled');
  if (route.model && route.model !== 'inherit') {
    if (provider === 'codex' && Object.hasOwn(CODEX_MODEL_CATALOGUE, route.model)) {
      if (route.effort && route.effort !== 'inherit' && !codexModelSupportsEffort(route.model, route.effort)) throw new TypeError('unsupported Codex model/effort');
    } else resolvePolicyModel(provider, route.model);
  }
  if (route.effort && route.effort !== 'inherit') resolvePolicyEffort(provider, route.effort);
  if (typeof route.account === 'string' && route.account !== 'inherit' && provider !== 'claude') throw new TypeError('account requires native Claude');
}
export function resolveAiRouting({ env = process.env, tool = readSettings().aiRouting, platform, log, accountMap } = {}) {
  let envValues = {};
  if (env.WE_AI_ROUTING !== undefined) {
    try { envValues = JSON.parse(env.WE_AI_ROUTING); if (!object(envValues)) throw new TypeError(); }
    catch { envValues = { '': env.WE_AI_ROUTING }; }
  }
  const resolved = cascadePolicy('aiRouting', tool, { standard: AI_ROUTING_STANDARD, envValues,
    valid: aiRoutingValidators({ accountMap }), platform, env, log: log === false ? () => {} : log });
  resolved.value.providers = { ...AI_ROUTING_STANDARD.providers, ...resolved.value.providers };
  resolved.value.executorProfiles = Object.fromEntries(Object.entries(AI_ROUTING_STANDARD.executorProfiles)
    .map(([id, profile]) => [id, { ...profile, ...resolved.value.executorProfiles?.[id] }]));
  for (const role of AI_ROUTING_ROLES) {
    const value = resolved.value[role];
    resolved.value[role] = { ...inheritRole(), ...value, coordinator: { ...inheritRole().coordinator, ...value?.coordinator } };
    try {
      checkCombination(resolved.value[role].coordinator, resolved.value);
      if (resolved.value[role].executors !== 'inherit') {
        const chain = resolved.value[role].executors.map(entry => typeof entry === 'string' ? resolved.value.executorProfiles[entry] : entry);
        chain.forEach(entry => checkCombination(entry, resolved.value));
        if (WRITERS.has(role) && chain.at(-1)?.provider !== 'claude') throw new TypeError('code-writing chain must end with Claude');
      }
    } catch (error) {
      invalidRole(role, error.message, log);
      resolved.value[role] = inheritRole();
      for (const path of Object.keys(resolved.sources)) if (path === role || path.startsWith(`${role}.`)) delete resolved.sources[path];
      for (const key of Object.keys(inheritRole().coordinator)) resolved.sources[`${role}.coordinator.${key}`] = 'standard';
      resolved.sources[`${role}.executors`] = 'standard';
    }
  }
  return resolved;
}
const operationFor = role => ({ review: 'review-seat', 'red-team': 'review-seat', 'red-team-recheck': 'review-recheck', prepare: 'prepare-item', helper: 'precedent-draft' }[role] ?? role);
const taskKind = role => ['review', 'red-team', 'red-team-recheck', 'judge'].includes(role) ? 'review' : role === 'helper' ? 'worker' : role;
const overlay = (base, patch) => ({ ...base, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== 'inherit')) });

/** ctx carries the same task, policy, availability and pin inputs as the existing resolver for that launch site.
 * legacy seams isolate each existing settings family in parity tests; they are not aiRouting layers.
 */
export function routeForRole(role, ctx = {}) {
  if (!AI_ROUTING_ROLES.includes(role)) throw new TypeError(`ai-routing: unknown role ${role}`);
  const { env = process.env, log, policy = readRoutingPolicy(), accountMap = loadAccountMap() } = ctx;
  const resolved = ctx.routing ?? resolveAiRouting({ ...ctx, env, log, accountMap });
  const setting = resolved.value[role];
  const operation = ctx.operation ?? operationFor(role);
  const taskType = ctx.taskType ?? (role === 'red-team' ? 'red-team' : undefined);
  const options = { ...ctx, operation, taskType, policy };
  // Generic helpers use the helper resolver; named operations (such as precedent-draft) keep their policy route.
  const configured = role === 'helper' && ctx.operation === undefined ? null : resolveOperationRoute(options);
  const tier = workerTierFor({ ...ctx, kind: ctx.kind ?? role });
  const helper = () => resolveClaudeHelperRoute({ env, log, ...ctx.legacy?.helper });
  const codex = (route) => ({ ...route, ...resolveCodexTaskRoute({ ...ctx, kind: ctx.kind ?? taskKind(role), env, log,
    ...ctx.legacy?.codex, ...((ctx.model ?? route.model) ? { model: ctx.model ?? route.model } : {}), ...((ctx.effort ?? route.effort) ? { effort: ctx.effort ?? route.effort } : {}) }) });
  const native = () => ({ provider: 'claude', model: ['helper', 'judge'].includes(role) ? helper().model : tier.tier,
    ...(ctx.model ? { model: ctx.model } : {}), ...(ctx.effort ? { effort: ctx.effort } : {}), source: ['helper', 'judge'].includes(role) ? 'claude-helper' : 'worker-tier' });
  let base = configured ?? (ctx.provider === 'codex' ? { provider: 'codex', source: 'codex-task' } : native());
  let executors;
  if (role === 'fix') {
    const chain = resolveFixExecutorChain({ env, ...ctx.legacy?.fix });
    const selected = pickChainRung({ ...ctx, chain: chain.value, criticalClaudeFromRung: chain.criticalClaudeFromRung, criticalSource: chain.criticalClaudeFromRungSource });
    if (!configured) base = { ...selected, provider: selected.executor, ...(selected.executor === 'claude' ? native() : selected.policyRoute) };
    executors = chain.value.map(id => ({ id, provider: FIX_EXECUTOR_RUNGS[id].executor, ...FIX_EXECUTOR_RUNGS[id].policyRoute, source: chain.source }));
  } else executors = [base, ...(base.fallback ?? [])].map((route, index) => ({ id: `${role}:${index}`, ...route, source: route.source ?? base.source }));
  if (WRITERS.has(role) && role !== 'fix' && executors.at(-1)?.provider !== 'claude') executors.push({ id: `${role}:claude`, ...native() });
  if (base.provider === 'codex') base = codex(base);
  const inherited = { ...base, account: resolveAccount(env, accountMap), source: base.source };
  let coordinator = overlay(inherited, setting.coordinator);
  const sourceFor = key => resolved.sources[`${role}.coordinator.${key}`] ?? resolved.sources[role] ?? 'standard';
  const changed = Object.values(setting.coordinator).some(value => value !== 'inherit') || setting.executors !== 'inherit';
  if (changed) {
    try {
      checkCombination(coordinator, resolved.value);
      if (setting.executors !== 'inherit') {
        const inheritedExecutors = executors;
        executors = setting.executors.map((entry, index) => {
          const profile = typeof entry === 'string' ? resolved.value.executorProfiles[entry] : entry;
          const provider = profile.provider === 'inherit' || profile.provider === undefined ? inherited.provider : profile.provider;
          const baseline = provider === inherited.provider ? inherited : inheritedExecutors.find(route => route.provider === provider)
            ?? { provider, ...(provider === 'claude' ? { model: tier.tier } : {}) };
          return { id: typeof entry === 'string' ? entry : `${role}:${index}`, ...overlay(baseline, profile),
            source: resolved.sources[`${role}.executors`] ?? resolved.sources[role] };
        });
      }
      executors.forEach(route => checkCombination(route, resolved.value));
    } catch (error) {
      invalidRole(role, error.message, log);
      return routeForRole(role, { ...ctx, routing: { ...resolved, value: { ...resolved.value, [role]: inheritRole() } } });
    }
    const patch = { provider: coordinator.provider, model: coordinator.model, effort: coordinator.effort ?? 'medium', fallback: executors
      .filter(route => route.provider !== coordinator.provider || route.model !== coordinator.model)
      .map(route => ({ provider: route.provider, model: route.model ?? (route.provider === 'claude' ? 'sonnet' : 'default'), effort: route.effort ?? 'medium' })) };
    // Put role settings below operator overrides, then run the established gate/availability router again.
    const key = taskType ? `${operation}:${taskType}` : operation;
    const seed = { ...policy, operations: { ...policy.operations, [key]: { inherit: true } } };
    const rolePolicy = applyRoutingOverrides(seed, { [key]: patch });
    const overrides = ctx.routingOverrides ?? readPlatformPreferences({ env }).prefs.routingOverrides ?? {};
    const checked = resolveOperationRoute({ ...options, policy: applyRoutingOverrides(rolePolicy, overrides) });
    if (!checked) throw new TypeError('ai-routing: no usable route');
    const changedFields = Object.keys(setting.coordinator).filter(key => setting.coordinator[key] !== 'inherit');
    const operatorWins = Object.hasOwn(overrides, key) || Object.hasOwn(overrides, operation);
    coordinator = { ...coordinator, ...checked, source: operatorWins ? 'platform' : changedFields.length ? sourceFor(changedFields[0])
      : resolved.sources[`${role}.executors`] ?? resolved.sources[role] ?? 'standard',
      sources: { ...coordinator.sources, ...Object.fromEntries(changedFields.map(key => [key, sourceFor(key)])) } };
    if (coordinator.provider === 'codex') coordinator = codex(coordinator);
    executors = [coordinator, ...checked.fallback].map((route, index) => ({ id: executors[index]?.id ?? `${role}:${index}`, ...route }));
  }
  if (typeof coordinator.account === 'string') {
    if (!Object.hasOwn(accountMap?.accounts ?? {}, coordinator.account)) throw new TypeError('ai-routing: account refuses launch');
    coordinator.account = { kind: 'account', account: coordinator.account };
  }
  if (coordinator.account?.kind === 'refuse') throw new TypeError('ai-routing: account refuses launch');
  logCascadeSources(`aiRouting.${role}`, { value: { coordinator, executors }, sources: { coordinator: coordinator.source ?? 'inherit', executors: resolved.sources[`${role}.executors`] ?? resolved.sources[role] ?? 'standard' } }, { env, log: log === false ? () => {} : log });
  return { role, coordinator, executors };
}
