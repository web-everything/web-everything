import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aiRoutingInputs, resolveAiRouting } from '../ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY, applyRoutingOverrides, validateRoutingPolicy } from '../dispatch-routing-policy.mjs';
import { settingsFromRoutingPolicy, loadReviewSeatSettings } from '../review-seat-provider.mjs';
import { reviewSeatRoutes, REVIEW_SEAT_MODELS } from '../../operations/review-dispatch.mjs';
import { readRoutingPolicy } from '../dispatch-routing-policy-io.mjs';
import { runExtraSeats } from '../../operations/review-extra-seats.mjs';

vi.mock('../ai-routing.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, resolveAiRouting: vi.fn(() => actual.resolveAiRouting({
    env: {}, tool: {}, platform: {}, log: false, accountMap: { accounts: {} },
  })) };
});
const actual = await vi.importActual('../ai-routing.mjs');
const resolved = (coordinator) => actual.resolveAiRouting({
  env: {}, tool: coordinator === undefined ? {} : { review: { coordinator } },
  platform: {}, log: false, accountMap: { accounts: {} },
});
const policy = DEFAULT_ROUTING_POLICY;
const safeguards = { value: { shadowEnabled: false, minNonClaudeSeats: 0 } };
const settingsOptions = { policy, operatorKeys: [], shadowModel: null, safeguards, log: () => {} };
const codex = { provider: 'codex', model: 'gpt-6-astra', effort: 'high' };

beforeEach(() => {
  vi.mocked(resolveAiRouting).mockReturnValue(resolved());
  vi.spyOn(readRoutingPolicy, 'operatorKeys').mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('review aiRouting sites', () => {
  it('imports review-dispatch with a Luna task model and an ultra coordinator without resolving their compatibility', () => {
    const moduleUrl = pathToFileURL(resolve('scripts/operations/review-dispatch.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)}); console.log('imported')`], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
      env: { ...process.env,
        WE_CODEX_MODEL_BY_TASK: '{"review":{"model":"gpt-6-luna","effort":"medium"}}',
        WE_AI_ROUTING: '{"review":{"coordinator":{"effort":"ultra"}}}',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('imported');
  }, 25_000);

  it('resolves compatibility only for an applicable non-operator-owned Codex seat', () => {
    vi.stubEnv('WE_CODEX_MODEL_BY_TASK', '{"review":{"model":"gpt-6-luna","effort":"medium"}}');
    vi.mocked(resolveAiRouting).mockReturnValue(resolved({ effort: 'ultra' }));
    expect(() => reviewSeatRoutes({ routingPolicy: policy, operatorKeys: [], available: ['codex'] }))
      .toThrow(/gpt-6-luna does not support effort ultra/);
    const protectedRoutes = reviewSeatRoutes({ routingPolicy: policy, operatorKeys: ['review-seat'], available: ['codex'] });
    expect(protectedRoutes.routes).toHaveLength(3);
    expect(protectedRoutes.routes.every(route => route.model === 'gpt-6-luna' && route.effort === 'medium')).toBe(true);
    expect(() => reviewSeatRoutes({ routingPolicy: policy, operatorKeys: [], available: ['agy-claude'] })).not.toThrow();
    expect(reviewSeatRoutes({ routingPolicy: policy, operatorKeys: [], callsRemaining: 0 }).routes).toEqual([]);
  });

  it('uses live operator provenance with the runExtraSeats call shape, including changed provenance', () => {
    const context = { available: ['codex', 'agy-claude'], providerAvailable: () => true,
      scorecards: [], callsRemaining: 10, routingPolicy: policy };
    const baseline = reviewSeatRoutes(context);
    vi.mocked(resolveAiRouting).mockReturnValue(resolved(codex));
    const result = reviewSeatRoutes(context);
    expect(result).not.toEqual(baseline);
    expect(result.routes).toHaveLength(3);
    expect(result.routes.every(route => route.provider === 'codex' && route.model === codex.model)).toBe(true);
    vi.mocked(readRoutingPolicy.operatorKeys).mockReturnValue(['review-seat']);
    expect(reviewSeatRoutes(context)).toEqual(baseline);
  });

  it('runExtraSeats launches the live coordinator model when it supplies the routing policy without operatorKeys', async () => {
    vi.mocked(resolveAiRouting).mockReturnValue(resolved(codex));
    const runSeat = vi.fn(async () => ({ exitCode: 1 }));
    const result = await runExtraSeats({ pr: 6956, repo: 'web-everything/web-everything', lanePath: '/lane',
      routingPolicy: policy, env: {}, loopPayload: { findings: { read: {
        diffText: 'diff --git a/x b/x\n+1\n', netChangedFiles: ['x'], netBasis: { rev: 'a'.repeat(40) },
      } } },
    }, {
      now: () => Date.parse('2026-11-17T00:00:00Z'), readRecords: () => [], log: () => {},
      cliAvailable: () => true,
      reserveCalls: ({ want }) => ({ used: 0, callIds: Array.from({ length: want }, (_, i) => `call-${i}`) }),
      makeScratch: () => '/tmp/review-routing-test', removeScratch: () => {}, writeFile: () => {},
      append: () => {}, runSeat,
    });
    expect(result.status, result.reason).toBe('ran');
    expect(result.seats).toHaveLength(3);
    expect(runSeat).toHaveBeenCalledTimes(1);
    expect(runSeat.mock.calls[0][0]).toMatchObject(codex);
  });

  it.each([undefined, {}, { provider: 'inherit', model: 'inherit', effort: 'inherit' }])(
    'PARITY: empty/inherit %j equals omitted aiRouting across seat contexts', coordinator => {
      const contexts = [{}, { available: ['codex'] }, { available: [] },
        { callsRemaining: 0 }, { callsRemaining: 1 }, { providerAvailable: () => false }];
      const baseline = contexts.map(context => reviewSeatRoutes({ ...context, routingPolicy: policy, operatorKeys: [] }));
      const projections = [null, { value: 'gemini-4-argon-high', source: 'settings' }].map(shadowModel => ({
        pure: settingsFromRoutingPolicy(policy, { shadowModel, operatorKeys: [] }),
        live: loadReviewSeatSettings({ ...settingsOptions, shadowModel }),
      }));
      vi.mocked(resolveAiRouting).mockReturnValue(resolved(coordinator));
      const aiRouting = aiRoutingInputs('review', resolved(coordinator)).coordinator;
      expect(aiRouting).toBeUndefined();
      contexts.forEach((context, i) => {
        expect(reviewSeatRoutes({ ...context, routingPolicy: policy, operatorKeys: [], aiRouting })).toEqual(baseline[i]);
      });
      [null, { value: 'gemini-4-argon-high', source: 'settings' }].forEach((shadowModel, i) => {
        expect(settingsFromRoutingPolicy(policy, { shadowModel, operatorKeys: [], aiRouting })).toEqual(projections[i].pure);
        expect(loadReviewSeatSettings({ ...settingsOptions, shadowModel, aiRouting })).toEqual(projections[i].live);
      });
    });

  it('uses the review coordinator lazily for added seats and leaves module pins stable', () => {
    const pins = structuredClone(REVIEW_SEAT_MODELS);
    const baseline = reviewSeatRoutes({ routingPolicy: policy, operatorKeys: [] });
    vi.mocked(resolveAiRouting).mockReturnValue(resolved(codex));
    const result = reviewSeatRoutes({ routingPolicy: policy, operatorKeys: [] });
    expect(result).not.toEqual(baseline);
    expect(result.routes).toHaveLength(3);
    expect(result.routes.every(route => route.provider === 'codex' && route.model === codex.model)).toBe(true);
    expect(REVIEW_SEAT_MODELS).toEqual(pins);
    expect(result.routes.some(route => route.seat !== 'extra-juror' && ['correctness', 'security'].includes(route.lens))).toBe(false);
  });

  it.each(['correctness', 'security'])('mandatory %s rejects a Codex coordinator through existing safety checks', lens => {
    vi.mocked(resolveAiRouting).mockReturnValue(resolved(codex));
    const operatorKeys = lens === 'security' ? ['review-seat:mandatory:correctness'] : [];
    expect(() => settingsFromRoutingPolicy(policy, { operatorKeys })).toThrow(/provider|claude/i);
    expect(() => loadReviewSeatSettings({ ...settingsOptions, operatorKeys })).toThrow(/provider|claude/i);
  });

  it('a native Claude coordinator keeps both mandatory seats Claude-capable', () => {
    const baseline = settingsFromRoutingPolicy(policy, { operatorKeys: [] });
    vi.mocked(resolveAiRouting).mockReturnValue(resolved({ provider: 'claude', model: 'sonnet', effort: 'high' }));
    // A native Claude coordinator remains Claude-capable for both mandatory lenses.
    const result = loadReviewSeatSettings(settingsOptions);
    expect(result.seatProvider).toEqual({ correctness: 'claude', security: 'claude' });
    expect(result.seatProvider).not.toEqual(baseline.seatProvider);
  });

  it.each(['review-seat:standards-conformance', 'review-seat', 'review', '*'])('operator override %s wins against a live coordinator', key => {
    const base = validateRoutingPolicy({ ...policy, operations: { ...policy.operations,
      'review-seat:standards-conformance': { provider: 'agy-gemini', model: 'gemini-4-argon-high', fallback: [] },
    } });
    const overridden = applyRoutingOverrides(base, { [key]: { effort: { 'agy-gemini': 'low' } } });
    const aiRouting = aiRoutingInputs('review', resolved(codex)).coordinator;
    vi.mocked(resolveAiRouting).mockReturnValue(resolved(codex));
    expect(reviewSeatRoutes({ routingPolicy: overridden, operatorKeys: [key], aiRouting }).routes
      .find(route => route.key === 'standards-conformance').provider).toBe('agy-gemini');
    expect(reviewSeatRoutes({ routingPolicy: overridden, operatorKeys: [], aiRouting }).routes
      .find(route => route.key === 'standards-conformance')).toMatchObject(codex);
    expect(settingsFromRoutingPolicy(policy, { aiRouting })).toEqual(settingsFromRoutingPolicy(policy, { aiRouting: {} }));
  });

  it('no available route refuses instead of selecting around the configured coordinator', () => {
    const result = reviewSeatRoutes({ routingPolicy: policy, operatorKeys: [], available: [],
      aiRouting: aiRoutingInputs('review', resolved(codex)).coordinator });
    expect(result.routes).toEqual([]);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped.every(seat => /no available route/.test(seat.reason))).toBe(true);
  });

  it('invalid setting falls back to inherit at all review sites', () => {
    const baseline = reviewSeatRoutes({ routingPolicy: policy, operatorKeys: [] });
    const settings = loadReviewSeatSettings(settingsOptions);
    const invalid = resolved({ provider: 'unknown-provider' });
    expect(invalid.invalid.length).toBeGreaterThan(0);
    expect(aiRoutingInputs('review', invalid).coordinator).toBeUndefined();
    vi.mocked(resolveAiRouting).mockReturnValue(invalid);
    expect(reviewSeatRoutes({ routingPolicy: policy, operatorKeys: [] })).toEqual(baseline);
    expect(loadReviewSeatSettings(settingsOptions)).toEqual(settings);
  });

  it.each(['review-seat:standards-conformance', 'review-seat', 'review', '*'])('operator-owned %s keeps the Codex pin against a live coordinator', key => {
    vi.stubEnv('WE_CODEX_MODEL_BY_TASK', '{"review":{"model":"gpt-6-luna","effort":"medium"}}');
    const aiRouting = aiRoutingInputs('review', resolved(codex)).coordinator;
    const context = { routingPolicy: policy, operatorKeys: [key], available: ['codex'] };
    const baseline = reviewSeatRoutes(context).routes.find(route => route.key === 'standards-conformance');
    vi.mocked(resolveAiRouting).mockReturnValue(resolved(codex));
    const protectedRoute = reviewSeatRoutes(context).routes.find(route => route.key === 'standards-conformance');
    expect(protectedRoute).toEqual(baseline);
    expect(protectedRoute).toMatchObject({ model: 'gpt-6-luna', effort: 'medium' });
    expect(reviewSeatRoutes({ ...context, aiRouting, operatorKeys: [] }).routes
      .find(route => route.key === 'standards-conformance')).toMatchObject(codex);
  });
});
