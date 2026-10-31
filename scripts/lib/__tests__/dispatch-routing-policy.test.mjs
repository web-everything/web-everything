import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import matter from 'gray-matter';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateRoutingPolicy, resolveOperationRoute, applyRoutingOverrides, DEFAULT_ROUTING_POLICY } from '../dispatch-routing-policy.mjs';
import { OPERATION_PROVIDER_ROSTERS } from '../dispatch-routing-providers.mjs';
import { readRoutingPolicy, createRoutingPolicyReader } from '../dispatch-routing-policy-io.mjs';
import { decideDispatchRoute } from '../dispatch-contracts.mjs';
import { routeDispatchProvider } from '../../operations/dispatch-lane-io.mjs';
import { resolveCodexTaskRoute } from '../codex-task-route.mjs';
import { readSettings } from '../settings-files.mjs';

const copy = () => structuredClone(readRoutingPolicy());
// Exercise an explicit launch override without replacing the default evidence/tier repair router.
// The Codex retry rungs come from settings, not a duplicated policy fallback.
const repairLaunchRoute = (kind, vetoes = []) => {
  const policy = copy();
  policy.operations[kind] = { provider: 'codex', model: 'sol', effort: 'high',
    fallback: [{ provider: 'claude', model: 'sonnet', effort: 'high' }] };
  return resolveOperationRoute({ operation: kind, policy, vetoes });
};
describe('operation routing policy', () => {
  it('shares the red-team launch roster with existing review-seat consumers', async () => {
    const { REVIEW_SEAT_PROVIDERS } = await import('../provider-routing.mjs');
    expect(OPERATION_PROVIDER_ROSTERS['review-seat:red-team']).toBe(REVIEW_SEAT_PROVIDERS);
    expect(REVIEW_SEAT_PROVIDERS).toEqual(['codex', 'agy-claude', 'agy-gemini']);
  });
  it.each(['claude', 'antigravity', 'unknown-provider'])(
    'rejects unsupported red-team provider %s in policy and override validation', provider => {
      const policy = structuredClone(DEFAULT_ROUTING_POLICY);
      const route = { provider, model: 'sonnet', fallback: [] };
      policy.operations['review-seat:red-team'] = route;
      expect(() => validateRoutingPolicy(policy)).toThrow(/provider/);
      expect(() => applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { 'review-seat:red-team': { provider } })).toThrow(/provider/);
      policy.operations['review-seat:red-team'] = { provider: 'codex', model: 'sol', fallback: [{ provider, model: 'sonnet' }] };
      expect(() => validateRoutingPolicy(policy)).toThrow(/provider/);
    });
  it.each(['codex', 'agy-claude', 'agy-gemini'])(
    'resolves a supported red-team override for %s against the launch roster', provider => {
      const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { 'review-seat:red-team': { provider } });
      expect(resolveOperationRoute({ operation: 'review-seat', taskType: 'red-team',
        available: OPERATION_PROVIDER_ROSTERS['review-seat:red-team'], policy })).toMatchObject({ provider });
    });
  it.each(['antigravity', 'agy-gemini'])('resolves the %s Pro alias to the registered Argon high model', (provider) => {
    const policy = copy();
    policy.operations.judge = { provider, model: 'pro', effort: 'high', fallback: [] };
    expect(resolveOperationRoute({ operation: 'judge', policy })).toMatchObject({ provider, model: 'gemini-4-argon-high', effort: 'high' });
    expect(() => validateRoutingPolicy({ ...policy, aliases: { ...policy.aliases, [provider]: { ...policy.aliases[provider], pro: 'gemini-4-argon' } } })).toThrow(/unknown model/);
  });
  it('resolves aliases, ordered availability fallback, and inherited routes', () => {
    expect(resolveOperationRoute({ operation: 'prepare-item' })).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', fallback: [{ provider: 'claude', model: 'claude-sonnet-5-5' }] });
    expect(resolveOperationRoute({ operation: 'prepare-item', available: ['claude'] })).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', fallback: [] });
    expect(resolveOperationRoute({ operation: 'build' })).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
    expect(() => resolveOperationRoute({ operation: 'prepare-item', available: [] })).toThrow(/no available route/);
  });
  it.each([
    [p => { p.operations.build = { provider: 'typo', model: 'default', fallback: [] }; }, /unknown provider/],
    [p => { p.operations['prepare-item'].model = 'unknown'; }, /unknown model\/alias/],
    [p => { p.aliases.codex.default = 'not-a-model'; }, /aliases.codex.default.*unknown model/],
    [p => { p.operations['prepare-item'].fallback = {}; }, /fallback must be an array/],
    [p => { p.operations['prepare-item'].fallback = [{ provider: 'codex', model: 'sonnet' }]; }, /fallback\[0\].*unknown model/],
    [p => { p.operations.build.extra = true; }, /extra is unknown/],
    [p => { p.criticalWorkGate.kinds = 'build'; }, /kinds must contain/],
    [p => { p.criticalWorkGate.openForNonCritical.bugfix = 'yes'; }, /must contain booleans/],
  ])('rejects malformed edits with an actionable error', (edit, error) => {
    const policy = copy(); edit(policy); expect(() => validateRoutingPolicy(policy)).toThrow(error);
  });
  it('hot reloads valid edits and keeps last good through malformed, invalid, and missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-policy-'));
    const path = join(dir, 'policy.json'); const log = vi.fn();
    const read = createRoutingPolicyReader({ path, log });
    try {
      const next = copy(); next.operations['prepare-item'].model = 'gpt-6-sol';
      writeFileSync(path, JSON.stringify(next));
      expect(read().operations['prepare-item'].model).toBe('gpt-6-sol');
      for (const bad of ['{', JSON.stringify({ ...next, version: 99 })]) {
        writeFileSync(path, bad); expect(read().operations['prepare-item'].model).toBe('gpt-6-sol');
        const count = log.mock.calls.length; read(); expect(log).toHaveBeenCalledTimes(count);
      }
      rmSync(path); expect(read().operations['prepare-item'].model).toBe('gpt-6-sol');
      next.operations['prepare-item'].model = 'default'; writeFileSync(path, JSON.stringify(next));
      expect(read().operations['prepare-item'].model).toBe('default');
      expect(log.mock.calls.every(([message]) => message.includes('keeping last good policy'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('supports task types and per-seat operation keys without changing code', () => {
    const policy = copy(); policy.operations.fix = { inherit: true }; policy.taskTypes.bugfix = { provider: 'codex', model: 'gpt-6-sol', fallback: [] };
    policy.operations['review-seat:security'] = { provider: 'agy-claude', model: 'opus', fallback: [] };
    expect(resolveOperationRoute({ operation: 'fix', taskType: 'bugfix', policy })).toMatchObject({ provider: 'codex', model: 'gpt-6-sol' });
    expect(resolveOperationRoute({ operation: 'review-seat', taskType: 'security', policy })).toMatchObject({ provider: 'agy-claude', model: 'claude-opus-4-6-thinking' });
  });
  it('keeps the critical gate ahead of an explicit provider override, even if the policy omits the operation kind', () => {
    const policy = copy(); policy.operations['build:build-new-feature'] = { provider: 'codex', model: 'default', fallback: [{ provider: 'claude', model: 'opus' }] };
    const dispatch = { kind: 'build', scopePaths: ['we:scripts/lib/critical-work.mjs'], size: 1, risk: 'high' };
    expect(decideDispatchRoute(dispatch, { routingPolicy: policy }).policyRoute).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    policy.criticalWorkGate.kinds = [];
    expect(decideDispatchRoute(dispatch, { routingPolicy: policy }).policyRoute).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
  });
  it('prepare policy reaches the actual launcher and reports the selected fallback model', () => {
    const routing = decideDispatchRoute({ kind: 'prepare-item', cardPath: 'we:backlog/9001-card.md' });
    const request = { launchKind: 'prepare-item', policyRoute: routing.policyRoute, probationWorker: routing.probationWorker, reportModel: vi.fn() };
    const probation = vi.fn(() => 'pid:123'); const agent = vi.fn(() => 'claude-session');
    expect(routeDispatchProvider(request, { probationLaunch: 'on', scriptExists: () => true, probation, agent })).toBe('pid:123');
    expect(probation.mock.calls[0][0].probationWorker.model).toBe('gpt-6-astra');
    expect(request.reportModel).toHaveBeenLastCalledWith('gpt-6-astra');
    expect(routeDispatchProvider(request, { probationLaunch: 'off', probation, agent })).toBe('claude-session');
    expect(agent.mock.calls[0][0].table.model).toBe('claude-sonnet-5-5');
    expect(request.reportModel).toHaveBeenLastCalledWith('claude-sonnet-5-5');
    probation.mockImplementation(() => { throw new Error('indeterminate launch'); });
    expect(() => routeDispatchProvider(request, { probationLaunch: 'on', scriptExists: () => true, probation, agent })).toThrow('indeterminate launch');
    expect(agent).toHaveBeenCalledTimes(1);
  });
});


it('a child uses the inherited last-good snapshot even while the policy file is syntactically broken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-policy-child-'));
  try {
    for (const file of ['dispatch-routing-policy-source.mjs', 'codex-model-routing.mjs', 'dispatch-routing-policy.mjs', 'dispatch-routing-providers.mjs']) copyFileSync(`scripts/lib/${file}`, join(dir, file));
    writeFileSync(join(dir, 'dispatch-routing-policy.json'), '{broken edit');
    const moduleUrl = pathToFileURL(join(dir, 'dispatch-routing-policy.mjs')).href;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `import { resolveOperationRoute } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(resolveOperationRoute({operation:'prepare-item'})));`], {
      encoding: 'utf8', env: { ...process.env, WE_DISPATCH_ROUTING_SNAPSHOT: JSON.stringify(readRoutingPolicy()) },
    });
    expect(JSON.parse(result)).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('adding prepare-item to gated kinds applies the same fail-closed check to its explicit policy', () => {
  const policy = copy(); policy.criticalWorkGate.kinds.push('prepare-item');
  expect(decideDispatchRoute({ kind: 'prepare-item', risk: 'high' }, { routingPolicy: policy }).policyRoute).toMatchObject({ provider: 'claude' });
});

it('a critical-miss veto removes the exact model from the whole fallback chain', () => {
  const policy = copy(); policy.operations.fix = { provider: 'codex', model: 'default', fallback: [{ provider: 'claude', model: 'sonnet' }] };
  expect(resolveOperationRoute({ operation: 'fix', policy, vetoes: [{ provider: 'codex', model: 'gpt-6-astra' }] })).toMatchObject({ provider: 'claude' });
});


it('treats an edit to the routing policy itself as critical work', () => {
  const policy = copy(); policy.operations['build:build-new-feature'] = { provider: 'codex', model: 'default', fallback: [{ provider: 'claude', model: 'opus' }] };
  const route = decideDispatchRoute({ kind: 'build', scopePaths: ['we:scripts/lib/dispatch-routing-policy.json'], risk: 'low', size: 1 }, { routingPolicy: policy });
  expect(route.policyRoute).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
});


it('a closed gate removes external providers from all later fallback entries too', () => {
  const policy = copy(); policy.operations.build = { provider: 'codex', model: 'default', fallback: [{ provider: 'claude', model: 'sonnet' }, { provider: 'codex', model: 'sol' }] };
  expect(resolveOperationRoute({ operation: 'build', policy, gateClosed: true })).toMatchObject({ provider: 'claude', fallback: [] });
});

describe('review-round regressions (PR 3209)', () => {
  const miss = { provider: 'codex', model: 'gpt-6-astra', taskType: 'prepare', outcome: 'reworked' };
  it('a recorded critical miss vetoes the prepare-item policy route through decideDispatchRoute', async () => {
    const { criticalMissesFor } = await import('../critical-work.mjs');
    const scorecards = [miss];
    expect(criticalMissesFor(scorecards, 'prepare')).toHaveLength(1);
    const route = decideDispatchRoute({ kind: 'prepare-item' }, { scorecards });
    expect(route.policyRoute).toMatchObject({ provider: 'claude' });
    expect(route.probationWorker ?? null).toBeNull();
  });
  it('Claude policy ids spawn as tier aliases, never pinned ids', async () => {
    const { claudeSpawnAlias } = await import('../dispatch-routing-policy.mjs');
    expect(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].map(claudeSpawnAlias)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(claudeSpawnAlias('gpt-6-astra')).toBe('gpt-6-astra');
  });
  it('an env snapshot cannot loosen the critical-work gate', async () => {
    const { trustedSnapshot } = await import('../dispatch-routing-policy-source.mjs');
    const loose = copy(); loose.criticalWorkGate.kinds = [];
    expect(trustedSnapshot(JSON.stringify(loose))).toBeNull();
    expect(trustedSnapshot(JSON.stringify(copy()))).not.toBeNull();
  });
  it('an explicit Codex build route stays on the mechanical wrapper when probation launch is off', () => {
    const policy = copy(); policy.operations.build = { provider: 'codex', model: 'default', fallback: [] };
    const routing = decideDispatchRoute({ kind: 'build', scopePaths: ['we:docs/a.md'], size: 1, risk: 'low' }, { routingPolicy: policy });
    const request = { launchKind: 'build', policyRoute: routing.policyRoute, probationWorker: routing.probationWorker, reportModel: vi.fn() };
    const wrapper = vi.fn(() => 'pid:9'); const agent = vi.fn(() => 'claude-session');
    const registry = { build: { runScript: 'x', provider: wrapper } };
    expect(routeDispatchProvider(request, { probationLaunch: 'off', registry, scriptExists: () => true, providerAvailable: () => true, agent })).toBe('pid:9');
    expect(agent).not.toHaveBeenCalled();
  });
});

it('adapts effort and provider to bounded prepares, design and mechanical work', () => {
  expect(resolveOperationRoute({ operation: 'prepare-item', size: 3, wellScoped: true, designQuestion: false })).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', effort: 'low' });
  for (const context of [{ size: 5 }, { size: 2, designQuestion: true }, {}]) {
    expect(resolveOperationRoute({ operation: 'prepare-item', ...context })).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
  }
  expect(resolveOperationRoute({ operation: 'prepare-item', size: 5 }).effort).toBe('high');
  expect(resolveOperationRoute({ operation: 'build', taskType: 'doc-fix' }).effort).toBe('medium');
  expect(resolveOperationRoute({ operation: 'build', taskType: 'test-fix' })).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
  expect(resolveOperationRoute({ operation: 'ci-heal' })).toBeNull();
  expect(resolveOperationRoute({ operation: 'fix' })).toBeNull();
});

it.each(['codex', 'claude', 'antigravity', 'agy-claude', 'agy-gemini'])('rejects unknown %s effort and retains the last good edit', provider => {
  const good = copy(); let contents = JSON.stringify(good); const log = vi.fn();
  const reader = createRoutingPolicyReader({ read: () => contents, log });
  const before = reader();
  good.operations.fix.effort[provider] = 'impossible'; contents = JSON.stringify(good);
  expect(() => validateRoutingPolicy(good)).toThrow(/unknown effort "impossible"/);
  expect(reader()).toBe(before);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('keeping last good policy'));
});

it('accepts every shared Codex effort key and rejects a non-Codex ultra effort', async () => {
  const { CODEX_EFFORT_MAP } = await import('../codex-model-routing.mjs');
  for (const effort of Object.keys(CODEX_EFFORT_MAP)) {
    const policy = copy(); policy.operations.build.effort.codex = effort;
    expect(resolveOperationRoute({ operation: 'build', policy: validateRoutingPolicy(policy) }).effort).toBe(effort);
  }
  const policy = copy(); policy.operations.build.effort.claude = 'ultra';
  expect(() => validateRoutingPolicy(policy)).toThrow(/unknown effort "ultra" for claude/);
});

it('accepts and reports a reasoned explicit model pin through the selected native fallback', async () => {
  const { defaultClaudeProvider } = await import('../../operations/dispatch-lane-io.mjs');
  const routing = decideDispatchRoute({ kind: 'prepare-item', cardPath: 'we:backlog/9001-card.md' });
  for (const pin of ['claude-custom-explicit-pin', 'opus']) {
    const spawnAgent = vi.fn(() => 'backgrounded · abc12345');
    const reportModel = vi.fn();
    const probation = vi.fn(() => { throw new Error('must honor the native model pin'); });
    routeDispatchProvider({ launchKind: 'prepare-item', prompt: 'prepare',
      policyRoute: routing.policyRoute, probationWorker: routing.probationWorker,
      extraArgs: ['--model', pin], modelReason: 'operator selected this model for this run', reportModel,
    }, { probationLaunch: 'on', scriptExists: () => true, probation,
      agent: request => defaultClaudeProvider(request, { spawnAgent }) });
    expect(spawnAgent.mock.calls[0][0]).toEqual(expect.arrayContaining(['--model', pin]));
    expect(reportModel).toHaveBeenLastCalledWith(pin === 'opus' ? 'claude-opus-5-5' : pin);
    expect(probation).not.toHaveBeenCalled();
  }
});

it.each(['fix', 'ci-heal'])('%s retains inherited repair routing despite a global task-type policy', kind => {
  const policy = copy();
  const dispatch = { kind, scopePaths: ['we:scripts/example.mjs'], risk: 'low', size: 2 };
  const inherited = decideDispatchRoute(dispatch, { routingPolicy: { ...policy, taskTypes: {} } });
  const routed = decideDispatchRoute(dispatch, { routingPolicy: policy });
  expect(routed).toEqual(inherited);
  expect(routed.policyRoute).toBeUndefined();
  expect(routed.probationWorker).toMatchObject({ taskType: kind === 'fix' ? 'bugfix' : kind });
  expect(resolveOperationRoute({ operation: kind, taskType: 'bugfix' })).toBeNull();
  expect(policy.operations[kind]).toMatchObject({ inherit: true });
  expect(policy.taskTypes.bugfix).toMatchObject({ inherit: true });
  expect(Object.values(policy.operations[kind].effort)).toEqual(['high', 'high', 'high', 'high', 'high']);
  expect(Object.values(policy.taskTypes.bugfix.effort)).toEqual(['high', 'high', 'high', 'high', 'high']);
});

it.each(['fix', 'ci-heal'])('%s retries Astra high before Claude only on definite pre-launch refusal', kind => {
  const route = repairLaunchRoute(kind);
  const taskRoute = resolveCodexTaskRoute({ kind, tool: readSettings().codex.modelByTask, platform: {}, env: {}, log: false });
  expect(taskRoute.sources).toMatchObject({ model: 'tool', effort: 'tool', retry: 'tool' });
  expect([{ provider: 'codex', model: taskRoute.model, effort: taskRoute.effort },
    ...taskRoute.retry.map(rung => ({ provider: 'codex', ...rung })), ...route.fallback]).toEqual([
    { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    { provider: 'codex', model: 'gpt-6-astra', effort: 'high' },
    { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
  ]);
  const seen = [];
  const wrapper = request => { seen.push(request.policyRoute.model); throw Object.assign(new Error('not started'), { notApplied: true }); };
  const agent = request => { seen.push(request.table.model); return 'session'; };
  expect(routeDispatchProvider({ launchKind: kind, policyRoute: route }, {
    registry: { [kind]: { runScript: 'wrapper.mjs', provider: wrapper } }, scriptExists: () => true, agent,
  })).toBe('session');
  expect(seen).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'claude-sonnet-5-5']);
  seen.length = 0;
  expect(() => routeDispatchProvider({ launchKind: kind, policyRoute: route }, {
    registry: { [kind]: { runScript: 'wrapper.mjs', provider: () => { throw new Error('indeterminate'); } } }, scriptExists: () => true, agent,
  })).toThrow('indeterminate');
  expect(seen).toEqual([]);
});

it('routes all mechanical documentation and filing entries at medium effort', () => {
  const policy = copy();
  for (const entry of [policy.operations.build, policy.operations['build:doc-fix'], ...['doc-fix', 'prevention-card', 'prepare-card'].flatMap(k => [policy.operations[k], policy.taskTypes[k]])]) {
    expect(entry.provider).toBe('codex'); expect(entry.model).toBe('sol');
    expect(entry.effort.codex).toBe('medium');
  }
  for (const entry of ['prevention-card', 'prepare-card'].flatMap(k => [policy.operations[k], policy.taskTypes[k]])) {
    expect(Object.values(entry.effort).every(e => e === 'medium')).toBe(true);
    expect(entry.fallback).toEqual([{ provider: 'claude', model: 'sonnet', effort: 'medium' }]);
  }
  expect(policy.aliases.codex.sol).toBe('gpt-6.1-sol');
});

it('preserves Claude build and documentation effort and fallback', () => {
  const policy = copy();
  expect(policy.operations.build.effort.claude).toBe('high');
  expect(policy.operations.build.fallback).toEqual([{ provider: 'claude', model: 'sonnet', effort: 'high' }]);
  for (const entry of [policy.operations['build:doc-fix'], policy.operations['doc-fix'], policy.taskTypes['doc-fix']]) {
    expect(entry.effort.claude).toBe('low');
    expect(entry.fallback).toEqual([{ provider: 'claude', model: 'sonnet', effort: 'low' }]);
  }
  expect(resolveOperationRoute({ operation: 'build', available: ['claude'] }).effort).toBe('high');
  expect(resolveOperationRoute({ operation: 'build', taskType: 'doc-fix', available: ['claude'] }).effort).toBe('low');
});

it('inherits feature probation by default and preserves explicit operator pins and fallback', () => {
  const policy = copy();
  expect(policy.taskTypes['build-new-feature']).toEqual({ inherit: true });
  expect(policy.operations['build:build-new-feature']).toEqual({ inherit: true });
  expect(resolveOperationRoute({ operation: 'build', taskType: 'build-new-feature', policy })).toBeNull();
  expect(resolveOperationRoute({ operation: 'build', taskType: 'build-new-feature', gateClosed: true, policy })).toMatchObject({
    provider: 'claude', model: 'claude-sonnet-5-5', fallback: [],
  });
  expect(() => resolveOperationRoute({ operation: 'build', taskType: 'build-new-feature', gateClosed: true, availability: { claude: 'held' }, policy })).toThrow(/no available route/);
  policy.taskTypes['build-new-feature'] = {
    provider: 'codex', model: 'sol',
    effort: { claude: 'medium', codex: 'medium', antigravity: 'medium', 'agy-claude': 'medium', 'agy-gemini': 'medium' },
    fallback: [{ provider: 'claude', model: 'sonnet', effort: 'medium' }],
  };
  expect(policy.taskTypes['build-new-feature']).toMatchObject({
    provider: policy.operations.build.provider, model: policy.operations.build.model,
    effort: { codex: policy.operations.build.effort.codex },
  });
  const buildRoute = resolveOperationRoute({ operation: 'build', policy });
  policy.operations.build = { inherit: true };
  expect(resolveOperationRoute({ operation: 'build', taskType: 'build-new-feature', policy })).toMatchObject({
    provider: buildRoute.provider, model: buildRoute.model, effort: buildRoute.effort, source: buildRoute.source,
    fallback: [{ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }],
  });
  expect(resolveOperationRoute({ operation: 'build', taskType: 'build-new-feature', available: ['claude'], policy })).toMatchObject({
    provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', fallback: [],
  });
});

it('routes only card 5209 to Codex through its per-card override', () => {
  const { data: card } = matter(readFileSync(join(dirname(fileURLToPath(import.meta.url)),
    '../../../backlog/5209-prevention-delete-the-receipt-after-a-successful-apply-or-re.md'), 'utf8'));
  expect(card.deliveryAgent).toBe('codex');
  const route = decideDispatchRoute({ kind: 'build', size: card.size, scopePaths: card.scope,
    deliveryAgent: card.deliveryAgent, deliveryAgentReason: card.deliveryAgentReason,
  }, { routingPolicy: copy(), scorecards: [] });
  expect(route).toMatchObject({ outcome: 'routed', taskType: 'build-new-feature', executed: 'codex',
    override: { requestedVendor: 'codex' }, probationWorker: null });
  expect(route.policyRoute).toBeUndefined();
});

it('preserves operator-protected Astra and ruling escalation routes', () => {
  const policy = copy();
  for (const k of ['prepare', 'prepare-decision', 'prepare-item', 'investigate']) expect(policy.operations[k].model).toBe('astra');
  for (const k of ['design', 'diagnosis']) expect(policy.taskTypes[k].model).toBe('astra');
  expect(policy.operations['fix:ruling-escalation-stronger']).toMatchObject({ provider: 'claude', model: 'sonnet', fallback: [] });
  expect(policy.operations['fix:ruling-escalation-cross-provider']).toMatchObject({ provider: 'codex', model: 'astra', fallback: [{ provider: 'claude', model: 'sonnet', effort: 'high' }] });
});

it('honours a configured retry array at the real launch boundary', async () => {
  const { resolveCodexTaskRoute } = await import('../codex-task-route.mjs');
  const route = repairLaunchRoute('fix');
  for (const retry of [[], [{ model: 'gpt-6-luna', effort: 'max' }]]) {
    const models = [];
    const wrapper = r => { models.push(r.policyRoute.model); throw Object.assign(new Error('not started'), { notApplied: true }); };
    routeDispatchProvider({ launchKind: 'fix', policyRoute: route }, {
      registry: { fix: { runScript: 'wrapper.mjs', provider: wrapper } }, scriptExists: () => true,
      agent: r => { models.push(r.table.model); return 'session'; },
      resolveCodexRoute: opts => resolveCodexTaskRoute({ ...opts, tool: {}, platform: {}, env: { WE_CODEX_MODEL_BY_TASK: JSON.stringify({ fix: { retry } }) }, log: false }),
    });
    expect(models).toEqual(['gpt-6.1-sol', ...retry.map(r => r.model), 'claude-sonnet-5-5']);
  }
});

it('does not resurrect a vetoed Codex retry model at launch', () => {
  const route = repairLaunchRoute('fix', [{ provider: 'codex', model: 'gpt-6-astra' }]);
  const models = [];
  routeDispatchProvider({ launchKind: 'fix', policyRoute: route }, {
    registry: { fix: { runScript: 'wrapper.mjs', provider: r => { models.push(r.policyRoute.model); throw Object.assign(new Error('not started'), { notApplied: true }); } } },
    scriptExists: () => true, agent: r => { models.push(r.table.model); return 'session'; },
  });
  expect(models).toEqual(['gpt-6.1-sol', 'claude-sonnet-5-5']);
});
