import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AiRoutingRefusal, AI_ROUTING_ROLES, AI_ROUTING_MODEL_RANKS, AI_ROUTING_EFFORT_RANKS,
  resolveLaunchSpec } from '../ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY, resolveOperationRoute, resolvePolicyModel, operationEffort } from '../dispatch-routing-policy.mjs';
import { resolveCodexTaskRoute } from '../codex-task-route.mjs';
import { resolveFixExecutorChain, pickChainRung } from '../fix-executor-chain.mjs';
import { workerTierFor, selectReviewSeatProvider } from '../provider-routing.mjs';
import { criticalWorkVerdict } from '../critical-work.mjs';

const operationFor = role => ({ review: 'review-seat', 'red-team': 'review-seat',
  'red-team-recheck': 'review-recheck', prepare: 'prepare-item', helper: 'precedent-draft' }[role] ?? role);
const pair = route => ({ provider: route.provider, model: route.model, effort: route.effort });
const setting = (role, coordinator) => ({ [role]: { coordinator } });
const policyFor = (role, provider = role === 'red-team' ? 'agy-claude' : 'claude', model = 'sonnet', effort = 'high') => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.criticalWorkGate.kinds = [];
  const task = role === 'review' ? 'mandatory:correctness' : role === 'red-team' ? 'red-team' : undefined;
  policy.operations[`${operationFor(role)}${task ? `:${task}` : ''}`] = { provider, model, effort, fallback: [] };
  return policy;
};
const context = (role = 'helper', extra = {}) => ({ env: {}, platform: undefined, tool: undefined,
  operatorKeys: [], policy: policyFor(role), log: false, filesTouched: ['blocks/example.ts'],
  ...(role === 'review' ? { taskType: 'mandatory:correctness' } : {}), ...extra });
const launch = (role, extra) => resolveLaunchSpec(role, role, context(role, extra));
const refusal = (run, code) => {
  let error;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AiRoutingRefusal);
  expect(error).toMatchObject({ name: 'AiRoutingRefusal', role: expect.any(String), siteKey: expect.any(String),
    detail: expect.any(String), ...(code ? { code } : {}) });
  expect(error.message).toContain('operator');
  return error;
};

const withToolFiles = (legacy, files, run) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-routing-sources-'));
  try {
    const dir = join(root, 'settings');
    mkdirSync(dir);
    const legacyPath = legacy === undefined ? null : join(root, 'legacy.json');
    if (legacyPath) writeFileSync(legacyPath, JSON.stringify(legacy));
    files.forEach((data, index) => writeFileSync(join(dir, `${index}.json`), JSON.stringify(data)));
    return run({ dir, legacyPath });
  } finally { rmSync(root, { recursive: true, force: true }); }
};

describe('resolveLaunchSpec registry and parity', () => {
  it.each(AI_ROUTING_ROLES)('%s preserves the existing operation resolver with absent and inherit settings', role => {
    const ctx = context(role);
    const baseline = resolveOperationRoute({ ...ctx, operation: operationFor(role),
      taskType: ctx.taskType ?? (role === 'red-team' ? 'red-team' : undefined) });
    expect(pair(resolveLaunchSpec(role, role, ctx))).toEqual(pair(baseline));
    expect(pair(launch(role, { tool: setting(role, role === 'fix' ? { account: 'inherit' }
      : { provider: 'inherit', model: 'inherit', effort: 'inherit' }) })))
      .toEqual(pair(baseline));
  });

  it('composes inherited review selection and Codex task routing', () => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    const ctx = context('review', { policy, taskType: 'extra', available: ['codex'] });
    expect(resolveOperationRoute({ ...ctx, operation: 'review-seat' })).toBeNull();
    const seat = selectReviewSeatProvider({ lens: 'extra', available: ['codex'] });
    const codex = resolveCodexTaskRoute({ kind: 'review', tool: {}, platform: {}, env: ctx.env, log: false });
    expect(pair(resolveLaunchSpec('review', 'review', ctx))).toEqual({ provider: seat.provider, model: codex.model, effort: codex.effort });
  });

  it('composes the legacy fix executor chain and Codex resolver', () => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.criticalWorkGate.kinds = [];
    const ctx = context('fix', { policy, repo: { routing: { builder: 'codex' } } });
    const chain = resolveFixExecutorChain({ env: ctx.env, platform: {}, repo: ctx.repo });
    const rung = pickChainRung({ chain: chain.value });
    const codex = resolveCodexTaskRoute({ kind: 'fix', env: ctx.env, tool: {}, platform: {}, log: false });
    expect(pair(resolveLaunchSpec('fix', 'fix', ctx))).toEqual({ provider: rung.executor, model: codex.model, effort: codex.effort });
  });

  it('uses the existing worker tier for inherited Claude routes', () => {
    const ctx = context('worker', { policy: DEFAULT_ROUTING_POLICY, risk: 'high' });
    const tier = workerTierFor({ ...ctx, kind: 'worker' });
    expect(criticalWorkVerdict(ctx).critical).toBe(true);
    expect(pair(resolveLaunchSpec('worker', 'worker', ctx))).toEqual({ provider: 'claude',
      model: resolvePolicyModel('claude', tier.tier), effort: operationEffort('worker', 'claude', undefined) });
  });

  it('requires a caller environment and refuses unknown sites and role mismatches', () => {
    refusal(() => resolveLaunchSpec('helper', 'helper', {}), 'environment');
    refusal(() => resolveLaunchSpec('helper', 'helper', { env: null }), 'environment');
    refusal(() => resolveLaunchSpec('helper', 'unknown', context()), 'site');
    refusal(() => resolveLaunchSpec('helper', 'review', context()), 'site');
    refusal(() => resolveLaunchSpec('helper', '__proto__', context()), 'site');
  });
});

describe('raw layer validation before merging', () => {
  it.each(['platform', 'tool', 'env'])('refuses empty objects at every depth in %s even if masked', layer => {
    for (const block of [{}, { helper: {} }, { helper: { coordinator: {} } }, { executorProfiles: {} }]) {
      const extra = layer === 'env' ? { env: { WE_AI_ROUTING: JSON.stringify(block) } }
        : { [layer]: block, ...(layer === 'platform' ? { tool: setting('helper', { effort: 'max' }) } : {}) };
      refusal(() => launch('helper', extra), 'invalid-setting');
    }
  });

  it.each(['platform', 'tool', 'env'])('refuses null, arrays, unknown keys and invalid types in %s', layer => {
    const blocks = [null, [], 'inherit', 42, { unknown: { effort: 'high' } },
      { helper: null }, { helper: [] }, { helper: { coordinator: { surprise: 'high' } } },
      setting('helper', { effort: true }), setting('helper', { effort: 3 }),
      setting('helper', { model: false }), setting('helper', { provider: [] }),
      setting('helper', { effort: 'maximum' }), { helper: { executors: ['claude'] } },
      JSON.parse('{"__proto__":{"helper":true}}')];
    for (const block of blocks) {
      const extra = layer === 'env' ? { env: { WE_AI_ROUTING: JSON.stringify(block) } } : { [layer]: block };
      refusal(() => launch('helper', extra), 'invalid-setting');
    }
  });

  it('refuses malformed JSON and non-string environment settings', () => {
    refusal(() => launch('helper', { env: { WE_AI_ROUTING: '{' } }), 'resolver');
    refusal(() => launch('helper', { env: { WE_AI_ROUTING: {} } }), 'invalid-setting');
  });

  it('refuses invalid combinations even when a later layer repairs them', () => {
    refusal(() => launch('helper', { platform: setting('helper', { provider: 'codex', model: 'sonnet' }),
      tool: setting('helper', { provider: 'claude', model: 'opus' }) }), 'invalid-setting');
  });

  it('refuses unreadable explicitly selected platform evidence', () => {
    const ctx = context('helper', { env: { WE_PLATFORM_PREFERENCES_FILE: join(process.cwd(), 'scripts/lib/__tests__') } });
    delete ctx.platform;
    refusal(() => resolveLaunchSpec('helper', 'helper', ctx), 'settings-read');
  });

  it('refuses missing explicitly selected platform evidence', () => {
    const ctx = context('helper', { env: { WE_PLATFORM_PREFERENCES_FILE: join(process.cwd(), 'scripts/lib/__tests__/missing-r9-preferences.json') } });
    delete ctx.platform;
    refusal(() => resolveLaunchSpec('helper', 'helper', ctx), 'settings-read');
  });
});

describe('floors and provider constraints', () => {
  it('exports frozen explicit rank tables', () => {
    expect(Object.isFrozen(AI_ROUTING_MODEL_RANKS.claude)).toBe(true);
    expect(AI_ROUTING_MODEL_RANKS.claude['claude-opus-5-5']).toBeGreaterThan(AI_ROUTING_MODEL_RANKS.claude['claude-sonnet-5-5']);
    expect(AI_ROUTING_EFFORT_RANKS.max).toBeGreaterThan(AI_ROUTING_EFFORT_RANKS.high);
  });

  it.each(['review', 'helper', 'ci-heal'])('%s refuses below-floor models and effort, accepts equal and above', role => {
    refusal(() => launch(role, { tool: setting(role, { provider: 'claude', model: 'haiku' }) }), 'floor');
    refusal(() => launch(role, { tool: setting(role, { effort: 'medium' }) }), 'floor');
    expect(launch(role, { tool: setting(role, { effort: 'high' }) }).effort).toBe('high');
    expect(launch(role, { tool: setting(role, { provider: 'claude', model: 'opus', effort: 'max' }) }))
      .toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', effort: 'max' });
  });

  it('judge raises effort while keeping the exact model', () => {
    expect(launch('judge', { tool: setting('judge', { effort: 'max' }) }).effort).toBe('max');
    refusal(() => launch('judge', { tool: setting('judge', { provider: 'claude', model: 'opus' }) }), 'floor');
  });

  it('Codex raises effort but refuses model swaps without inventing a family order', () => {
    const policy = policyFor('judge', 'codex', 'sol', 'high');
    expect(launch('judge', { policy, tool: setting('judge', { effort: 'max' }) }).effort).toBe('max');
    refusal(() => launch('judge', { policy, tool: setting('judge', { provider: 'codex', model: 'astra' }) }), 'floor');
  });

  it('red-team permits provider swaps and refuses changes within a provider', () => {
    const policy = policyFor('red-team', 'codex', 'sol', 'high');
    expect(launch('red-team', { policy, tool: setting('red-team', { provider: 'agy-claude', model: 'sonnet' }) }).provider).toBe('agy-claude');
    refusal(() => launch('red-team', { policy, tool: setting('red-team', { effort: 'max' }) }), 'floor');
    refusal(() => launch('red-team', { policy, tool: setting('red-team', { provider: 'codex', model: 'astra' }) }), 'floor');
    refusal(() => launch('red-team', { policy, tool: setting('red-team', { provider: 'agy-claude', model: 'sonnet', effort: 'low' }) }), 'floor');
    refusal(() => launch('red-team', { policy, readsRepo: true,
      tool: setting('red-team', { provider: 'agy-claude', model: 'sonnet' }) }), 'provider');
  });

  it.each(['helper', 'ci-heal', 'red-team-recheck'])('%s cannot leave Claude', role => {
    refusal(() => launch(role, { tool: setting(role, { provider: 'codex', model: 'sol' }) }), 'provider');
  });

  it.each(['fix', 'build', 'prepare', 'worker'])('%s rejects every non-inherit writer change even if equal or masked', role => {
    refusal(() => launch(role, { tool: setting(role, { effort: 'high' }) }), 'writer');
    refusal(() => launch(role, { platform: setting(role, { effort: 'low' }),
      tool: setting(role, { effort: 'inherit' }) }), 'writer');
  });
});

describe('final policy validation and immutable launch contract', () => {
  it.each([{ mandatoryLens: true }, { care: 'high' }, { pinned: true }, { resume: 'session-id' },
    { model: 'sonnet' }, { effort: 'high' }])('preserves today’s constrained route: %j', constraint => {
    const baseline = launch('helper', constraint);
    expect(pair(launch('helper', { ...constraint, tool: setting('helper', { provider: 'claude', model: 'opus', effort: 'max' }) })))
      .toEqual(pair(baseline));
  });

  it('requires operatorKeys for overlays and honors operation and task operator precedence', () => {
    refusal(() => launch('helper', { operatorKeys: undefined, tool: setting('helper', { effort: 'max' }) }), 'resolver');
    for (const operatorKeys of [['precedent-draft'], ['precedent-draft:lookup'], ['*']]) {
      expect(launch('helper', { operatorKeys, taskType: 'lookup', tool: setting('helper', { effort: 'max' }) }).effort).toBe('high');
    }
  });

  it('refuses quota-held, vetoed and gate-blocked routes through the existing validator', () => {
    refusal(() => launch('helper', { availability: { claude: 'quota held' } }), 'resolver');
    refusal(() => launch('judge', { policy: policyFor('judge', 'codex', 'sol'), gateClosed: true }), 'resolver');
    refusal(() => launch('judge', { policy: policyFor('judge', 'codex', 'sol'),
      vetoes: [{ provider: 'codex', model: 'gpt-6.1-sol' }] }), 'resolver');
  });

  it('refuses exceptions from existing resolvers', () => {
    refusal(() => launch('helper', { policy: { version: 1 } }), 'resolver');
    refusal(() => launch('judge', { policy: policyFor('judge', 'codex', 'sol'), model: 'unknown', effort: 'ultra' }), 'resolver');
  });

  it('preserves the full environment and deep-freezes all launch fields with a fixed budget', () => {
    const env = { PATH: '/bin', SECRET_FOR_CHILD: 'retained', WE_AI_ROUTING: JSON.stringify(setting('helper', { effort: 'max' })) };
    const budget = { turns: 7, tokens: { limit: 1234 } };
    const spec = launch('helper', { env, budget });
    expect(spec.env).toEqual(env);
    expect(Object.isFrozen(env)).toBe(false);
    env.PATH = '/changed-after-resolution';
    expect(spec.env.PATH).toBe('/bin');
    expect(spec.budget).toEqual(budget);
    expect(Object.keys(spec).sort()).toEqual(['provider', 'model', 'effort', 'env', 'readsRepo', 'budget', 'floor', 'sources', 'overlay', 'fallback'].sort());
    const frozen = value => {
      if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen); }
    };
    frozen(spec);
    expect(spec.sources.settings['helper.coordinator.effort']).toBe('env');
    expect(spec.readsRepo).toBe(true);
    refusal(() => launch('helper', { tool: setting('helper', { budget: 1 }) }), 'invalid-setting');
    expect(budget.tokens.limit).toBe(1234);
  });

  it('never reads ambient process.env during resolution', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'env');
    let reads = 0;
    let error;
    try {
      Object.defineProperty(process, 'env', { configurable: true, get() { reads++; return original.value; } });
      launch('helper');
    } catch (caught) { error = caught; }
    finally { Object.defineProperty(process, 'env', original); }
    expect(error).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe('launch policy audit regressions', () => {
  it.each(['mandatory:correctness', 'mandatory:security'])('refuses %s shadow review when Claude quota removes its counting fallback', taskType => {
    const ctx = context('review', { policy: DEFAULT_ROUTING_POLICY, taskType, availability: { claude: 'quota held' } });
    expect(resolveOperationRoute({ ...ctx, operation: 'review-seat' })).toMatchObject({ mode: 'shadow', fallback: [] });
    refusal(() => resolveLaunchSpec('review', 'review', ctx), 'counting-reviewer');
    const spec = launch('review', { ...ctx, availability: {} });
    expect(spec).toMatchObject({ mode: 'shadow', fallback: [expect.objectContaining({ provider: 'claude' })] });
  });

  it('refuses shadow review when its counting fallback is outside the launch provider roster', () => {
    refusal(() => launch('review', { policy: DEFAULT_ROUTING_POLICY, available: ['agy-claude'] }), 'counting-reviewer');
  });

  it.each(['red-team-recheck', 'ci-heal', 'helper'])('%s refuses an unchanged non-Claude baseline', role => {
    const ctx = context(role, { policy: policyFor(role, 'codex', 'sol', 'high') });
    expect(resolveOperationRoute({ ...ctx, operation: operationFor(role) })).toMatchObject({ provider: 'codex' });
    refusal(() => resolveLaunchSpec(role, role, ctx), 'provider');
    expect(launch(role).provider).toBe('claude');
  });

  const invalidContributors = [null, {}, [], { helper: null }, { helper: {} },
    { helper: { coordinator: {} } }, { helper: { coordinator: { effort: 42 } } }, { unknown: true }];
  for (const source of ['legacy', 'file']) {
    it.each(invalidContributors.map(value => [JSON.stringify(value), value]))(`${source} raw contributor %s refuses before a later valid helper can mask it`, (_label, bad) => {
      const valid = { aiRouting: setting('helper', { effort: 'high' }) };
      withToolFiles(source === 'legacy' ? { aiRouting: bad } : undefined,
        source === 'legacy' ? [valid] : [{ aiRouting: bad }, valid], settingsFiles => {
          const ctx = context('helper', { settingsFiles });
          delete ctx.tool;
          const error = refusal(() => resolveLaunchSpec('helper', 'helper', ctx), 'invalid-setting');
          expect(error.detail).toContain(source === 'legacy' ? 'dispatch-settings.json' : 'settings/0.json');
        });
    });
  }

  it('merges valid tool contributors only after scanning their individual raw blocks', () => {
    withToolFiles({ aiRouting: setting('helper', { effort: 'high' }) },
      [{ aiRouting: setting('helper', { provider: 'claude', model: 'sonnet' }) }], settingsFiles => {
        const ctx = context('helper', { settingsFiles });
        delete ctx.tool;
        expect(resolveLaunchSpec('helper', 'helper', ctx)).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
      });
  });

  it('refuses a raw platform file before valid tool and environment layers can mask it', () => {
    withToolFiles(undefined, [{ aiRouting: { helper: null } }], ({ dir }) => {
      const good = setting('helper', { effort: 'high' });
      const ctx = context('helper', { tool: good, env: {
        WE_PLATFORM_PREFERENCES_FILE: join(dir, '0.json'), WE_AI_ROUTING: JSON.stringify(good),
      } });
      delete ctx.platform;
      const error = refusal(() => resolveLaunchSpec('helper', 'helper', ctx), 'settings-read');
      expect(error.detail).toContain('platform.helper');
    });
  });

  it('carries validated shadow mode and the counting Claude fallback into launch and floor evidence', () => {
    const ctx = context('review', { policy: DEFAULT_ROUTING_POLICY });
    const expected = resolveOperationRoute({ ...ctx, operation: 'review-seat' });
    expect(expected).toMatchObject({ mode: 'shadow', provider: 'agy-claude',
      fallback: [expect.objectContaining({ provider: 'claude' })] });
    const spec = resolveLaunchSpec('review', 'review', ctx);
    expect(spec.mode).toBe(expected.mode);
    expect(spec.fallback).toEqual(expected.fallback);
    expect(spec.floor).toMatchObject({ mode: expected.mode, fallback: expected.fallback });
    expect(Object.isFrozen(spec.fallback)).toBe(true);
    expect(Object.isFrozen(spec.fallback[0])).toBe(true);
    expect(Object.isFrozen(spec.floor.fallback[0])).toBe(true);
  });

  it('preserves taskTypes provider restrictions when concretizing an inherited operation', () => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations.judge = { inherit: true };
    policy.taskTypes['restricted-judge'] = { provider: 'claude', model: 'sonnet', effort: 'high',
      disabledProviders: ['agy-claude'], fallback: [] };
    const overlay = { provider: 'agy-claude', model: 'claude-sonnet-5-5', effort: 'high' };
    const ctx = context('judge', { policy, taskType: 'restricted-judge', tool: setting('judge', overlay) });
    expect(() => resolveOperationRoute({ ...ctx, operation: 'judge', aiRouting: overlay })).toThrow(/no available route/);
    refusal(() => resolveLaunchSpec('judge', 'judge', ctx), 'resolver');
    // Positive control: the same overlay is valid once the task restriction is removed.
    const unrestricted = structuredClone(policy);
    delete unrestricted.taskTypes['restricted-judge'].disabledProviders;
    expect(launch('judge', { ...ctx, policy: unrestricted }).provider).toBe('agy-claude');
  });

  it.each(['env', 'codexTool', 'codexPlatform'])('keeps operator-selected Sol/high above weaker Codex %s defaults', layer => {
    const policy = policyFor('judge', 'codex', 'sol', 'high');
    const defaults = { review: { model: 'gpt-6-luna', effort: 'low' } };
    const extra = layer === 'env' ? { env: { WE_CODEX_MODEL_BY_TASK: JSON.stringify(defaults) } } : { [layer]: defaults };
    const ctx = context('judge', { policy, operatorKeys: ['judge'], ...extra });
    const expected = resolveOperationRoute({ ...ctx, operation: 'judge' });
    expect(expected).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
    const spec = resolveLaunchSpec('judge', 'judge', ctx);
    expect(pair(spec)).toEqual(pair(expected));
    expect(spec.floor).toMatchObject(pair(expected));
    // Even without an operator key, a settings overlay cannot turn those defaults into a lower floor.
    refusal(() => launch('judge', { ...ctx, operatorKeys: [],
      tool: setting('judge', { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }) }), 'floor');
  });

  it('refuses final Luna/ultra effort overlays rejected by the Codex resolver', () => {
    const ctx = context('judge', { policy: policyFor('judge', 'codex', 'gpt-6-luna', 'high') });
    expect(() => resolveCodexTaskRoute({ kind: 'review', env: {}, platform: {}, tool: {}, log: false,
      model: 'gpt-6-luna', effort: 'ultra' })).toThrow(/does not support effort ultra/);
    refusal(() => launch('judge', { ...ctx, tool: setting('judge', { effort: 'ultra' }) }), 'resolver');
    expect(launch('judge', { ...ctx, tool: setting('judge', { effort: 'max' }) }))
      .toMatchObject({ model: 'gpt-6-luna', effort: 'max' });
  });

  it('refuses an omitted optional advisory seat instead of resurrecting it through Codex', () => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations['review-seat:advisory:agy-correctness'].disabledProviders = ['agy-claude'];
    const ctx = context('review', { policy, taskType: 'advisory:agy-correctness', available: ['codex', 'agy-claude'] });
    expect(resolveOperationRoute({ ...ctx, operation: 'review-seat' })).toBeNull();
    refusal(() => resolveLaunchSpec('review', 'review', ctx), 'omitted-seat');
    refusal(() => launch('review', { ...ctx, tool: setting('review', { provider: 'codex', model: 'sol' }) }), 'omitted-seat');
    const enabled = structuredClone(policy);
    delete enabled.operations['review-seat:advisory:agy-correctness'].disabledProviders;
    expect(launch('review', { ...ctx, policy: enabled }).provider).toBe('agy-claude');
  });
});
