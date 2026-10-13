import { describe, expect, it } from 'vitest';
import {
  defineConfig,
  extendsFlavor,
  PLATFORM_BACKLOG_ID_BUILT_VALUES,
  PLATFORM_FLAVOR_DEFAULTS,
  type BacklogIdNumberingSetting,
  type BacklogIdReachSetting,
} from '../index';
import {
  BACKLOG_ID_DEFAULTS,
  BACKLOG_ID_BUILT_VALUES,
  resolveBacklogIdSetting,
} from '../../scripts/lib/backlog-id-settings.mjs';

const dimensions = [
  ['backlogIdNumbering', 'producer-at-pr-open', 'integration-branch'],
  ['backlogIdReach', 'tip-tree', 'full-history-squash'],
] as const;

describe.each(dimensions)('%s', (dimension, defaultValue, unbuiltValue) => {
  it('resolves a silent project config to the platform default', () => {
    expect(resolveBacklogIdSetting(dimension, defineConfig({}))).toEqual({ ok: true, value: defaultValue });
  });

  it('reads inline values and gives overrides precedence over the nearest flavor', () => {
    for (const entry of [defaultValue, extendsFlavor(unbuiltValue, defaultValue)]) {
      const config = defineConfig({ [dimension]: entry });
      expect(resolveBacklogIdSetting(dimension, config)).toEqual({ ok: true, value: defaultValue });
    }
    expect(resolveBacklogIdSetting(dimension, defineConfig({
      [dimension]: extendsFlavor([defaultValue, unbuiltValue]),
    }))).toEqual({ ok: true, value: defaultValue });
  });

  it('refuses the unbuilt value by name, including when selected by override or nearest flavor', () => {
    for (const entry of [unbuiltValue, extendsFlavor(defaultValue, unbuiltValue), extendsFlavor([unbuiltValue, defaultValue])]) {
      const result = resolveBacklogIdSetting(dimension, defineConfig({ [dimension]: entry }));
      expect(result).toEqual({ ok: false, refusal: 'unbuilt-value', value: unbuiltValue, reason: expect.stringContaining(unbuiltValue) });
      expect(result.value).not.toBe(defaultValue);
    }
  });

  it('refuses unknown descriptor and object values without falling back', () => {
    const entries = [
      extendsFlavor('bogus'),
      extendsFlavor(defaultValue, 'bogus'),
      extendsFlavor(defaultValue, null),
      extendsFlavor(defaultValue, {}),
      {},
      { value: defaultValue },
      { kind: 'extends-flavor', flavors: [] },
      { kind: 'extends-flavor', flavors: defaultValue },
      { kind: 'extends-flavor' },
    ];
    for (const entry of entries) {
      const result = resolveBacklogIdSetting(dimension, { [dimension]: entry });
      expect(result).toMatchObject({ ok: false, refusal: 'unknown-value', reason: expect.any(String) });
      expect(result.value).not.toBe(defaultValue);
    }
    expect(resolveBacklogIdSetting(dimension, { [dimension]: extendsFlavor('bogus') }).reason).toContain('bogus');
  });

  it('refuses pointers and unreadable entries without falling back', () => {
    for (const entry of ['./settings.ts', 'bogus', null, 42, false, [], [defaultValue], undefined]) {
      const result = resolveBacklogIdSetting(dimension, { [dimension]: entry });
      expect(result).toMatchObject({ ok: false, refusal: 'unreadable-entry', value: entry, reason: expect.any(String) });
      expect(result.value).not.toBe(defaultValue);
    }
  });

  it('keeps hostile pointer and descriptor diagnostics on one line without backticks', () => {
    const hostile = 'bogus\n\r`value`\u2028next\u2029line';
    for (const entry of [hostile, extendsFlavor(hostile), { value: hostile }]) {
      const result = resolveBacklogIdSetting(dimension, { [dimension]: entry });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('bogus');
      expect(result.reason).not.toMatch(/[\r\n\u2028\u2029`]/);
    }
  });

  it('refuses unreadable project configs', () => {
    for (const config of [null, undefined, [], 42, 'settings.ts']) {
      expect(resolveBacklogIdSetting(dimension, config)).toMatchObject({ ok: false, refusal: 'unreadable-entry' });
    }
  });
});

describe('backlog ID contract', () => {
  it('pins tooling mirrors to the public data declarations and only the two built defaults', () => {
    expect(BACKLOG_ID_DEFAULTS).toEqual({
      backlogIdNumbering: PLATFORM_FLAVOR_DEFAULTS.backlogIdNumbering,
      backlogIdReach: PLATFORM_FLAVOR_DEFAULTS.backlogIdReach,
    });
    expect(PLATFORM_BACKLOG_ID_BUILT_VALUES).toEqual({
      backlogIdNumbering: ['producer-at-pr-open'],
      backlogIdReach: ['tip-tree'],
    });
    expect(BACKLOG_ID_BUILT_VALUES).toEqual(PLATFORM_BACKLOG_ID_BUILT_VALUES);
    expect(BACKLOG_ID_BUILT_VALUES.backlogIdNumbering).not.toContain('integration-branch');
    expect(BACKLOG_ID_BUILT_VALUES.backlogIdReach).not.toContain('full-history-squash');
  });

  it('declares both unbuilt values on the author surface and resolves dimensions independently', () => {
    const numbering: BacklogIdNumberingSetting = 'integration-branch';
    const reach: BacklogIdReachSetting = 'full-history-squash';
    const configs = [
      defineConfig({ backlogIdNumbering: extendsFlavor(numbering) }),
      defineConfig({ backlogIdReach: extendsFlavor(reach) }),
    ];
    for (const [index, [dimension, defaultValue, unbuiltValue]] of dimensions.entries()) {
      expect(resolveBacklogIdSetting(dimension, configs[index])).toMatchObject({ ok: false, value: unbuiltValue });
      expect(resolveBacklogIdSetting(dimension, configs[1 - index])).toEqual({ ok: true, value: defaultValue });
    }
  });
});
