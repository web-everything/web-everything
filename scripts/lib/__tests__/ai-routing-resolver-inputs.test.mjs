import { describe, expect, it, vi } from 'vitest';
import { AI_ROUTING_STANDARD, resolveAiRouting, aiRoutingInputs } from '../ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY, applyRoutingOverrides, resolveOperationRoute } from '../dispatch-routing-policy.mjs';
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
      const value = { providers: { codex: false }, review: { coordinator: { model: 'gpt-6-astra' } } };
      const log = vi.fn();
      const resolved = resolve(layer === 'tool' ? value : {}, { log,
        ...(layer === 'platform' ? { platform: value } : {}),
        ...(layer === 'env' ? { env: { WE_AI_ROUTING: JSON.stringify(value) } } : {}),
      });
      expect(resolved.value).not.toHaveProperty('providers');
      expect(resolved.invalid.join(' ')).toMatch(/providers/);
      expect(log.mock.calls.flat().join(' ')).toMatch(/providers/);
      expect(aiRoutingInputs('review', resolved).coordinator).toEqual({ model: 'gpt-6-astra' });
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
