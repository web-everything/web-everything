import { describe, it, expect } from 'vitest';
import {
  resolveBuilderLaunchPolicy, loadBuilderLaunchPolicy, formatBuilderLaunchPolicyLine, FREE_SLOTS, MAX_LAUNCHES_ENV,
} from '../builder-launch-policy.mjs';

describe('builder.maxLaunchesPerTick cascade (x3mdsyv)', () => {
  it('standard default is free-slots (no extra bound)', () => {
    expect(resolveBuilderLaunchPolicy()).toEqual({ maxLaunchesPerTick: FREE_SLOTS, limit: Infinity, source: 'standard', invalid: [] });
  });
  it('platform → tool → env, each overriding the layer below and naming itself', () => {
    expect(resolveBuilderLaunchPolicy({ platform: { maxLaunchesPerTick: 3 } })).toMatchObject({ limit: 3, source: 'platform' });
    expect(resolveBuilderLaunchPolicy({ platform: { maxLaunchesPerTick: 3 }, tool: { maxLaunchesPerTick: 1 } })).toMatchObject({ limit: 1, source: 'tool' });
    expect(resolveBuilderLaunchPolicy({ tool: { maxLaunchesPerTick: 1 }, env: { [MAX_LAUNCHES_ENV]: 'free-slots' } })).toMatchObject({ limit: Infinity, source: 'env' });
    expect(resolveBuilderLaunchPolicy({ env: { [MAX_LAUNCHES_ENV]: '4' } })).toMatchObject({ maxLaunchesPerTick: 4, source: 'env' });
  });
  it('an invalid value never overrides a lower layer and is reported', () => {
    const p = resolveBuilderLaunchPolicy({ platform: { maxLaunchesPerTick: 2 }, tool: { maxLaunchesPerTick: 0 }, env: { [MAX_LAUNCHES_ENV]: 'lots' } });
    expect(p).toMatchObject({ limit: 2, source: 'platform' });
    expect(p.invalid).toEqual(['tool.maxLaunchesPerTick=0', `env.${MAX_LAUNCHES_ENV}="lots"`]);
    expect(resolveBuilderLaunchPolicy({ platform: 'x' }).invalid).toEqual(['platform: not an object']);
  });
  it('load: a missing platform file is "not set"; an unreadable one is reported, never thrown', () => {
    const enoent = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
    expect(loadBuilderLaunchPolicy({ readFile: enoent, toolSettings: {}, env: {} })).toMatchObject({ source: 'standard', invalid: [] });
    const bad = loadBuilderLaunchPolicy({ readFile: () => '{', toolSettings: {}, env: {} });
    expect(bad.source).toBe('standard');
    expect(bad.invalid[0]).toMatch(/^platform file unreadable/);
    const plat = loadBuilderLaunchPolicy({ readFile: () => JSON.stringify({ builder: { maxLaunchesPerTick: 2 } }), toolSettings: { builder: {} }, env: {} });
    expect(plat).toMatchObject({ limit: 2, source: 'platform' });
  });
  it('formats one log line naming the value and its layer', () => {
    expect(formatBuilderLaunchPolicyLine(resolveBuilderLaunchPolicy({ tool: { maxLaunchesPerTick: 1 } })))
      .toBe('builder launch policy: maxLaunchesPerTick=1 (tool)');
  });
});
