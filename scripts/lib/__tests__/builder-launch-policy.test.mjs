import { describe, it, expect } from 'vitest';
import {
  resolveBuilderLaunchPolicy, loadBuilderLaunchPolicy, formatBuilderLaunchPolicyLine, FREE_SLOTS, MAX_LAUNCHES_ENV,
  resolveBuilderPausedPollPolicy, loadBuilderPausedPollPolicy, formatBuilderPausedPollPolicyLine, PAUSED_POLL_ENV,
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

describe('builder.pausedPollSec cascade', () => {
  it('defaults to 600 and resolves platform → tool → env with sources', () => {
    expect(resolveBuilderPausedPollPolicy()).toEqual({ pausedPollSec: 600, source: 'standard', invalid: [] });
    expect(resolveBuilderPausedPollPolicy({ platform: { pausedPollSec: 90 } })).toMatchObject({ pausedPollSec: 90, source: 'platform' });
    expect(resolveBuilderPausedPollPolicy({ platform: { pausedPollSec: 90 }, tool: { pausedPollSec: 120 } }))
      .toMatchObject({ pausedPollSec: 120, source: 'tool' });
    expect(resolveBuilderPausedPollPolicy({ tool: { pausedPollSec: 120 }, env: { [PAUSED_POLL_ENV]: '300' } }))
      .toMatchObject({ pausedPollSec: 300, source: 'env' });
    expect(resolveBuilderPausedPollPolicy({ env: { [PAUSED_POLL_ENV]: '' } }).invalid).toEqual([]);
  });

  it.each([0, -1, 1.5, '600', null, 'nope', Infinity])('falls back to 600 for invalid tool value %s', (value) => {
    const p = resolveBuilderPausedPollPolicy({ platform: { pausedPollSec: 90 }, tool: { pausedPollSec: value } });
    expect(p).toMatchObject({ pausedPollSec: 600, source: 'standard' });
    expect(p.invalid).toHaveLength(1);
    expect(formatBuilderPausedPollPolicyLine(p)).toContain('invalid setting, fallback to 600s');
  });

  it.each(['0', '-1', '1.5', 'Infinity', 'abc', '9007199254740992'])('rejects invalid env value %s', (value) => {
    expect(resolveBuilderPausedPollPolicy({ tool: { pausedPollSec: 90 }, env: { [PAUSED_POLL_ENV]: value } }))
      .toMatchObject({ pausedPollSec: 600, source: 'standard', invalid: [expect.stringContaining(PAUSED_POLL_ENV)] });
  });

  describe.each(['platform', 'tool', 'env'])('Node timer bounds for %s', (layer) => {
    const optionsFor = value => layer === 'env'
      ? { env: { [PAUSED_POLL_ENV]: String(value) } }
      : { [layer]: { pausedPollSec: value } };

    it('accepts the largest whole-second delay below the timer limit', () => {
      expect(resolveBuilderPausedPollPolicy(optionsFor(2_147_483)))
        .toEqual({ pausedPollSec: 2_147_483, source: layer, invalid: [] });
    });

    it.each([2_147_484, 4_294_967, Number.MAX_SAFE_INTEGER])('rejects overflowing delay %s with a diagnostic', value => {
      const policy = resolveBuilderPausedPollPolicy(optionsFor(value));
      expect(policy).toMatchObject({ pausedPollSec: 600, source: 'standard' });
      expect(policy.invalid).toHaveLength(1);
      expect(formatBuilderPausedPollPolicyLine(policy)).toContain('invalid setting, fallback to 600s');
    });
  });

  it('resets an overflowing higher layer, and allows a valid later override', () => {
    const options = { platform: { pausedPollSec: 90 }, tool: { pausedPollSec: 2_147_484 } };
    expect(resolveBuilderPausedPollPolicy(options)).toMatchObject({ pausedPollSec: 600, source: 'standard' });
    expect(resolveBuilderPausedPollPolicy({ ...options, env: { [PAUSED_POLL_ENV]: '120' } }))
      .toMatchObject({ pausedPollSec: 120, source: 'env', invalid: ['tool.pausedPollSec=2147484'] });
  });

  it('loads the same platform and tool layers as launch policy and reports their source', () => {
    const options = { readFile: () => JSON.stringify({ builder: { pausedPollSec: 90 } }), toolSettings: {}, env: {} };
    expect(loadBuilderPausedPollPolicy(options)).toMatchObject({ pausedPollSec: 90, source: 'platform' });
    const tool = loadBuilderPausedPollPolicy({ ...options, toolSettings: { builder: { pausedPollSec: 120 } } });
    expect(formatBuilderPausedPollPolicyLine(tool)).toBe('builder paused policy: pausedPollSec=120 (tool)');
    const missing = () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; };
    expect(loadBuilderPausedPollPolicy({ ...options, readFile: missing })).toEqual({ pausedPollSec: 600, source: 'standard', invalid: [] });
    expect(loadBuilderPausedPollPolicy({ ...options, readFile: () => '{' }).invalid).toEqual([expect.stringContaining('platform file unreadable')]);
  });
});
