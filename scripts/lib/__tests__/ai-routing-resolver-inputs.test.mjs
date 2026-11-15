import { describe, expect, it, vi } from 'vitest';
import { AI_ROUTING_ROLES, AI_ROUTING_STANDARD, resolveAiRouting, aiRoutingInputs } from '../ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY, applyRoutingOverrides, resolveOperationRoute, validateRoutingPolicy } from '../dispatch-routing-policy.mjs';
import { createRoutingPolicyReader, resolveOperationRoute as resolveIoRoute } from '../dispatch-routing-policy-io.mjs';
import { resolveCodexTaskRoute } from '../codex-task-route.mjs';
import { resolveFixExecutorChain, pickChainRung } from '../fix-executor-chain.mjs';

const resolve = (tool = {}, options = {}) => resolveAiRouting({
  tool, platform: {}, env: {}, accountMap: { accounts: {} }, log: false, ...options,
});
const coordinator = (role, route) => aiRoutingInputs(role, resolve({ [role]: { coordinator: route } })).coordinator;
const codexRoute = { provider: 'codex', model: 'gpt-6-astra', effort: 'high',
  fallback: [{ provider: 'claude', model: 'sonnet', effort: 'high' }] };
const operation = options => resolveOperationRoute({ operation: 'fix', taskType: 'doc-fix',
  policy: DEFAULT_ROUTING_POLICY, operatorKeys: [], ...options });
const codex = options => resolveCodexTaskRoute({ kind: 'fix', env: {}, tool: {}, platform: {}, log: false, ...options });
const chain = options => resolveFixExecutorChain({ env: {}, platform: {},
  repo: { routing: { builder: 'codex' } }, ...options });

describe('aiRouting resolver inputs: audit regressions', () => {
  it.each(AI_ROUTING_ROLES)('%s coordinator producer/consumer contract covers every Claude leaf subset', role => {
    const fields = role === 'fix' ? [['account', 'a']]
      : [['provider', 'claude'], ['model', 'sonnet'], ['effort', 'high'], ['account', 'a']];
    for (let mask = 0; mask < 2 ** fields.length; mask++) {
      const leaves = Object.fromEntries(fields.filter((_, index) => mask & (1 << index)));
      const resolved = resolve({ [role]: { coordinator: leaves } }, { accountMap: { accounts: { a: {} } } });
      const partialPair = Boolean(leaves.provider) !== Boolean(leaves.model);
      expect(resolved.invalid.length > 0, JSON.stringify(leaves)).toBe(partialPair);
      const aiRouting = aiRoutingInputs(role, resolved).coordinator;
      expect(aiRouting ?? {}).not.toHaveProperty('account');
      const expected = partialPair ? {} : Object.fromEntries(Object.entries(leaves).filter(([key]) => key !== 'account'));
      expect(aiRouting).toEqual(Object.keys(expected).length ? expected : undefined);
      expect(() => operation({ aiRouting }), JSON.stringify(leaves)).not.toThrow();
      if (leaves.account && !partialPair) expect(resolved.value[role].coordinator.account).toBe('a');
    }
  });

  it.each([{ provider: 'codex' }, { model: 'gpt-6-astra' }])('partial coordinator %j retains the last valid pair and sources', patch => {
    const lower = { provider: 'claude', model: 'sonnet', effort: 'high' };
    const resolved = resolve({ build: { coordinator: patch } }, { platform: { build: { coordinator: lower } } });
    expect(aiRoutingInputs('build', resolved).coordinator).toEqual(lower);
    expect(resolved.sources['build.coordinator.provider']).toBe('platform');
    expect(resolved.sources['build.coordinator.model']).toBe('platform');
    expect(resolved.invalid.length).toBeGreaterThan(0);
  });

  it.each([{ provider: 'codex' }, { model: 'gpt-6-astra' }])('operation resolver rejects ambiguous direct slice %j', aiRouting => {
    for (const route of [codexRoute, { provider: 'claude', model: 'sonnet', fallback: [] }]) {
      const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { fix: route });
      expect(() => operation({ policy, aiRouting })).toThrow(/provider and model.*together/);
      expect(operation({ policy, aiRouting: { effort: 'medium' } })).toMatchObject({ provider: route.provider, effort: 'medium' });
    }
  });

  it.each([
    [{ provider: 'codex' }, {}],
    [{ model: 'gpt-6-astra' }, { model: 'gpt-6-astra', sources: { model: 'aiRouting' } }],
    [{ effort: 'medium' }, { effort: 'medium', sources: { effort: 'aiRouting' } }],
  ])('Codex accepts provider-scoped partial slice %j', (aiRouting, expected) => {
    const result = codex({ aiRouting });
    expect(result).toMatchObject(expected);
    if (aiRouting.provider) expect(result).toEqual(codex({}));
  });

  it.each(['claude', 'agy-claude', 'agy-gemini', 'antigravity'])('Codex ignores coordinator leaves for %s', provider => {
    for (const leaves of [{}, { effort: 'low' }, { model: provider === 'agy-gemini' ? 'flash' : 'sonnet', effort: 'high' }]) {
      const aiRouting = { provider, ...leaves };
      expect(codex({ aiRouting })).toEqual(codex({}));
      expect(codex({ aiRouting, model: 'gpt-6-astra', effort: 'medium' }))
        .toEqual(codex({ model: 'gpt-6-astra', effort: 'medium' }));
    }
  });

  it('IO wrapper uses keys from its injected reader without explicit policy or operatorKeys', () => {
    let broken = false;
    let overrides = { fix: { provider: 'claude', model: 'opus', fallback: [] } };
    const reader = createRoutingPolicyReader({ env: {}, initial: DEFAULT_ROUTING_POLICY,
      read: () => { if (broken) throw new Error('unreadable fixture'); return JSON.stringify(DEFAULT_ROUTING_POLICY); },
      preferences: () => ({ prefs: { routingOverrides: overrides }, errors: [] }), emit: () => {}, log: vi.fn() });
    const run = () => resolveIoRoute({ operation: 'fix', taskType: 'doc-fix', aiRouting: codexRoute }, { readPolicy: reader });
    expect(run()).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    broken = true;
    overrides = {};
    expect(run()).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    broken = false;
    expect(run()).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
  });

  it.each(['tool', 'env'])('invalid %s combinations retain lower restrictions and provenance', layer => {
    const lower = { fix: { executors: ['claude'] },
      build: { coordinator: { provider: 'claude', model: 'sonnet', effort: 'high' }, executors: ['claude'] } };
    const invalid = { fix: { executors: ['codex'] },
      build: { coordinator: { model: 'gpt-6-astra' } } };
    const resolved = resolve(layer === 'tool' ? invalid : lower, {
      platform: lower,
      ...(layer === 'env' ? { env: { WE_AI_ROUTING: JSON.stringify(invalid) } } : {}),
    });
    expect(aiRoutingInputs('fix', resolved).executors).toEqual(['claude']);
    expect(chain({ aiRouting: aiRoutingInputs('fix', resolved).executors }).value).toEqual(['claude']);
    expect(aiRoutingInputs('build', resolved).coordinator).toEqual(lower.build.coordinator);
    const source = layer === 'tool' ? 'platform' : 'tool';
    expect(resolved.sources['fix.executors']).toBe(source);
    expect(resolved.sources['build.coordinator.model']).toBe(source);
    expect(resolved.leafValues['fix.executors']).toEqual(['claude']);
    expect(resolved.invalid.join(' ')).toMatch(/fix/);
  });

  it('invalid leaves retain non-default lower values and valid siblings', () => {
    const resolved = resolve({ review: { coordinator: { provider: 'unknown', effort: 'high' } } }, {
      platform: { review: { coordinator: { provider: 'claude', model: 'opus' } } },
    });
    expect(aiRoutingInputs('review', resolved).coordinator).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
    expect(resolved.sources['review.coordinator.provider']).toBe('platform');
    expect(resolved.sources['review.coordinator.effort']).toBe('tool');
  });

  it('profile combinations cannot invalidate lower writer chains', () => {
    const resolved = resolve({ executorProfiles: { claude: { provider: 'codex', model: 'gpt-6-astra' } } }, {
      platform: { fix: { executors: ['claude'] } },
    });
    expect(aiRoutingInputs('fix', resolved).executors).toEqual(['claude']);
    expect(resolved.value.executorProfiles.claude.provider).toBe('claude');
    expect(resolved.sources['fix.executors']).toBe('platform');
    expect(resolved.invalid.length).toBeGreaterThan(0);
  });

  it.each(['fallback', 'effort', 'non-counting-fallback'])('task-derived shadow overlays revalidate %s', variant => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations['review-seat:mandatory:correctness'] = { inherit: true };
    policy.taskTypes['mandatory:correctness'] = { provider: 'agy-claude', model: 'sonnet', mode: 'shadow',
      fallback: [{ provider: 'claude', model: 'sonnet' }] };
    const options = { operation: 'review-seat', taskType: 'mandatory:correctness',
      policy: validateRoutingPolicy(policy), operatorKeys: [] };
    expect(resolveOperationRoute({ ...options, aiRouting: { effort: 'high' } })).toMatchObject({ mode: 'shadow' });
    const aiRouting = variant === 'fallback' ? { fallback: [] }
      : variant === 'effort' ? { effort: { codex: 'invalid' } }
      : { fallback: [{ provider: 'agy-claude', model: 'sonnet' }] };
    expect(() => resolveOperationRoute({ ...options, aiRouting })).toThrow(/claude|effort/i);
    expect(resolveOperationRoute({ ...options, aiRouting: { effort: 'high' }, gateClosed: true }))
      .toMatchObject({ provider: 'claude', fallback: [] });
    expect(resolveOperationRoute({ ...options, aiRouting: { effort: 'high' }, gateClosed: true })).not.toHaveProperty('mode');
  });

  it.each(['disabled', 'held', 'unavailable'])('task shadow overlays cannot lose the counting fallback through %s', constraint => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations.helper = { inherit: true, ...(constraint === 'disabled' ? { disabledProviders: ['claude'] } : {}) };
    policy.taskTypes['shadow-helper'] = { provider: 'agy-claude', model: 'sonnet', mode: 'shadow',
      fallback: [{ provider: 'claude', model: 'sonnet' }] };
    expect(() => resolveOperationRoute({ operation: 'helper', taskType: 'shadow-helper',
      policy: validateRoutingPolicy(policy), operatorKeys: [], aiRouting: { effort: 'high' },
      ...(constraint === 'held' ? { availability: { claude: 'held' } } : {}),
      ...(constraint === 'unavailable' ? { available: ['agy-claude'] } : {}),
    })).toThrow(/claude/i);
  });

  it.each(['initial', 'environment'])('retained %s snapshots protect operator routes before a successful read', source => {
    const initial = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { fix: { provider: 'claude', model: 'opus', fallback: [] } });
    let broken = true;
    const reader = createRoutingPolicyReader({
      ...(source === 'initial' ? { initial, env: {} } : { env: { WE_DISPATCH_ROUTING_SNAPSHOT: JSON.stringify(initial) } }),
      read: () => { if (broken) throw new Error('unreadable fixture'); return JSON.stringify(DEFAULT_ROUTING_POLICY); },
      preferences: () => ({ prefs: {}, errors: [] }), emit: () => {}, log: vi.fn(),
    });
    expect(reader.operatorKeys()).toContain('fix');
    const keys = reader.operatorKeys();
    keys.length = 0;
    expect(reader.operatorKeys()).toContain('fix');
    const policy = reader();
    expect(reader.operatorKeys()).toContain('fix');
    expect(resolveIoRoute({ operation: 'fix', policy, operatorKeys: reader.operatorKeys(), aiRouting: codexRoute }))
      .toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    broken = false;
    reader();
    expect(reader.operatorKeys()).toEqual([]);
  });

  it('operation_patch_keeps_disabled_providers: positive control applies the input before selection', () => {
    const aiRouting = { ...coordinator('build', { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }),
      fallback: codexRoute.fallback };
    expect(operation({ aiRouting })).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', effort: 'high' });
  });

  it('operation_patch_keeps_disabled_providers: operation and task disables survive the patch', () => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations.fix = { inherit: true, enabledProviders: ['claude'], disabledProviders: ['codex'] };
    policy.taskTypes['doc-fix'] = { provider: 'agy-claude', model: 'sonnet', disabledProviders: ['agy-claude'],
      fallback: codexRoute.fallback };
    const before = structuredClone(policy);
    const aiRouting = { ...codexRoute, fallback: [{ provider: 'agy-claude', model: 'sonnet' }, ...codexRoute.fallback] };
    expect(operation({ policy, aiRouting })).toMatchObject({ provider: 'claude', fallback: [] });
    expect(() => operation({ policy, aiRouting, available: ['codex', 'agy-claude'] })).toThrow(/no available route/);
    expect(policy).toEqual(before);
  });

  it('codex_pin_respects_vetoes: positive control accepts a role pin and leaves caller pins explicit', () => {
    const aiRouting = coordinator('build', { provider: 'codex', model: 'gpt-6-astra', effort: 'high' });
    expect(codex({ aiRouting })).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
    expect(codex({ aiRouting, model: 'gpt-6.1-sol', effort: 'medium' }))
      .toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium', sources: { model: 'explicit', effort: 'explicit' } });
  });

  it('codex_pin_respects_vetoes: guard rejects the final model including explicit and inherited pins', () => {
    const aiRouting = { model: 'gpt-6-astra', effort: 'high' };
    const vetoes = [{ provider: 'codex', model: 'gpt-6-astra' }];
    expect(() => codex({ aiRouting, vetoes })).toThrow(/veto/i);
    expect(() => codex({ aiRouting, model: 'gpt-6-astra', vetoes })).toThrow(/veto/i);
    expect(() => codex({ vetoes: [{ provider: 'codex', model: 'gpt-6.1-sol' }] })).toThrow(/veto/i);
    expect(codex({ aiRouting, vetoes: [{ provider: 'antigravity', model: 'gpt-6-astra' }] }).model).toBe('gpt-6-astra');
    expect(() => codex({ aiRouting: { model: 'gpt-6-luna', effort: 'ultra' } })).toThrow(/does not support effort/);
  });

  it('providers_block_rejected_in_pr1: positive control resolves valid role leaves and their sources', () => {
    const resolved = resolve({ review: { coordinator: { provider: 'codex', model: 'gpt-6-astra' } } });
    expect(aiRoutingInputs('review', resolved).coordinator).toEqual({ provider: 'codex', model: 'gpt-6-astra' });
    expect(resolved.sources['review.coordinator.model']).toBe('tool');
    expect(resolved.invalid).toEqual([]);
  });

  it('partial_environment_executors_preserve_tool_coordinator_and_sources', () => {
    const coordinator = { provider: 'codex', model: 'gpt-6-astra', effort: 'high' };
    const resolved = resolve({ build: { coordinator, executors: ['codex', 'claude'] } }, {
      env: { WE_AI_ROUTING: JSON.stringify({ build: { executors: ['argon', 'claude'] } }) },
    });
    expect(aiRoutingInputs('build', resolved)).toEqual({ coordinator, executors: ['argon', 'claude'] });
    for (const field of Object.keys(coordinator)) expect(resolved.sources[`build.coordinator.${field}`]).toBe('tool');
    expect(resolved.sources['build.executors']).toBe('env');
    expect(resolved.invalid).toEqual([]);
  });

  it('providers_block_rejected_in_pr1: guard rejects provider settings in every layer without dropping valid siblings', () => {
    expect(AI_ROUTING_STANDARD).not.toHaveProperty('providers');
    for (const layer of ['platform', 'tool', 'env']) {
      const value = { providers: { codex: false }, review: { coordinator: { provider: 'codex', model: 'gpt-6-astra' } } };
      const log = vi.fn();
      const resolved = resolve(layer === 'tool' ? value : {}, { log,
        ...(layer === 'platform' ? { platform: value } : {}),
        ...(layer === 'env' ? { env: { WE_AI_ROUTING: JSON.stringify(value) } } : {}),
      });
      expect(resolved.value).not.toHaveProperty('providers');
      expect(resolved.invalid.join(' ')).toMatch(/providers/);
      expect(log.mock.calls.flat().join(' ')).toMatch(/providers/);
      expect(aiRoutingInputs('review', resolved).coordinator).toEqual({ provider: 'codex', model: 'gpt-6-astra' });
      expect(resolved.sources['review.coordinator.model']).toBe(layer);
    }
  });

  it('inherited_routes_enforce_final_policy: positive control inherits task routes and preserves all-inherit behaviour', () => {
    const aiRouting = aiRoutingInputs('fix', resolve()).coordinator;
    expect(aiRouting).toBeUndefined();
    expect(operation({ aiRouting })).toEqual(operation({}));
    expect(operation({ aiRouting })).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol' });
  });

  it('inherited_routes_enforce_final_policy: inherited slices still pass gate, holds, vetoes and exhaustion checks', () => {
    const aiRouting = aiRoutingInputs('fix', resolve()).coordinator;
    for (const constraints of [{ gateClosed: true }, { availability: { codex: 'held' } },
      { vetoes: [{ provider: 'codex', model: 'gpt-6.1-sol' }] }]) {
      expect(operation({ aiRouting, ...constraints })).toMatchObject({ provider: 'claude', fallback: [] });
    }
    expect(() => operation({ aiRouting, availability: { codex: 'held', claude: 'held' } })).toThrow(/no available route/);
    expect(() => operation({ aiRouting: codexRoute })).not.toThrow();
    expect(operation({ aiRouting: codexRoute, gateClosed: true })).toMatchObject({ provider: 'claude' });
    expect(operation({ aiRouting: codexRoute, availability: { codex: 'held' } })).toMatchObject({ provider: 'claude' });
    expect(operation({ aiRouting: codexRoute, vetoes: [{ provider: 'codex', model: 'gpt-6-astra' }] }))
      .toMatchObject({ provider: 'claude' });
    expect(() => operation({ aiRouting: codexRoute, available: [] })).toThrow(/no available route/);
  });

  it('role_overlays_preserve_fix_chain_safety: positive control puts aiRouting between repo and env', () => {
    const inputs = aiRoutingInputs('fix', resolve({ fix: { executors: ['argon', 'claude'] } }));
    const options = { repo: { routing: { builder: 'codex' }, fixExecutor: { fallbackChain: ['codex', 'claude'] } },
      aiRouting: inputs.executors };
    expect(chain(options)).toMatchObject({ value: ['argon', 'claude'], source: 'aiRouting' });
    expect(chain({ ...options, env: { WE_FIX_EXECUTOR_FALLBACK_CHAIN: 'codex-alt,claude' } }))
      .toMatchObject({ value: ['codex-alt', 'claude'], source: 'env' });
  });

  it('role_overlays_preserve_fix_chain_safety: builder strip and critical escalation follow role inputs', () => {
    const aiRouting = ['codex', 'codex-alt', 'argon', 'claude'];
    expect(chain({ aiRouting, repo: { routing: { builder: 'claude' } } }))
      .toMatchObject({ value: ['argon', 'claude'], source: 'aiRouting+routing.builder' });
    const resolved = chain({ aiRouting });
    const pick = options => pickChainRung({ chain: resolved.value, critical: true,
      criticalClaudeFromRung: resolved.criticalClaudeFromRung, criticalSource: resolved.criticalClaudeFromRungSource, ...options });
    expect(pick({})).toMatchObject({ executor: 'codex', rung: 'codex' });
    for (const trigger of ['takeover', 'ruling-not-addressed']) expect(pick({ trigger }))
      .toMatchObject({ executor: 'claude', reason: 'critical work never leaves Claude' });
    expect(pick({ codexUnproductive: 3 })).toMatchObject({ executor: 'claude', rung: 'claude' });
    for (const invalid of [[], ['codex'], ['unknown', 'claude'], ['codex', 'codex', 'claude']]) {
      expect(chain({ aiRouting: invalid })).toEqual(chain({}));
    }
  });

  it('role_overlays_preserve_fix_chain_safety: invalid writer chains inherit and fix coordinators accept only accounts', () => {
    const inherited = aiRoutingInputs('fix', resolve());
    const log = vi.fn();
    const invalid = resolve({ fix: { executors: ['codex'] } }, { log });
    expect(aiRoutingInputs('fix', invalid)).toEqual(inherited);
    expect(log.mock.calls.flat().join(' ')).toMatch(/ai-routing-invalid/);
    const unsafe = resolve({ fix: { coordinator: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' } } });
    expect(aiRoutingInputs('fix', unsafe).coordinator).toBeUndefined();
  });

  it('task_roles_preserve_operator_overrides: positive control applies a role with an explicit empty key snapshot', () => {
    expect(operation({ aiRouting: codexRoute, operatorKeys: [] })).toMatchObject({ model: 'gpt-6-astra' });
    expect(() => operation({ aiRouting: codexRoute, operatorKeys: undefined })).toThrow(/operatorKeys/);
  });

  it.each([
    ['review-seat', 'review-seat'],
    ['review-seat:red-team', 'review-seat'],
    ['review-seat', 'review-seat:extra'],
  ])('task_roles_preserve_operator_overrides: guard respects lookup key %s for %s in pure and IO resolvers', (key, operationName) => {
    const taskType = 'red-team';
    const base = structuredClone(DEFAULT_ROUTING_POLICY);
    base.operations[key] ??= { inherit: true };
    const policy = applyRoutingOverrides(base, { [key]: { provider: 'agy-claude', model: 'sonnet', fallback: [] } });
    const options = { operation: operationName, taskType, policy, operatorKeys: [key], aiRouting: { ...codexRoute, fallback: [] } };
    const expected = resolveOperationRoute({ ...options, aiRouting: undefined });
    expect(resolveOperationRoute(options)).toEqual(expected);
    expect(resolveIoRoute(options)).toEqual(expected);
    expect(resolveOperationRoute({ ...options, operatorKeys: [] })).toMatchObject({ provider: 'codex' });
  });

  it('role_overlays_preserve_policy_rosters_and_mode: seat roster, shadow mode and prepare-decision key are enforced', () => {
    const seat = { operation: 'review-seat', taskType: 'mandatory:correctness', operatorKeys: [] };
    expect(() => resolveOperationRoute({ ...seat, policy: DEFAULT_ROUTING_POLICY, aiRouting: codexRoute })).toThrow(/unsupported seat provider/);
    const shadow = structuredClone(DEFAULT_ROUTING_POLICY);
    shadow.operations['review-seat:mandatory:correctness'] = { ...shadow.operations['review-seat:mandatory:correctness'], provider: 'claude', model: 'sonnet', mode: 'shadow' };
    const input = { operation: 'review-seat', taskType: 'mandatory:correctness', policy: shadow, operatorKeys: [] };
    expect(resolveOperationRoute({ ...input, aiRouting: { effort: 'high' } })).toMatchObject({ mode: 'shadow' });
    const prep = { operation: 'prepare', taskType: 'doc-fix', size: 8, designQuestion: true };
    expect(resolveOperationRoute({ ...prep, policy: DEFAULT_ROUTING_POLICY, operatorKeys: ['prepare-decision'], aiRouting: codexRoute }))
      .toEqual(resolveOperationRoute({ ...prep, policy: DEFAULT_ROUTING_POLICY, operatorKeys: ['prepare-decision'] }));
  });

  it('role_overlays_revalidate_policy: merged seat entry must still count a Claude fallback', () => {
    const base = { operation: 'review-seat', taskType: 'mandatory:correctness', policy: DEFAULT_ROUTING_POLICY, operatorKeys: [] };
    expect(() => resolveOperationRoute({ ...base, aiRouting: { effort: 'high', fallback: [] } })).toThrow(/shadow requires|claude/i);
    expect(resolveOperationRoute({ ...base, aiRouting: { effort: 'high' } })).toMatchObject({ source: 'routing-policy' });
  });

  it('task_roles_preserve_operator_overrides: wildcard operator key blocks the overlay', () => {
    const policy = applyRoutingOverrides(structuredClone(DEFAULT_ROUTING_POLICY), { '*': { provider: 'claude', model: 'sonnet', fallback: [] } });
    const options = { operation: 'fix', taskType: 'unlisted-task', policy, operatorKeys: ['*'] };
    expect(resolveOperationRoute({ ...options, aiRouting: codexRoute })).toEqual(resolveOperationRoute(options));
    expect(resolveOperationRoute({ ...options, operatorKeys: [], aiRouting: codexRoute })).toMatchObject({ provider: 'codex' });
  });

  it('task_roles_preserve_operator_overrides: reader retains applied keys with its last-good snapshot', () => {
    let overrides = {};
    let broken = false;
    const reader = createRoutingPolicyReader({ env: {}, initial: DEFAULT_ROUTING_POLICY,
      read: () => { if (broken) throw new Error('unreadable fixture'); return JSON.stringify(DEFAULT_ROUTING_POLICY); },
      preferences: () => ({ prefs: { routingOverrides: overrides }, errors: [] }), emit: () => {}, log: vi.fn() });
    reader();
    expect(reader.operatorKeys()).toEqual([]);
    overrides = { 'review-seat': { provider: 'agy-claude', model: 'sonnet', fallback: [] } };
    const good = reader();
    expect(reader.operatorKeys()).toEqual(['review-seat']);
    // Preferences now disagree with the retained snapshot: re-reading them would lose the operator's key.
    overrides = {};
    broken = true;
    expect(reader()).toBe(good);
    expect(reader.operatorKeys()).toEqual(['review-seat']);
    const keys = reader.operatorKeys();
    keys.push('fix');
    expect(reader.operatorKeys()).toEqual(['review-seat']);
    broken = false;
    reader();
    expect(reader.operatorKeys()).toEqual([]);
  });
});
