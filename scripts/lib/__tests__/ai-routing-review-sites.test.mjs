import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiRoutingInputs, resolveAiRouting } from '../ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY, applyRoutingOverrides } from '../dispatch-routing-policy.mjs';
import { settingsFromRoutingPolicy, loadReviewSeatSettings } from '../review-seat-provider.mjs';
import { reviewSeatRoutes, REVIEW_SEAT_MODELS } from '../../operations/review-dispatch.mjs';

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

beforeEach(() => vi.mocked(resolveAiRouting).mockReturnValue(resolved()));

describe('review aiRouting sites', () => {
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

  it('operator overrides win and unknown injected policy provenance is protected', () => {
    const key = 'review-seat';
    const overridden = applyRoutingOverrides(policy, { [key]: { provider: 'agy-gemini', model: 'gemini-4-argon-high' } });
    const aiRouting = aiRoutingInputs('review', resolved(codex)).coordinator;
    expect(reviewSeatRoutes({ routingPolicy: overridden, operatorKeys: [key], aiRouting }).routes
      .find(route => route.key === 'standards-conformance').provider).toBe('agy-gemini');
    expect(settingsFromRoutingPolicy(policy, { aiRouting })).toEqual(settingsFromRoutingPolicy(policy));
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
});
