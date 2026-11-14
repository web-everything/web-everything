import { describe, it, expect, vi } from 'vitest';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_ROUTING_STANDARD, AI_ROUTING_ROLES, resolveAiRouting, routeForRole } from '../ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY, applyRoutingOverrides } from '../dispatch-routing-policy.mjs';
import { resolveOperationRoute } from '../dispatch-routing-policy-io.mjs';
import { workerTierFor } from '../provider-routing.mjs';
import { resolveCodexTaskRoute } from '../codex-task-route.mjs';
import { resolveClaudeHelperRoute } from '../claude-helper-route.mjs';
import { resolveFixExecutorChain, pickChainRung } from '../fix-executor-chain.mjs';
import { resolveAccount } from '../claude-account.mjs';
import { aiRoutingOperation, finishAiRouting } from '../../operations/ai-routing.mjs';
import { runOperationCli } from '../../operations/cli-adapter.mjs';
import { createMemoryRunStore } from '../../operations/run-store.mjs';
import { createRegistry } from '../../operations/registry.mjs';

const map = { accounts: { a: { type: 'oauth' }, b: { type: 'apikey' } }, daemons: { 'com.we.test': 'b' } };
const resolve = (options = {}) => resolveAiRouting({ env: {}, platform: {}, tool: {}, accountMap: map, log: false, ...options });
const context = (extra = {}) => ({ env: {}, policy: DEFAULT_ROUTING_POLICY, accountMap: map, log: false,
  routing: resolve(), legacy: { codex: { tool: {}, platform: {} }, helper: { tool: {}, platform: {} }, fix: { platform: {}, repo: { routing: { builder: 'codex' } } } }, ...extra });

describe('aiRouting inheritance parity', () => {
  it('ships an empty setting and every role defaults to inherit', async () => {
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(resolvePath(dirname(fileURLToPath(import.meta.url)), '../../settings/ai-routing.json'))).aiRouting).toEqual({});
    for (const role of AI_ROUTING_ROLES) expect(resolve().value[role]).toEqual(AI_ROUTING_STANDARD[role]);
  });
  it.each(AI_ROUTING_ROLES)('%s calls the existing operation route for each context', role => {
    const operation = ({ review: 'review-seat', 'red-team': 'review-seat', 'red-team-recheck': 'review-recheck', prepare: 'prepare-item', helper: 'precedent-draft' })[role] ?? role;
    for (const input of [{}, { gateClosed: true }, { size: 2, designQuestion: false, wellScoped: true }, { taskType: 'doc-fix' }]) {
      const ctx = context(input);
      const taskType = ctx.taskType ?? (role === 'red-team' ? 'red-team' : undefined);
      const old = role === 'helper' ? null : resolveOperationRoute({ ...ctx, operation, taskType });
      const next = routeForRole(role, ctx);
      if (old) {
        const expected = old.provider === 'codex' ? { ...old, ...resolveCodexTaskRoute({ kind: ['review', 'red-team', 'red-team-recheck', 'judge'].includes(role) ? 'review' : role === 'helper' ? 'worker' : role,
          ...input, model: old.model, effort: old.effort, tool: {}, platform: {}, env: {}, log: false }) } : old;
        expect(next.coordinator).toMatchObject(expected);
      } else if (role !== 'fix') {
        expect(next.coordinator.provider).toBe('claude');
        expect(next.coordinator.model).toBe(['helper', 'judge'].includes(role)
          ? resolveClaudeHelperRoute({ tool: {}, platform: {}, env: {}, log: false }).model
          : workerTierFor({ ...ctx, kind: role }).tier);
      }
      expect(next.coordinator.account).toEqual(resolveAccount(ctx.env, map));
    }
  });
  it.each([{}, { trigger: 'takeover' }, { codexUnproductive: 3 }, { critical: true, trigger: 'takeover' }, { launcherAvailable: () => false }])('fix chain and selected rung preserve %j', input => {
    const ctx = context(input);
    const chain = resolveFixExecutorChain({ env: ctx.env, ...ctx.legacy.fix });
    const old = pickChainRung({ ...input, chain: chain.value, criticalClaudeFromRung: chain.criticalClaudeFromRung, criticalSource: chain.criticalClaudeFromRungSource });
    const next = routeForRole('fix', ctx);
    expect(next.coordinator).toMatchObject({ executor: old.executor, rung: old.rung, reason: old.reason });
    expect(next.executors.map(r => r.id)).toEqual(chain.value);
  });
  it('preserves worker tier raises, helper env, Codex pins and daemon account mapping', () => {
    expect(routeForRole('worker', context({ risk: 'high' })).coordinator.model).toBe('opus');
    expect(routeForRole('helper', context({ env: { WE_CLAUDE_HELPER_MODEL: 'haiku', XPC_SERVICE_NAME: 'com.we.test' } })).coordinator)
      .toMatchObject({ model: 'haiku', account: resolveAccount({ XPC_SERVICE_NAME: 'com.we.test' }, map) });
    const ctx = context({ provider: 'codex', model: 'gpt-6-astra', effort: 'high', size: 8 });
    expect(routeForRole('worker', ctx).coordinator).toMatchObject(resolveCodexTaskRoute({ ...ctx, kind: 'worker', tool: {}, platform: {}, log: false }));
  });
  it('named helper operations preserve their operation policy instead of the generic helper default', () => {
    const ctx = context({ operation: 'precedent-draft', env: { WE_CLAUDE_HELPER_MODEL: 'opus' } });
    expect(routeForRole('helper', ctx).coordinator).toMatchObject(resolveOperationRoute(ctx));
  });
});

describe('aiRouting cascade and fail closed', () => {
  it('uses the shared cascade, drops an invalid leaf and keeps its lower value and source', () => {
    const result = resolve({ platform: { worker: { coordinator: { model: 'opus' } } }, tool: { worker: { coordinator: { model: 'garbage', effort: 'high' } } } });
    expect(result.value.worker.coordinator).toMatchObject({ model: 'opus', effort: 'high' });
    expect(result.sources['worker.coordinator.model']).toBe('platform');
    expect(result.invalid).toContain('tool.worker.coordinator.model="garbage"');
  });
  it('environment replaces an entire role rather than merging with lower leaves', () => {
    const result = resolve({ tool: { worker: { coordinator: { model: 'opus', effort: 'high' } } }, env: { WE_AI_ROUTING: JSON.stringify({ worker: { coordinator: { model: 'sonnet' } } }) } });
    expect(result.value.worker.coordinator).toMatchObject({ model: 'sonnet', effort: 'inherit' });
    expect(result.sources.worker).toBe('env');
  });
  it.each(['[]', 'null', '{broken', '1'])('invalid env object %s retains lower settings', raw => {
    const result = resolve({ env: { WE_AI_ROUTING: raw }, tool: { helper: { coordinator: { model: 'haiku' } } } });
    expect(result.value.helper.coordinator.model).toBe('haiku');
    expect(result.invalid.length).toBeGreaterThan(0);
  });
  it('unknown paths, provider, model, account and local launcher fail closed', () => {
    const result = resolve({ tool: { mystery: 1, providers: { local: true }, worker: { coordinator: { surprise: true, provider: 'unknown', model: 'absent', account: 'absent' } } } });
    expect(result.value.worker).toEqual(AI_ROUTING_STANDARD.worker);
    expect(result.value.providers.local).toBe(false);
    expect(result.value).not.toHaveProperty('mystery');
    expect(result.invalid).toHaveLength(6);
  });
  it.each(['fix', 'build', 'ci-heal', 'prepare', 'worker'])('%s requires native Claude at the end of a writing chain', role => {
    expect(resolve({ tool: { [role]: { executors: ['codex'] } } }).value[role]).toEqual(AI_ROUTING_STANDARD[role]);
    expect(resolve({ tool: { [role]: { executors: ['codex', 'claude'] } } }).value[role].executors).toEqual(['codex', 'claude']);
  });
  it('oversized or empty chains are dropped by cascade with inherit as the visible fallback', () => {
    for (const executors of [[], Array(17).fill('claude')]) {
      const result = resolve({ tool: { build: { executors } } });
      expect(result.value.build.executors).toBe('inherit');
      expect(result.invalid).toHaveLength(1);
    }
  });
  it('bad merged provider/model resets the WHOLE role and logs once', () => {
    const log = vi.fn();
    const options = { platform: { helper: { coordinator: { provider: 'codex' } } }, tool: { helper: { coordinator: { model: 'haiku', effort: 'high' } } }, log };
    expect(resolve(options).value.helper).toEqual(AI_ROUTING_STANDARD.helper);
    resolve(options);
    expect(log.mock.calls.filter(([line]) => line.includes('ai-routing-invalid'))).toHaveLength(1);
  });
  it('unsupported model/effort and account on non-Claude reset the role', () => {
    for (const coordinator of [{ provider: 'codex', model: 'gpt-6-luna', effort: 'ultra' }, { provider: 'codex', account: 'a' }])
      expect(resolve({ tool: { judge: { coordinator } } }).value.judge).toEqual(AI_ROUTING_STANDARD.judge);
  });
  it('a disabled executor profile resets the whole role', () => {
    expect(resolve({ tool: { providers: { codex: false }, build: { executors: ['codex', 'claude'] } } }).value.build).toEqual(AI_ROUTING_STANDARD.build);
  });
  it('overlays a valid role, then retains gate, availability and operator override precedence', () => {
    const routing = resolve({ tool: { build: { coordinator: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }, executors: ['codex-alt', 'claude'] } } });
    const ctx = context({ routing, routingOverrides: {} });
    expect(routeForRole('build', ctx).coordinator).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', source: 'tool' });
    expect(routeForRole('build', { ...ctx, gateClosed: true }).coordinator.provider).toBe('claude');
    expect(routeForRole('build', { ...ctx, availability: { codex: 'quota hold' } }).coordinator.provider).toBe('claude');
    expect(routeForRole('build', { ...ctx, routingOverrides: { build: { provider: 'claude', model: 'opus' } } }).coordinator.model).toBe('claude-opus-5-5');
    expect(() => routeForRole('build', { ...ctx, availability: { codex: 'held', claude: 'held' } })).toThrow(/no available route/);
  });
  it('rejects unmapped enforced accounts and unknown roles', () => {
    expect(() => routeForRole('worker', context({ env: { XPC_SERVICE_NAME: 'com.we.other' }, accountMap: { enforce: true, '*': 'refuse' } }))).toThrow(/account refuses/);
    expect(() => routeForRole('missing', context())).toThrow(/unknown role/);
  });
  it('an existing routing policy operator override remains unchanged under inherit', () => {
    const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { build: { provider: 'claude', model: 'opus' } });
    expect(routeForRole('build', context({ policy })).coordinator).toMatchObject(resolveOperationRoute({ operation: 'build', policy }));
  });
});

it('the declared show operation returns routes and sources and formats refusals without launching', async () => {
  const routes = AI_ROUTING_ROLES.map(role => routeForRole(role, context()));
  const declaration = aiRoutingOperation({ collect: () => ({ routes, sources: resolve().sources }) });
  const registry = createRegistry();
  registry.register(declaration);
  const result = await runOperationCli({ declaration, registry, argv: [], store: createMemoryRunStore(), newRunId: () => 'ai-routing-test' });
  expect(result.code).toBe(0);
  expect(result.run.verdict.routes).toEqual(routes);
  expect(finishAiRouting({ ...result, json: false }).lines.join('\n')).toContain('executors:');
  expect(finishAiRouting({ run: { verdict: { routes: [{ role: 'build', error: 'no route' }] } }, code: 0, json: false }).lines).toEqual(['build: refused: no route']);
});
