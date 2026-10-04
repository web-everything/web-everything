/**
 * Contract vectors for the `webeverything.config` author surface (#1702 / #1662; carved #1780).
 *
 * WE-resident half: the author surface + schema guards only — `defineConfig` validation/identity,
 * `extendsFlavor` descriptor shape, and the two entry guards. The **resolver runtime** tests
 * (nearest-wins, error cases, the autoDefine end-to-end demo, the discovery view) live with the impl in
 * **FUI** (`config/__tests__/config-resolve.test.ts` there), since the runtime is standard impl (#1282).
 */
import { describe, it, expect } from 'vitest';
import {
  defineConfig,
  extendsFlavor,
  isExtendsFlavorDescriptor,
  isDimensionPointer,
  InvalidConfigEntryError,
} from '../defineConfig';
import { PLATFORM_FLAVOR_DEFAULTS, PLATFORM_CROSS_PROVIDER_FALLBACK_WAIT_TIMEOUT_MS } from '../platformDefaults';

describe('defineConfig — validation + identity', () => {
  it('returns the config unchanged (identity) for inference', () => {
    const cfg = { autoDefine: extendsFlavor('strict-explicit') };
    expect(defineConfig(cfg)).toBe(cfg);
  });

  it('accepts inline objects and string pointers per dimension', () => {
    expect(() =>
      defineConfig({
        autoDefine: extendsFlavor('lazy-dom'),
        theme: './config/theme.config.ts', // string pointer (extract-to-own-file)
        renderStrategy: { mode: 'eager-sync' }, // inline value
      }),
    ).not.toThrow();
  });

  // #2523: the list-virtualization strategy is a config dimension (native content-visibility default +
  // an opt-in js-windowing strategy), selected per project without the surface re-deciding.
  it('accepts a windowedCollection dimension entry (native default or an opt-in js-windowing strategy)', () => {
    expect(() => defineConfig({ windowedCollection: extendsFlavor('js-windowing') })).not.toThrow();
    expect(() => defineConfig({ windowedCollection: { strategy: 'content-visibility' } })).not.toThrow();
    expect(() => defineConfig({ windowedCollection: './config/virtualization.config.ts' })).not.toThrow();
  });

  it('#2523: the windowedCollection platform default is native-first (content-visibility)', () => {
    expect(PLATFORM_FLAVOR_DEFAULTS.windowedCollection).toBe('content-visibility');
  });

  // xb1e9nj: cross-provider seat fallback is a config dimension, default wait-then-park.
  it('accepts a crossProviderFallback entry for each of the three policies plus a wait timeout', () => {
    for (const policy of ['park-now', 'wait-then-park', 'same-provider-other-model'] as const) {
      expect(() => defineConfig({ crossProviderFallback: { policy, waitTimeoutMs: 1000 } })).not.toThrow();
    }
    expect(() => defineConfig({ crossProviderFallback: extendsFlavor('park-now') })).not.toThrow();
  });

  it('xb1e9nj: the crossProviderFallback platform default is wait-then-park, never same-provider-other-model', () => {
    expect(PLATFORM_FLAVOR_DEFAULTS.crossProviderFallback).toBe('wait-then-park');
    expect(PLATFORM_FLAVOR_DEFAULTS.crossProviderFallback).not.toBe('same-provider-other-model');
    expect(PLATFORM_CROSS_PROVIDER_FALLBACK_WAIT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('ignores omitted/undefined dimensions', () => {
    expect(() => defineConfig({ autoDefine: undefined })).not.toThrow();
  });

  it('throws InvalidConfigEntryError when a dimension is neither object nor string', () => {
    // @ts-expect-error — a number is not a valid entry
    expect(() => defineConfig({ autoDefine: 42 })).toThrow(InvalidConfigEntryError);
    // @ts-expect-error — null is not a valid entry
    expect(() => defineConfig({ theme: null })).toThrow(InvalidConfigEntryError);
  });

  it('throws when the root is not an object', () => {
    // @ts-expect-error — not a config object
    expect(() => defineConfig(null)).toThrow(InvalidConfigEntryError);
  });
});

describe('extendsFlavor — descriptor shape', () => {
  it('wraps a single flavor id into a one-element ordered list', () => {
    const d = extendsFlavor('strict-explicit');
    expect(d.kind).toBe('extends-flavor');
    expect(d.flavors).toEqual(['strict-explicit']);
    expect(d.overrides).toBeUndefined();
    expect(isExtendsFlavorDescriptor(d)).toBe(true);
  });

  it('preserves multi-base order (nearest-first) and overrides', () => {
    const d = extendsFlavor(['lazy-dom', 'strict-explicit'], { defaultKey: 'explicit' });
    expect(d.flavors).toEqual(['lazy-dom', 'strict-explicit']);
    expect(d.overrides).toEqual({ defaultKey: 'explicit' });
  });

  it('throws on an empty flavor chain', () => {
    expect(() => extendsFlavor([] as string[])).toThrow();
  });

  it('the two guards distinguish descriptor / pointer / plain', () => {
    expect(isExtendsFlavorDescriptor(extendsFlavor('x'))).toBe(true);
    expect(isExtendsFlavorDescriptor({ foo: 1 })).toBe(false);
    expect(isDimensionPointer('./a.ts')).toBe(true);
    expect(isDimensionPointer({})).toBe(false);
  });
});
