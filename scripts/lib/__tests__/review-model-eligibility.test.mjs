import { describe, expect, it, vi } from 'vitest';
import { reviewModelEligible } from '../review-model-eligibility.mjs';
import { readRegistry } from '../model-probation.mjs';
import { DEFAULT_ROUTING_POLICY, validateRoutingPolicy, resolveOperationRoute, applyRoutingOverrides } from '../dispatch-routing-policy.mjs';
import { settingsFromRoutingPolicy, seatProviderDirective } from '../review-seat-provider.mjs';
import { runSeatWithProvider } from '../../operations/review-seat-runner.mjs';
import { runAgyReviewJuror } from '../agy-review-juror.mjs';
import { createExtraSeatsIo } from '../../operations/review-extra-seats.mjs';
import { reviewSeatRoutes } from '../../operations/review-dispatch.mjs';
import { criticalWorkVerdict } from '../critical-work.mjs';

const small = ['gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low', 'gemini-4-neon-high', 'gemini-3.8-flash-high'];
const tasks = ['mandatory:security', 'mandatory:correctness', 'advisory:agy-correctness', 'security', 'red-team', 'extra-juror:security'];
const route = model => ({ provider: 'agy-gemini', model, fallback: [] });
const policyFor = (key, model) => {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations[key] = route(model);
  return policy;
};

describe('review model role eligibility', () => {
  it('fails closed for delivery-only, missing, unreadable and unvalidated review evidence', () => {
    const model = 'future-review-model';
    for (const registry of [readRegistry({ read: () => { throw Error('unreadable'); } }),
      { entries: [] }, { entries: [{ provider: 'antigravity', model, roles: { delivery: 'probation' } }] },
      { entries: [{ provider: 'antigravity', model, roles: { 'advisory-review': 'unvalidated' } }] }]) {
      expect(reviewModelEligible('agy-gemini', model, registry)).toBe(false);
    }
    expect(reviewModelEligible('agy-gemini', model, { entries: [{ provider: 'antigravity', model,
      roles: { 'advisory-review': 'probation' } }] })).toBe(true);
    expect(reviewModelEligible('agy-gemini', null)).toBe(false);
  });

  it.each(small)('refuses %s through every policy and override security-juror path', model => {
    for (const taskType of tasks) {
      const key = `review-seat:${taskType}`;
      const policy = policyFor(key, model);
      expect(() => validateRoutingPolicy(policy)).toThrow(/refused|unknown model/);
      const base = policyFor(key, 'gemini-4-argon-high');
      expect(() => applyRoutingOverrides(base, { [key]: route(model) })).toThrow(/refused|unknown model/);
      expect(() => resolveOperationRoute({ operation: 'review-seat', taskType, policy })).toThrow(/refused|unknown model/);
      expect(() => resolveOperationRoute({ operation: 'review-seat', taskType, policy: base,
        aiRouting: route(model), operatorKeys: [] })).toThrow(/refused|unknown model/);
      policy.operations[key] = { ...route('gemini-4-argon-high'), fallback: [{ provider: 'agy-gemini', model }] };
      expect(() => validateRoutingPolicy(policy)).toThrow(/refused|unknown model/);
    }
    expect(() => settingsFromRoutingPolicy(policyFor('review-seat:mandatory:security', model), { aiRouting: undefined }))
      .toThrow(/refused|unknown model/);
    const plan = reviewSeatRoutes({ routingPolicy: policyFor('review-seat', model), operatorKeys: [], aiRouting: undefined,
      available: ['agy-gemini'], env: { WE_REVIEW_SHADOW_AGY_PROMOTED: 'true' } });
    expect(plan.routes).toEqual([]);
    expect(plan.skipped.length).toBeGreaterThan(0);
  });

  it.each(['hydrogen', 'hydrogen-low', 'neon'])('rejects the resolved %s alias and a shadow override', model => {
    expect(() => validateRoutingPolicy(policyFor('review-seat:mandatory:security', model))).toThrow(/refused/);
    const policy = policyFor('review-seat:mandatory:security', 'gemini-4-argon-high');
    policy.operations['review-seat:mandatory:security'].mode = 'shadow';
    policy.operations['review-seat:mandatory:security'].fallback = [{ provider: 'claude', model: 'sonnet' }];
    const settings = settingsFromRoutingPolicy(policy, { aiRouting: undefined });
    expect(() => seatProviderDirective({ ...settings, shadowPolicy: { shadowEnabled: true, scope: 'high-care' },
      shadowModelOverride: { model: DEFAULT_ROUTING_POLICY.aliases['agy-gemini'][model] } }, 'security',
    { repo: 'example/repo', pr: 1, careLevel: 'high' })).toThrow(/refused/);
  });

  it.each(small)('refuses %s at both juror launch boundaries and advisory/red-team spawn', async model => {
    const spawn = vi.fn();
    const out = await runAgyReviewJuror({ model, laneCwd: 'review-lane', request: {},
      deps: { spawnJudge: spawn, mkTempDir: spawn } });
    expect(out).toMatchObject({ status: 'skipped', reasons: [expect.stringContaining('review model refused')] });
    for (const mode of ['agy', 'shadow']) {
      const claudeJudge = vi.fn(async () => ({ findings: [], summary: 'Claude answer' }));
      const result = await runSeatWithProvider({ seatProvider: { model, mode, onEscape: 'claude' } }, {
        claudeJudge, unwrap: value => ({ value }), wrap: value => value, cwd: 'review-lane',
        agyJuror: spawn, appendRow: vi.fn(), log: vi.fn(),
      });
      expect(result.summary).toBe('Claude answer');
      expect(claudeJudge).toHaveBeenCalledOnce();
    }
    const direct = await createExtraSeatsIo({ env: {} }).runSeat({ provider: 'agy-gemini', model });
    expect(direct).toMatchObject({ report: null, error: expect.stringContaining('review model refused') });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(small)('excludes %s from merge-path and security shapes', model => {
    for (const shape of [{ filesTouched: ['scripts/lib/pr-merge-gate.mjs'] },
      { filesTouched: ['scripts/merge-ai-prs.mjs'] }, { filesTouched: ['docs/ordinary.md'], tags: ['security'] }]) {
      const gateClosed = criticalWorkVerdict(shape).critical;
      expect(gateClosed).toBe(true);
      const policy = policyFor('doc-fix', model);
      policy.operations['doc-fix'].fallback = [{ provider: 'claude', model: 'sonnet' }];
      // Retired Flash is rejected by the catalogue; every other small model takes Claude.
      if (model.includes('flash')) expect(() => resolveOperationRoute({ operation: 'doc-fix', gateClosed, policy })).toThrow(/unknown model/);
      else expect(resolveOperationRoute({ operation: 'doc-fix', gateClosed, policy })).toMatchObject({ provider: 'claude', fallback: [] });
    }
    expect(() => validateRoutingPolicy(policyFor('merge-path', model))).toThrow(/refused|unknown model/);
  });

  it.each(['gemini-4-carbon-high', 'gemini-4-argon-high', 'claude-opus-5-5-high', 'claude-sonnet-5-5-high'])(
    'preserves the established %s review route', model => {
      const provider = model.startsWith('claude') ? 'agy-claude' : 'agy-gemini';
      const policy = policyFor('review-seat:mandatory:security', model);
      policy.operations['review-seat:mandatory:security'].provider = provider;
      const validated = validateRoutingPolicy(policy);
      expect(resolveOperationRoute({ operation: 'review-seat', taskType: 'mandatory:security', policy: validated }))
        .toMatchObject({ provider, model, fallback: [] });
    });
});
