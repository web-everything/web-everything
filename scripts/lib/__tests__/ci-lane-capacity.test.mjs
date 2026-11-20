// @vitest-environment node
const operatorFixture = vi.hoisted(() => ({ file: undefined }));
vi.mock('../operator-override-reader.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readOperatorOverrides: options => {
    if (!operatorFixture.file) throw Error('Test must inject a store path');
    return actual.readOperatorOverrides({ ...options, file: operatorFixture.file });
  } };
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCiHealReserve } from '../ci-heal-reserve.mjs';
import { resolveMaxConcurrentLanes } from '../lane-concurrency.mjs';

const leaves = [
  { key: 'ciHeal.reserve', envKey: 'WE_CI_HEAL_RESERVE', builtin: 6, max: 12,
    read: env => resolveCiHealReserve({ env }) },
  { key: 'lanes.maxConcurrent', envKey: 'WE_MAX_CONCURRENT_LANES', builtin: 12, max: 24,
    read: env => resolveMaxConcurrentLanes(env) },
];
let dir, preferences;
const seed = data => writeFileSync(operatorFixture.file, JSON.stringify(data));
const configure = (key, value) => {
  const [policy, leaf] = key.split('.');
  writeFileSync(preferences, JSON.stringify({ [policy]: { [leaf]: value } }));
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-lane-capacity-'));
  operatorFixture.file = join(dir, 'operator-overrides.json');
  preferences = join(dir, 'preferences.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.each(leaves)('$key bounded capacity', ({ key, envKey, builtin, max, read }) => {
  it('resolves override > environment > preferences file > built-in and rereads changes', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: preferences };
    expect(read(env)).toBe(builtin);
    configure(key, 2);
    expect(read(env)).toBe(2);
    env[envKey] = '3';
    expect(read(env)).toBe(3);
    seed({ [key]: max });
    expect(read(env)).toBe(max);
    const [policy, leaf] = key.split('.');
    seed({ [policy]: { [leaf]: 1 } });
    expect(read(env)).toBe(1);
    rmSync(operatorFixture.file);
    expect(read(env)).toBe(3);
  });

  const failures = [
    { name: 'corrupt store', setup: () => writeFileSync(operatorFixture.file, '{') },
    { name: 'unreadable store', setup: () => mkdirSync(operatorFixture.file) },
    { name: 'scalar store', setup: () => seed('bad') },
    ...['7', null, true, {}, [], NaN, Infinity].map(value => ({
      name: `wrong type ${String(value)}`, setup: () => seed({ [key]: value }),
    })),
    ...[0, -1, max + 1, 1.5].map(value => ({
      name: `out of range ${value}`, setup: () => seed({ [key]: value }),
    })),
    { name: 'unknown sibling key', setup: () => seed({ [`${key.split('.')[0]}.unknown`]: 1 }) },
    ...['0', 'bad', 'NaN', 'Infinity', String(max + 1), '1.5', '-1', '', ' '].map(envValue => ({
      name: `env zero/invalid ${JSON.stringify(envValue)}`, setup: () => {}, envValue,
    })),
  ];
  const lowerLayers = [
    { source: 'file', configured: 2 }, { source: 'file', configured: max },
    { source: 'env', configured: 2 }, { source: 'env', configured: max },
  ];
  it.each(failures.flatMap(failure => lowerLayers.map(lower => ({ ...failure, ...lower }))))
  ('$name with $source=$configured never exceeds the stricter configured/built-in bound',
    ({ setup, envValue, source, configured }) => {
      configure(key, source === 'file' || envValue !== undefined ? configured : max);
      const env = { WE_PLATFORM_PREFERENCES_FILE: preferences };
      if (source === 'env') env[envKey] = String(configured);
      if (envValue !== undefined) env[envKey] = envValue;
      setup();
      const value = read(env);
      const bound = Math.min(configured, builtin);
      expect(value).toBeLessThanOrEqual(bound);
      expect(value).toBe(bound);
      expect(Number.isInteger(value) && value >= 1).toBe(true);
    });

  it.each(['7', 0, max + 1, {}])('invalid file leaf %j cannot retain a looser env value', fileValue => {
    configure(key, fileValue);
    expect(read({ WE_PLATFORM_PREFERENCES_FILE: preferences, [envKey]: String(max) })).toBe(builtin);
  });

  it('valid override wins despite invalid siblings and invalid environment evidence', () => {
    configure(key, 2);
    seed({ [key]: max, [`${key.split('.')[0]}.unknown`]: 1, 'host.unknown': 1 });
    expect(read({ WE_PLATFORM_PREFERENCES_FILE: preferences, [envKey]: 'bad' })).toBe(max);
  });

  it('invalid key in another policy preserves this valid override', () => {
    seed({ [key]: max, 'host.maxReviewDispatchPerTick': 'bad' });
    expect(read({ WE_PLATFORM_PREFERENCES_FILE: preferences, [envKey]: '2' })).toBe(max);
  });

  it('logs effective value and operator provenance', () => {
    seed({ [key]: max });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(read({ WE_PLATFORM_PREFERENCES_FILE: preferences, WE_POLICY_CASCADE_LOG: '1' })).toBe(max);
      expect(log.mock.calls.flat().join(' ')).toContain(`${key}=${max} (operator-db)`);
    } finally { log.mockRestore(); }
  });
});
