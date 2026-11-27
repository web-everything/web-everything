import { expect, it, vi } from 'vitest';
import * as routing from '../../lib/ai-routing.mjs';
import { finishAiRouting } from '../ai-routing.mjs';
import { OPERATIONS } from '../run.mjs';

it('ai-routing prints settings, each role input, sources and invalid diagnostics', () => {
  const verdict = { settings: { fix: { executors: ['claude'] } },
    inputs: { fix: { executors: ['claude'] } }, sources: { 'fix.executors': 'platform' }, invalid: ['tool.fix: invalid'] };
  expect(finishAiRouting({ run: { verdict }, code: 0, lines: ['original'], json: false })).toEqual({ code: 0, lines: [
    'settings: {"fix":{"executors":["claude"]}}',
    'fix: {"executors":["claude"]}',
    'sources: {"fix.executors":"platform"}',
    'invalid: ["tool.fix: invalid"]',
  ] });
  expect(finishAiRouting({ run: { verdict }, code: 1, lines: ['json payload'], json: true }))
    .toEqual({ code: 1, lines: ['json payload'] });
  expect(finishAiRouting({ run: {}, code: 1, lines: ['failure'], json: false }))
    .toEqual({ code: 1, lines: ['failure'] });
});

it('registered ai-routing collector returns all ten roles, settings, sources and invalid', () => {
  const resolved = routing.resolveAiRouting({ env: {}, platform: {}, log: false, accountMap: { accounts: {} },
    tool: { fix: { executors: ['claude'] }, build: { coordinator: { provider: 'invalid' } } } });
  const read = vi.spyOn(routing, 'resolveAiRouting').mockReturnValue(resolved);
  try {
    const operation = OPERATIONS['ai-routing']();
    expect(operation.finish).toBe(finishAiRouting);
    expect(operation.sinks).toEqual({});
    const payload = operation.declaration.steps.find(({ name }) => name === 'read').step.fn();
    expect(read).toHaveBeenCalledOnce();
    expect(payload).toEqual({ settings: resolved.value, sources: resolved.sources, invalid: resolved.invalid,
      inputs: Object.fromEntries(['review', 'red-team', 'red-team-recheck', 'fix', 'build', 'prepare', 'ci-heal', 'worker', 'judge', 'helper']
        .map(role => [role, role === 'fix' ? { coordinator: undefined, executors: ['claude'] }
          : { coordinator: undefined, executors: undefined }])) });
    expect(payload.invalid.length).toBeGreaterThan(0);
    expect(operation.finish({ run: { verdict: payload }, code: 0, json: false }).lines).toHaveLength(13);
  } finally {
    read.mockRestore();
  }
});

const sessionFixture = extra => ({ env: {}, platform: {}, tool: {}, accountMap: { accounts: {} },
  log: false, operatorOverride: {}, session: true, routing: { providerOrder: ['codex', 'claude'] }, routingPlatform: {}, ...extra });

it('session construction refuses fix coordinator overrides rejected by the account-only validator', () => {
  for (const resume of [{}, { fix: { provider: 'claude', model: 'sonnet', effort: 'high' } }]) {
    const resolved = routing.resolveAiRouting(sessionFixture({ resume }));
    expect(() => routing.aiRoutingInputs('fix', resolved)).toThrow(/missing route/);
    expect(resolved.invalid).toContainEqual(expect.stringMatching(/fix:.*account-only/));
  }
});

it('resumed coordinators refuse invalid fields and inherited effort with recovery diagnostics', () => {
  const route = { provider: 'claude', model: 'sonnet', effort: 'high' };
  for (const patch of [{ account: 'unknown' }, { extra: true }, { effort: null }, { effort: 'inherit' }]) {
    const resolved = routing.resolveAiRouting(sessionFixture({ resume: { helper: { ...route, ...patch } } }));
    expect(() => routing.aiRoutingInputs('helper', resolved)).toThrow(/missing route/);
    expect(resolved.invalid).toContainEqual(expect.stringMatching(/helper:.*resume.*restore/));
  }
});

it('session combination validation includes legacy accounts before admitting a route', () => {
  const accountMap = { accounts: { team: {} } };
  const tool = { helper: { coordinator: { account: 'team' } } };
  const resolved = routing.resolveAiRouting(sessionFixture({ accountMap, tool }));
  expect(() => routing.aiRoutingInputs('helper', resolved)).toThrow(/missing route/);
  expect(resolved.invalid).toContainEqual(expect.stringMatching(/helper:.*account requires native Claude/));
  const native = routing.resolveAiRouting(sessionFixture({ accountMap, tool, routing: { providerOrder: ['claude'] } }));
  expect(routing.aiRoutingInputs('helper', native).coordinator.provider).toBe('claude');
  expect(native.value.helper.coordinator.account).toBe('team');
});

it('malformed routing blocks refuse instead of silently selecting the default provider order', () => {
  for (const options of [{ routing: 42 }, { routing: [] }, { routingPlatform: 42 }]) {
    const resolved = routing.resolveAiRouting(sessionFixture(options));
    expect(() => routing.aiRoutingInputs('helper', resolved)).toThrow(/missing route/);
    expect(resolved.invalid).toContainEqual(expect.stringMatching(/routing.*invalid.*restore/));
  }
});

it('every routine session resolves an explicit model from one providerOrder policy', () => {
  for (const order of [['codex', 'claude'], ['claude', 'codex']]) {
    const resolved = routing.resolveAiRouting(sessionFixture({ routing: { providerOrder: order } }));
    for (const role of routing.AI_ROUTING_ROLES) {
      expect(routing.aiRoutingInputs(role, resolved).coordinator).toMatchObject({
        provider: order[0], model: expect.stringMatching(/^(gpt-|claude-)/),
      });
    }
  }
});

it('missing session routes refuse with an operator recovery diagnostic instead of inheriting', () => {
  const resolved = routing.resolveAiRouting(sessionFixture({ available: [] }));
  expect(resolved.invalid).toContainEqual(expect.stringMatching(/missing route.*restore.*providerOrder/));
  expect(() => routing.aiRoutingInputs('helper', resolved)).toThrow(/missing route/);
});

it('migrates explicit old overrides ahead of provider order and preserves resumed identity', () => {
  const legacy = { helper: { coordinator: { provider: 'claude', model: 'sonnet' } } };
  const resolved = routing.resolveAiRouting(sessionFixture({ tool: legacy }));
  expect(routing.aiRoutingInputs('helper', resolved).coordinator).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5' });
  const resume = { helper: { provider: 'codex', model: 'gpt-6-sol', effort: 'high' } };
  const resumed = routing.resolveAiRouting(sessionFixture({ resume, routing: { providerOrder: ['claude'] } }));
  expect(routing.aiRoutingInputs('helper', resumed).coordinator).toEqual(resume.helper);
});

it('excludes small models from security roles even in legacy overrides', () => {
  for (const role of ['review', 'red-team', 'red-team-recheck', 'judge']) {
    const resolved = routing.resolveAiRouting(sessionFixture({ tool: { [role]: { coordinator: { provider: 'codex', model: 'luna' } } } }));
    expect(resolved.invalid).toContainEqual(expect.stringMatching(/security floor/));
    expect(() => routing.aiRoutingInputs(role, resolved)).toThrow(/missing route/);
  }
});

it('invalid and oversized provider orders refuse visibly with a recovery path', () => {
  for (const providerOrder of [[], ['unknown'], ['codex', 'codex'], Array(1000).fill('codex')]) {
    const resolved = routing.resolveAiRouting(sessionFixture({ routing: { providerOrder } }));
    expect(resolved.invalid).toContainEqual(expect.stringMatching(/providerOrder.*restore/));
    expect(() => routing.aiRoutingInputs('helper', resolved)).toThrow(/missing route/);
  }
});

it('session provider order follows standard, platform, tool and environment provenance', () => {
  const cases = [
    [{ routing: {} }, 'codex', 'standard'],
    [{ routing: {}, routingPlatform: { providerOrder: ['claude'] } }, 'claude', 'platform'],
    [{ routingPlatform: { providerOrder: ['claude'] } }, 'codex', 'tool'],
    [{ env: { WE_ROUTING_PROVIDER_ORDER: '["claude"]' } }, 'claude', 'env'],
  ];
  for (const [options, provider, source] of cases) {
    const resolved = routing.resolveAiRouting(sessionFixture(options));
    expect(routing.aiRoutingInputs('helper', resolved).coordinator.provider).toBe(provider);
    expect(resolved.sources['helper.coordinator.model']).toBe(source);
  }
});

it('repeated session resolution logs only route or source changes including return to default', () => {
  const log = vi.fn();
  const resolve = extra => routing.resolveAiRouting(sessionFixture({ log, ...extra }));
  resolve({}); resolve({});
  resolve({ routing: {}, routingPlatform: { providerOrder: ['codex', 'claude'] } });
  resolve({ routing: { providerOrder: ['claude'] } });
  resolve({ routing: {} }); resolve({ routing: {} });
  const helperEvents = log.mock.calls.map(([event]) => event).filter(event => event?.key === 'helper');
  expect(helperEvents.map(event => [event.provider, event.source])).toEqual([
    ['codex', 'tool'], ['codex', 'platform'], ['claude', 'tool'], ['codex', 'standard'],
  ]);
});

it('incomplete resume identity refuses rather than borrowing a new-session model or provider', () => {
  for (const identity of [{ model: 'gpt-6-sol' }, { provider: 'codex' }, {}, { provider: 'codex', model: 'inherit' }]) {
    const resolved = routing.resolveAiRouting(sessionFixture({ resume: { helper: identity } }));
    expect(() => routing.aiRoutingInputs('helper', resolved)).toThrow(/missing route/);
    expect(resolved.invalid).toContainEqual(expect.stringMatching(/resume.*explicit/));
  }
});
