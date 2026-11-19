import { describe, expect, it, vi } from 'vitest';
// Legacy launch assertions use shipped policy with capacity scoring switched off.
vi.mock('../../lib/settings-files.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readDeclaredSettings: options => {
    const declared = actual.readDeclaredSettings(options);
    return { ...declared, settings: { ...declared.settings, routing: { ...declared.settings.routing,
      capacity: { ...declared.settings.routing?.capacity, enabled: false } } } };
  } };
});
import { dispatchFix, launchTableFor } from '../reconcile-fix-dispatch.mjs';
import { resolveFixSettings } from '../fix-takeover.mjs';
import { DEFAULT_ROUTING_POLICY, resolveOperationRoute, resolvePolicyModel, validateRoutingPolicy } from '../../lib/dispatch-routing-policy.mjs';
import * as routingPolicyIO from '../../lib/dispatch-routing-policy-io.mjs';

import { PROVIDER_DEFAULTS } from '../../lib/provider-capacity.mjs';
const fixCapacity = { ...PROVIDER_DEFAULTS, enabled: true, claudeUsageAccount: 'claude-a' };
const capacityNow = Date.parse('2026-11-19T12:00:00Z');
const capacity = [{ ...PROVIDER_DEFAULTS.providers.find(p => p.id === 'claude'), provider: 'claude', account: 'claude-a',
  health: 1, known: true, windows: [{ usedPercent: 10, resetsAt: capacityNow + 3600000 }] }];
const ruling = { rung: { id: 'stronger-model', at: 2 }, route: { provider: 'claude', model: 'opus', effort: 'high' } };
const ordinary = { pr: 42, itemNum: '42', lane: 2, laneRef: 'lane/42-x', scope: ['we:scripts/x.mjs'] };

describe('daemon Claude fix models', () => {
  it('shipped inherited stronger routing uses live Claude capacity while cross-provider fallback stays Sonnet', () => {
    expect(routingPolicyIO.resolveOperationRoute({ operation: 'fix', taskType: 'ruling-escalation-stronger',
      available: ['claude'], policy: DEFAULT_ROUTING_POLICY, providerCapacity: fixCapacity, capacity, now: capacityNow }))
      .toMatchObject({ model: DEFAULT_ROUTING_POLICY.aliases.claude.opus, effort: 'high' });
    expect(resolveOperationRoute({ operation: 'fix', taskType: 'ruling-escalation-cross-provider', available: ['claude'], policy: DEFAULT_ROUTING_POLICY }))
      .toMatchObject({ model: DEFAULT_ROUTING_POLICY.aliases.claude.sonnet, effort: 'high' });
    expect(routingPolicyIO.resolveOperationRoute({ operation: 'fix', taskType: 'ruling-escalation-stronger',
      policy: DEFAULT_ROUTING_POLICY, providerCapacity: { ...PROVIDER_DEFAULTS, enabled: false } })).toBeNull();
  });

  it('resolves the escalation model through standard, platform, tool and env and logs its source', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolve = (options = {}) => resolveFixSettings({ env: {}, platform: {}, read: () => '{}', ...options });
    try {
      expect(resolve()).toMatchObject({ claudeEscalationModel: 'sonnet', sources: { claudeEscalationModel: 'standard' } });
      expect(resolve({ platform: { claudeEscalationModel: 'haiku' } }))
        .toMatchObject({ claudeEscalationModel: 'haiku', sources: { claudeEscalationModel: 'platform' } });
      const layers = { platform: { claudeEscalationModel: 'haiku' }, read: () => JSON.stringify({ fix: { claudeEscalationModel: 'sonnet' } }) };
      expect(resolve(layers)).toMatchObject({ claudeEscalationModel: 'sonnet', sources: { claudeEscalationModel: 'tool' } });
      expect(resolve({ ...layers, env: { WE_FIX_CLAUDE_ESCALATION_MODEL: 'haiku', WE_POLICY_CASCADE_LOG: '1' } }))
        .toMatchObject({ claudeEscalationModel: 'haiku', sources: { claudeEscalationModel: 'env' } });
      expect(log.mock.calls.flat().join('\n')).toContain('claudeEscalationModel="haiku" (env)');
      // Opus is reserved for the critical-work verdict, never a non-critical setting override.
      expect(resolve({ env: { WE_FIX_CLAUDE_ESCALATION_MODEL: 'opus' } }).claudeEscalationModel).toBe('sonnet');
      expect(launchTableFor(ordinary, ruling, { fixSettings: resolve({ platform: { claudeEscalationModel: 'haiku' } }) }).model)
        .toBe(DEFAULT_ROUTING_POLICY.aliases.claude.haiku);
    } finally { log.mockRestore(); }
  });

  it.each([
    ['ordinary fix', {}, null],
    ['previous rounds', {}, ruling],
    ['ruling-not-addressed send-back', { rulingNotAddressed: ruling }, null],
    ['operator send-back', { openOperatorSendBacks: [] }, null],
    ['block-ruled fix', { blockRuledReferrals: [] }, null],
    ['takeover', { takeover: ruling }, null],
  ])('%s gets Sonnet; only a critical-work verdict selects Opus', (_name, extra, escalation) => {
    expect(launchTableFor({ ...ordinary, ...extra }, escalation)?.model).toBe(DEFAULT_ROUTING_POLICY.aliases.claude.sonnet);
    expect(launchTableFor({ ...ordinary, ...extra, scope: ['we:scripts/lib/provider-routing.mjs'] }, escalation)?.model)
      .toBe(DEFAULT_ROUTING_POLICY.aliases.claude.opus);
  });

  it.each([false, true])('applies and logs Sonnet at the actual Claude launch (wrapped=%s)', (wrapped) => {
    const spawnAgent = vi.fn(() => 'backgrounded · abcdef12 · fix-42\n');
    const launchWrapped = vi.fn(() => ({ handle: 'pid:1' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      dispatchFix({ ...ordinary, rulingNotAddressed: ruling }, {
        root: '/repo', readBrief: () => '{{PR_NUM}} {{LANE_REF}} {{LANE}} {{SCOPE}} {{SESSION_SLUG}}',
        readFixClaim: () => null, acquireClaim: () => ({ ok: true }), postNotice: vi.fn(),
        grantConflictHelper: vi.fn(), readHistoryInputs: () => null,
        wrapFix: wrapped, spawnAgent, launchWrapped,
        fixSettings: { claudeEscalationModel: 'sonnet', sources: { claudeEscalationModel: 'platform' } },
        executorDecision: { executor: 'claude', reason: 'stronger-model rung' },
      });
      const argv = wrapped ? launchWrapped.mock.calls[0][0].bgArgv : spawnAgent.mock.calls[0][0];
      expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
      expect(log.mock.calls.flat().join('\n')).toContain('fix.claudeEscalationModel=sonnet (source platform)');
    } finally { log.mockRestore(); }
  });

  it.each(['inherited', 'missing', 'inherited-no-opus-alias', 'missing-no-opus-alias'])('critical fixes retain a critical model with a %s policy route', (variant) => {
    const input = structuredClone(DEFAULT_ROUTING_POLICY);
    if (variant.startsWith('inherited')) input.operations['fix:critical-work'] = { inherit: true };
    else delete input.operations['fix:critical-work'];
    if (variant.endsWith('no-opus-alias')) delete input.aliases.claude.opus;
    const policy = validateRoutingPolicy(input);
    const resolveRoute = vi.spyOn(routingPolicyIO, 'resolveOperationRoute')
      .mockImplementation(options => resolveOperationRoute({ ...options, policy }));
    const resolveModel = vi.spyOn(routingPolicyIO, 'resolvePolicyModel')
      .mockImplementation((provider, model) => resolvePolicyModel(provider, model, policy));
    try {
      expect(resolveOperationRoute({ operation: 'fix', taskType: 'critical-work', policy })).toBeNull();
      for (const escalation of [null, ruling]) {
        expect(launchTableFor({ ...ordinary, scope: ['we:scripts/lib/provider-routing.mjs'] }, escalation))
          .toMatchObject({ model: DEFAULT_ROUTING_POLICY.aliases.claude.opus, effort: 'high' });
      }
    } finally { resolveRoute.mockRestore(); resolveModel.mockRestore(); }
  });
});
