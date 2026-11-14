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

  it.each([
    ['we:scripts//hooks/check.mjs', 'we:scripts/hooks/check.mjs'],
    ['we:./scripts/hooks/check.mjs', 'we:scripts/hooks/check.mjs'],
    ['we:././scripts///hooks//check.mjs', 'we:scripts/hooks/check.mjs'],
    ['we:./src//plain.ts', 'we:src/plain.ts'],
  ])('normalises scope %s before classification', (scope, canonical) => {
    for (const input of [scope, [scope]]) {
      expect(classifyTouchSet(input)).toEqual(classifyTouchSet([canonical]));
      expect(flow(input)).toEqual(flow([canonical]));
    }
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

  it('delegates overlay precedence to cascadePolicy and adds the winning globs to standard classes', () => {
    const policy = resolve({
      platform: { classes: { guard: ['we:platform/**'] }, flows: { ordinary: [{ stage: 'audit' }] } },
      tool: { classes: { merge: ['we:tool/**'] } },
      env: { WE_DELIVERY_FLOW: JSON.stringify({ classes: { label: ['we:env/**'] } }) },
    });
    expect(policy.classes).toEqual({ ...STANDARD_DELIVERY_FLOW.classes,
      label: [...STANDARD_DELIVERY_FLOW.classes.label, 'we:env/**'] });
    expect(policy.sources).toEqual({ classOrder: 'standard', classes: 'env', flows: 'platform' });
    expect(resolve({ platform: { classes: { guard: ['we:platform/**'] } }, tool: { classes: { merge: ['we:tool/**'] } } }).classes)
      .toEqual({ ...STANDARD_DELIVERY_FLOW.classes,
        merge: [...STANDARD_DELIVERY_FLOW.classes.merge, 'we:tool/**'] });
    expect(policy.flows.ordinary.map(s => s.stage)).toEqual(['build', 'audit', 'review']);
  });

  it.each([{}, { guard: [] }, { guard: ['we:scripts/hooks/narrow/**'] }])(
    'class overlays cannot remove standard globs: %j', classes => {
      for (const layer of ['platform', 'tool', 'env']) {
        const policy = resolve(layer === 'env'
          ? { env: { WE_DELIVERY_FLOW: JSON.stringify({ classes }) } }
          : { [layer]: { classes } });
        for (const name of STANDARD_DELIVERY_FLOW.classOrder) {
          expect(policy.classes[name]).toEqual(expect.arrayContaining(STANDARD_DELIVERY_FLOW.classes[name]));
        }
        expect(classifyTouchSet(['we:scripts/hooks/check.mjs'], policy).class).toBe('guard');
      }
    });

  it('adds overlay globs without duplicating standard globs', () => {
    const policy = resolve({ tool: { classes: { guard: ['we:custom/**', 'we:scripts/hooks/**'] } } });
    expect(policy.classes.guard).toEqual([...STANDARD_DELIVERY_FLOW.classes.guard, 'we:custom/**']);
    expect(classifyTouchSet(['we:custom/check.mjs'], policy).class).toBe('guard');
  });

  it.each([[], ['ordinary'], ['guard', 'ordinary']].map(classOrder => ({ classOrder })))(
    'classOrder cannot omit standard classes: $classOrder', ({ classOrder }) => {
    const policy = resolve({ tool: { classOrder } });
    expect(policy.classOrder).toEqual(STANDARD_DELIVERY_FLOW.classOrder);
    expect(classifyTouchSet(['we:scripts/hooks/check.mjs'], policy).class).toBe('guard');
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

  it('orders a valid overlay and retains all supported design settings', () => {
    const log = vi.fn();
    const design = { stage: 'design', model: 'opus', effort: 'high', timeoutMin: 20, approve: false };
    const policy = resolve({ tool: { flows: { guard: [
      { stage: 'red-team' }, { stage: 'review' }, design, { stage: 'audit' }, { stage: 'build' },
    ] } }, log });
    expect(policy.flows.guard).toEqual([design, { stage: 'build' }, { stage: 'audit' }, { stage: 'review' }, { stage: 'red-team' }]);
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects a whole class overlay with invalid stages and retains other class overlays', () => {
    const log = vi.fn();
    const policy = resolve({ tool: { flows: { guard: [
      { stage: 'red-team' }, { stage: 'design', model: 'opus', effort: 'high', timeoutMin: 20, approve: false },
      { stage: 'audit' }, { stage: 'audit' }, { stage: 'unknown' }, { stage: 'build', model: 'opus' },
      { stage: 'review', timeoutMin: 10 }, { stage: 'design', approve: true }, null,
    ], ordinary: [{ stage: 'review' }, { stage: 'audit' }, { stage: 'build' }] } }, log });
    expect(policy.flows.guard).toEqual(STANDARD_DELIVERY_FLOW.flows.guard);
    expect(policy.flows.ordinary.map(s => s.stage)).toEqual(['build', 'audit', 'review']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ignored invalid'));
  });

  it.each([{ stage: 'design', timeoutMin: 0 }, { stage: 'design', timeoutMin: Infinity },
    { stage: 'design', effort: 'bogus' }, { stage: 'design', model: '' }, { stage: '__proto__' },
    { stage: 'design', approve: true }, { stage: 'build', model: 'opus' }, { stage: 'review' }, null])(
    'invalid stage entry %j rejects the class overlay and restores standard design', entry => {
      const log = vi.fn();
      expect(resolve({ tool: { flows: { guard: [{ stage: 'review' }, entry, { stage: 'audit' }] } }, log }).flows.guard)
        .toEqual(STANDARD_DELIVERY_FLOW.flows.guard);
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
