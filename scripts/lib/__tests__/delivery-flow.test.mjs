import { describe, expect, it, vi } from 'vitest';
import { classifyTouchSet, deliveryFlowFor, resolveDeliveryFlowPolicy, STANDARD_DELIVERY_FLOW, STAGES } from '../delivery-flow.mjs';

const resolve = (options = {}) => resolveDeliveryFlowPolicy({ env: {}, platform: {}, tool: {}, log: () => {}, ...options });
const flow = (scope, options) => deliveryFlowFor({ scope, kind: 'build' }, { resolve: () => resolve(options) });

describe('deliveryFlow classification', () => {
  it.each([
    ['guard', 'we:scripts/hooks/check.mjs'],
    ['guard', 'we:scripts/guard-bash.mjs'],
    ['guard', 'we:.claude/settings.json'],
    ['guard', 'we:.githooks/pre-push'],
    ['merge', 'we:scripts/merge-ai-prs.mjs'],
    ['merge', 'we:scripts/lib/drain-facts.mjs'],
    ['merge', 'we:scripts/conveyor/merge-queue-enqueue.mjs'],
    ['merge', 'we:scripts/lane-drain.mjs'],
    ['merge', 'we:scripts/pr-land.mjs'],
    ['merge', 'plateau-app:tools/drain-daemon/run.mjs'],
    ['review', 'we:scripts/operations/review-pr.mjs'],
    ['review', 'we:scripts/jury-dispatch.mjs'],
    ['review', 'we:scripts/lib/red-team-policy.mjs'],
    ['review', 'we:skills-src/conveyor/review-brief.md'],
    ['label', 'we:scripts/lib/ai-pr-labels.mjs'],
    ['label', 'we:skills-src/conveyor/label-brief.md'],
    ['daemon', 'we:scripts/conveyor/run.mjs'],
    ['daemon', 'we:scripts/lib/daemon-rebuild/plan.mjs'],
    ['daemon', 'we:skills-src/conveyor/build-daemon.mjs'],
    ['ordinary', 'we:src/index.njk'],
    ['ordinary', 'frontierui:src/button.ts'],
    ['ordinary', 'plateau-app:src/main.ts'],
  ])('%s for %s', (expected, scope) => {
    expect(classifyTouchSet([scope]).class).toBe(expected);
    expect(flow([scope]).class).toBe(expected);
  });

  it('selects the strictest class for mixed sets, independent of scope order', () => {
    const entries = ['we:src/a.ts', 'we:scripts/conveyor/tick.mjs', 'we:scripts/guard-bash.mjs'];
    for (const scope of [entries, [...entries].reverse()]) {
      const result = classifyTouchSet(scope);
      expect(result.class).toBe('guard');
      expect(result.matches.map(m => m.class)).toContain('daemon');
      expect(result.reason).toContain('strictest');
    }
    expect(classifyTouchSet(['we:scripts/conveyor/review-task.mjs']).class).toBe('review');
  });

  it('uses the shared conservative overlap for directory and wildcard scopes', () => {
    expect(classifyTouchSet(['we:scripts/']).class).toBe('guard');
    expect(classifyTouchSet(['we:scripts/operations/merge-queue-*.mjs']).class).toBe('merge');
    expect(classifyTouchSet(['we:scripts/conveyor/*.mjs']).class).toBe('merge');
  });

  it.each([undefined, null, [], '', [''], {}, ['unknown'], ['other:scripts/a.mjs'], ['we:'],
    ['we:src/[ab].ts'], ['frontierui:src/{a,b}.ts'], ['we:src/foo**bar'], ['we:../src/a'],
    ['we:/src/a'], ['we:src/' + 'x'.repeat(4097)], ['we:src/a', 'garbage']])(
    'fails closed to guard for unknown, unsupported or oversized scope %j', scope => {
      expect(classifyTouchSet(scope)).toMatchObject({ class: 'guard', reason: expect.stringMatching(/repair scope/) });
    });

  it('fails closed on unsupported policy globs even when their repo does not match', () => {
    const policy = resolve({ tool: { classes: { ordinary: ['plateau-app:src/[ab].ts'] } } });
    expect(classifyTouchSet(['we:src/a.ts'], policy)).toMatchObject({ class: 'guard', reason: expect.stringMatching(/repair deliveryFlow/) });
  });

  it('no match selects ordinary and returns no matches', () => {
    expect(classifyTouchSet(['we:src/plain.ts'])).toEqual({ class: 'ordinary', reason: 'no class glob overlaps', matches: [] });
  });
});

describe('deliveryFlow policy and choke point', () => {
  it('pins the closed stage order, required spine and daemon design default', () => {
    expect(Object.keys(STAGES)).toEqual(['design', 'build', 'audit', 'review', 'red-team']);
    expect(Object.values(STAGES).map(s => s.order)).toEqual([0, 1, 2, 3, 4]);
    expect(Object.entries(STAGES).filter(([, s]) => s.required).map(([name]) => name)).toEqual(['build', 'review']);
    expect(resolve()).toEqual({ ...STANDARD_DELIVERY_FLOW, sources: { classOrder: 'standard', classes: 'standard', flows: 'standard' } });
    for (const name of ['guard', 'merge', 'review', 'label', 'daemon']) {
      expect(resolve().flows[name]).toEqual([{ stage: 'design', model: 'opus', effort: 'high', timeoutMin: 20 }, { stage: 'build' }, { stage: 'review' }]);
    }
    expect(resolve().flows.ordinary).toEqual([{ stage: 'build' }, { stage: 'review' }]);
  });

  it('delegates precedence and whole top-level replacement to cascadePolicy, including provenance', () => {
    const policy = resolve({
      platform: { classes: { guard: ['we:platform/**'] }, flows: { ordinary: [{ stage: 'audit' }] } },
      tool: { classes: { merge: ['we:tool/**'] } },
      env: { WE_DELIVERY_FLOW: JSON.stringify({ classes: { label: ['we:env/**'] } }) },
    });
    expect(policy.classes).toEqual({ label: ['we:env/**'] });
    expect(policy.sources).toEqual({ classOrder: 'standard', classes: 'env', flows: 'platform' });
    expect(resolve({ platform: { classes: { guard: ['we:platform/**'] } }, tool: { classes: { merge: ['we:tool/**'] } } }).classes)
      .toEqual({ merge: ['we:tool/**'] });
    expect(policy.flows.ordinary.map(s => s.stage)).toEqual(['build', 'audit', 'review']);
  });

  it('honors classOrder for mixed sets', () => {
    const policy = resolve({ tool: { classOrder: ['daemon', 'guard', 'merge', 'review', 'label', 'ordinary'] } });
    expect(classifyTouchSet(['we:scripts/guard-bash.mjs', 'we:scripts/conveyor/tick.mjs'], policy).class).toBe('daemon');
  });

  it('unreadable repo layer and malformed environment retain standard policy', () => {
    const log = vi.fn();
    const policy = resolveDeliveryFlowPolicy({ platform: {}, env: { WE_DELIVERY_FLOW: '{bad' }, read: () => { throw new Error('unreadable'); }, log });
    expect(policy.flows).toEqual(STANDARD_DELIVERY_FLOW.flows);
    expect(policy.sources).toEqual({ classOrder: 'standard', classes: 'standard', flows: 'standard' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ignored invalid'));
  });

  it('unreadable platform file retains standard policy', () => {
    const policy = resolveDeliveryFlowPolicy({ tool: {}, env: { WE_PLATFORM_PREFERENCES_FILE: 'scripts/settings/does-not-exist-delivery-flow.json' } });
    expect(policy.flows).toEqual(STANDARD_DELIVERY_FLOW.flows);
    expect(policy.sources.flows).toBe('standard');
  });

  it.each([[], [{ stage: 'design' }], [{ stage: 'review' }], [{ stage: 'build' }]].map(stages => ({ stages })))(
    'overlays cannot remove the build/review spine: $stages', ({ stages }) => {
      const log = vi.fn();
      const policy = resolve({ tool: { flows: { ordinary: stages } }, log });
      expect(policy.flows.ordinary.map(s => s.stage)).toEqual(stages.some(s => s.stage === 'design') ? ['design', 'build', 'review'] : ['build', 'review']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ignored invalid'));
    });

  it('drops invalid stages/settings, restores spine, deduplicates and orders valid entries', () => {
    const log = vi.fn();
    const policy = resolve({ tool: { flows: { ordinary: [
      { stage: 'red-team' }, { stage: 'design', model: 'opus', effort: 'high', timeoutMin: 20, approve: false },
      { stage: 'audit' }, { stage: 'audit' }, { stage: 'unknown' }, { stage: 'build', model: 'opus' },
      { stage: 'review', timeoutMin: 10 }, { stage: 'design', approve: true }, null,
    ] } }, log });
    expect(policy.flows.ordinary.map(s => s.stage)).toEqual(['design', 'build', 'audit', 'review', 'red-team']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ignored invalid'));
  });

  it.each([{ stage: 'design', timeoutMin: 0 }, { stage: 'design', timeoutMin: Infinity },
    { stage: 'design', effort: 'bogus' }, { stage: 'design', model: '' }, { stage: '__proto__' }])(
    'drops invalid stage entry %j with a diagnostic', entry => {
      const log = vi.fn();
      expect(resolve({ tool: { flows: { ordinary: [entry] } }, log }).flows.ordinary).toEqual(STANDARD_DELIVERY_FLOW.flows.ordinary);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ignored invalid'));
    });

  it('ignores invalid top-level values with a diagnostic', () => {
    const log = vi.fn();
    expect(resolve({ tool: { classOrder: ['ordinary'], classes: [], flows: { alien: [] } }, log }).flows).toEqual(STANDARD_DELIVERY_FLOW.flows);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ignored invalid'));
  });

  it('returns null without reading for non-build kinds', () => {
    const reader = vi.fn();
    for (const kind of ['prepare', 'review', 'fix', undefined]) expect(deliveryFlowFor({ kind }, { resolve: reader })).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it('reader throws -> null plus exactly one bounded delivery-flow-unreadable log', () => {
    const log = vi.fn();
    expect(deliveryFlowFor({ kind: 'build' }, { resolve: () => { throw new Error('hostile\u001btext\n'); }, log })).toBeNull();
    expect(log.mock.calls).toEqual([['delivery-flow-unreadable']]);
    expect(() => deliveryFlowFor({ kind: 'build' }, { resolve: () => { throw new Error(); }, log: () => { throw new Error(); } })).not.toThrow();
    expect(deliveryFlowFor(null, { log: () => {} })).toBeNull();
  });
});
