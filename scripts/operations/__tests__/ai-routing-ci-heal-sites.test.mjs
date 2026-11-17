import { describe, expect, it, vi } from 'vitest';
import { resolveStrongerCiHealRoute } from '../ci-heal-pr-dispatch.mjs';
import { parseArgs } from '../probation-heal-run.mjs';
import { aiRoutingInputs, resolveAiRouting } from '../../lib/ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY, resolveOperationRoute } from '../../lib/dispatch-routing-policy.mjs';

const resolved = tool => resolveAiRouting({ tool, platform: {}, env: {}, accountMap: { accounts: {} }, log: false });
const policy = structuredClone(DEFAULT_ROUTING_POLICY);
policy.operations['ci-heal'] = {
  provider: 'codex', model: 'default', effort: 'high',
  fallback: [{ provider: 'claude', model: 'sonnet', effort: 'high' }],
};
const readPolicy = Object.assign(() => policy, { operatorKeys: () => [] });
const argv = ['--pr=1', '--session=ci-heal-test'];
const sites = [
  {
    name: 'probation heal',
    run: options => parseArgs(argv, options),
    base: { operation: 'ci-heal', taskType: 'ci-heal', policy, gateClosed: false, available: ['codex', 'antigravity'] },
    coordinator: { provider: 'codex', model: 'sol', effort: 'medium' },
  },
  {
    name: 'stronger heal policy fallback',
    run: options => resolveStrongerCiHealRoute({ loadLadder: () => null, ...options }),
    base: { operation: 'ci-heal', policy, gateClosed: true, available: ['claude'] },
    coordinator: { provider: 'claude', model: 'opus', effort: 'max' },
  },
];

describe.each(sites)('$name: optional ci-heal aiRouting input', site => {
  const run = options => site.run({ readPolicy, log: vi.fn(), resolveRoute: resolveOperationRoute, ...options });

  it.each([{}, { 'ci-heal': { coordinator: { provider: 'inherit', model: 'inherit', effort: 'inherit' }, executors: 'inherit' } }])(
    'empty or inherit setting preserves exactly the existing route (%j)', tool => {
      const resolveRoute = vi.fn(resolveOperationRoute);
      const actual = run({ resolveRouting: () => resolved(tool), resolveRoute });
      const today = run({ resolveRouting: () => resolved({}), resolveRoute: options => {
        expect(options).toEqual(site.base);
        return resolveOperationRoute(site.base);
      } });
      expect(actual).toEqual(today);
      expect(resolveRoute.mock.calls).toEqual([[site.base]]);
    },
  );

  it('passes a configured coordinator through the existing operation resolver', () => {
    const resolveRoute = vi.fn(resolveOperationRoute);
    const resolveRouting = vi.fn(() => resolved({ 'ci-heal': { coordinator: site.coordinator } }));
    const log = vi.fn();
    const actual = run({ resolveRouting, resolveRoute, log });
    const expected = resolveOperationRoute({ ...site.base, aiRouting: site.coordinator, operatorKeys: [] });
    expect(resolveRouting).toHaveBeenCalledWith({ log });
    expect(resolveRoute.mock.calls).toEqual([[{ ...site.base, aiRouting: site.coordinator, operatorKeys: [] }]]);
    expect(site.name === 'probation heal' ? actual.worker : actual.policyRoute)
      .toMatchObject({ provider: expected.provider, model: expected.model, effort: expected.effort });
  });

  it('retains operator overrides above the configured coordinator', () => {
    const operatorReader = Object.assign(() => policy, { operatorKeys: () => ['ci-heal'] });
    expect(run({ readPolicy: operatorReader, resolveRouting: () => resolved({ 'ci-heal': { coordinator: site.coordinator } }) }))
      .toEqual(run({ resolveRouting: () => resolved({}) }));
  });

  it('logs aiRouting resolution failure and falls back to exactly the existing route', () => {
    const log = vi.fn();
    const resolveRoute = vi.fn(resolveOperationRoute);
    expect(run({ log, resolveRoute, resolveRouting: () => { throw new Error('unreadable routing'); } }))
      .toEqual(run({ resolveRouting: () => resolved({}) }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('using existing route: unreadable routing'));
    expect(resolveRoute.mock.calls).toEqual([[site.base]]);
  });

  it('logs an unusable overlay and retries the existing operation route', () => {
    const log = vi.fn();
    const resolveRoute = vi.fn(resolveOperationRoute);
    const noProvenance = () => policy;
    expect(run({ readPolicy: noProvenance, log, resolveRoute,
      resolveRouting: () => resolved({ 'ci-heal': { coordinator: site.coordinator } }) }))
      .toEqual(run({ resolveRouting: () => resolved({}) }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('operatorKeys'));
    expect(resolveRoute).toHaveBeenCalledTimes(2);
    expect(resolveRoute).toHaveBeenLastCalledWith(site.base);
  });
});

describe('ci-heal writer safeguards', () => {
  it('accepts a code-writing chain ending with Claude and rejects one ending with Codex', () => {
    expect(aiRoutingInputs('ci-heal', resolved({ 'ci-heal': { executors: ['codex', 'claude'] } })).executors)
      .toEqual(['codex', 'claude']);
    expect(aiRoutingInputs('ci-heal', resolved({ 'ci-heal': { executors: ['claude', 'codex'] } })).executors)
      .toBeUndefined();
  });

  it('the stronger route keeps the critical gate and selects the Claude fallback', () => {
    const resolveRoute = vi.fn(resolveOperationRoute);
    const result = resolveStrongerCiHealRoute({ loadLadder: () => null, readPolicy, resolveRoute,
      resolveRouting: () => resolved({ 'ci-heal': { coordinator: { provider: 'codex', model: 'sol', effort: 'high' } } }) });
    expect(result.policyRoute.provider).toBe('claude');
    expect(resolveRoute.mock.calls[0][0]).toMatchObject({ gateClosed: true, available: ['claude'] });
  });

  it('the stronger route refuses a non-Claude result even if its resolver returns one', () => {
    expect(() => resolveStrongerCiHealRoute({ loadLadder: () => null, readPolicy,
      resolveRouting: () => resolved({ 'ci-heal': { coordinator: { effort: 'high' } } }),
      resolveRoute: () => ({ provider: 'codex', model: 'gpt-6-astra', effort: 'high' }),
    })).toThrow('CI-heal stronger-model route did not resolve to Claude');
  });

  it('keeps explicit probation workers unchanged without reading aiRouting', () => {
    const resolveRouting = vi.fn(() => { throw new Error('must not read'); });
    const worker = { id: 'codex', provider: 'codex', model: 'default', effort: 'high' };
    expect(parseArgs([...argv, `--worker=${JSON.stringify(worker)}`], { readPolicy, resolveRouting }).worker)
      .toMatchObject({ ...worker, model: policy.aliases.codex.default });
    expect(resolveRouting).not.toHaveBeenCalled();
  });
});
