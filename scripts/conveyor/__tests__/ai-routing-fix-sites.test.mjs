import { describe, expect, it } from 'vitest';
import { loadFixerLadder } from '../fixer-ladder.mjs';
import { routeFixExecutor } from '../reconcile-fix-dispatch.mjs';
import { resolveFixChainInput } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
import { resolveAiRouting } from '../../lib/ai-routing.mjs';
import { resolveFixExecutorChain } from '../../lib/fix-executor-chain.mjs';
import { DEFAULT_ROUTING_POLICY } from '../../lib/dispatch-routing-policy.mjs';

const resolved = tool => resolveAiRouting({ tool, platform: {}, env: {}, accountMap: { accounts: {} }, log: false });
const ladder = options => loadFixerLadder({ override: undefined, routingPolicy: DEFAULT_ROUTING_POLICY, ...options });
const chain = options => resolveFixExecutorChain({ env: {}, platform: {}, repo: { routing: { builder: 'codex' } }, ...options });

describe('daemon site: reconcile-fix-dispatch-daemon chain input', () => {
  it('no aiRouting setting gives no chain input', () => {
    expect(resolveFixChainInput({ resolve: () => resolved({}) })).toBeUndefined();
  });
  it('a configured fix.executors chain is passed as the chain input', () => {
    expect(resolveFixChainInput({ resolve: () => resolved({ fix: { executors: ['codex-alt', 'claude'] } }) })).toEqual(['codex-alt', 'claude']);
  });
  it('a customised executor profile holds the chain at Claude', () => {
    const logs = [];
    const tool = { executorProfiles: { 'codex-alt': { provider: 'claude', model: 'sonnet', effort: 'high' } }, fix: { executors: ['codex-alt', 'claude'] } };
    expect(resolveFixChainInput({ resolve: () => resolved(tool), log: m => logs.push(m) })).toEqual(['claude']);
    expect(logs.join()).toMatch(/customised/);
  });
  it('an unreadable or throwing resolver fails closed to no input', () => {
    expect(resolveFixChainInput({ resolve: () => { throw new Error('boom'); } })).toBeUndefined();
  });
});

describe('fixer-ladder site: optional aiRouting input', () => {
  const rungs = value => JSON.parse(JSON.stringify(value.routes));
  it('without aiRouting the routes are unchanged', () => {
    expect(rungs(ladder({ aiRouting: undefined, operatorKeys: [] }))).toEqual(rungs(ladder()));
  });
  it('aiRouting raises the effort where the policy entry allows it', () => {
    const base = rungs(ladder());
    const routed = rungs(ladder({ aiRouting: { effort: 'xhigh' }, operatorKeys: [] }));
    const dispatching = Object.keys(base).filter(id => base[id]);
    expect(dispatching.length).toBeGreaterThan(0);
    expect(dispatching.some(id => routed[id].effort === 'xhigh')).toBe(true);
    for (const id of dispatching) expect(routed[id]).toMatchObject({ provider: base[id].provider, model: base[id].model });
  });
  it('aiRouting never downgrades an escalation rung (lower effort or another model)', () => {
    const base = rungs(ladder());
    expect(rungs(ladder({ aiRouting: { effort: 'low' }, operatorKeys: [] }))).toEqual(base);
    expect(rungs(ladder({ aiRouting: { provider: 'claude', model: 'haiku', effort: 'high' }, operatorKeys: [] }))).toEqual(base);
  });
  it('an operator override on the fix operation wins over aiRouting', () => {
    expect(rungs(ladder({ aiRouting: { effort: 'xhigh' }, operatorKeys: ['fix'] }))).toEqual(rungs(ladder()));
  });
  it('aiRouting without operatorKeys throws instead of guessing', () => {
    expect(() => ladder({ aiRouting: { effort: 'high' } })).toThrow(/operatorKeys/);
  });
});

describe('critical decision and builder strip at the routing site', () => {
  const planned = { kind: 'fix', takeover: true, scope: [] };
  it('a critical takeover stays on Claude whatever the aiRouting chain says', () => {
    const picked = routeFixExecutor(planned, { setting: { value: 'codex-first', source: 'default' },
      chain: chain({ aiRouting: ['codex', 'claude'] }), fixSettings: { strongerModelFromRound: 3 },
      launcherAvailable: () => true, readRouted: () => [], criticalFor: () => true });
    expect(picked).toMatchObject({ executor: 'claude' });
  });
  it('the builder strip survives an aiRouting chain', () => {
    const stripped = chain({ aiRouting: ['codex', 'claude'], repo: { routing: { builder: 'claude' } } });
    expect(stripped.value).toEqual(['claude']);
  });
  it('without aiRouting a routed fix is unchanged', () => {
    const options = { setting: { value: 'codex-first', source: 'default' }, fixSettings: { strongerModelFromRound: 3 },
      launcherAvailable: () => true, readRouted: () => [], criticalFor: () => false };
    expect(routeFixExecutor({ kind: 'fix', scope: [] }, { ...options, chain: chain({ aiRouting: undefined }) }))
      .toEqual(routeFixExecutor({ kind: 'fix', scope: [] }, { ...options, chain: chain() }));
  });
});
