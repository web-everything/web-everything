/**
 * Contract vectors for the `webeverything.config` author surface (#1702 / #1662; carved #1780).
 *
 * WE-resident half: the author surface + schema guards only — `defineConfig` validation/identity,
 * `extendsFlavor` descriptor shape, and the two entry guards. The **resolver runtime** tests
 * (nearest-wins, error cases, the autoDefine end-to-end demo, the discovery view) live with the impl in
 * **FUI** (`config/__tests__/config-resolve.test.ts` there), since the runtime is standard impl (#1282).
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLATFORM_DELIVERY_POLICY_DEFAULTS } from '../platformDefaults';
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


describe('delivery policy contract (#5113)', () => {
  const defaults = {
    prCi: { mainStateParity: 'on' },
    mergeGate: { recheckWhenMainMoved: 'if-older-than-N-min', recheckMaxAgeMin: 30, onMainRed: 'halt' },
    dispatchGate: { overlapOverride: 'off' },
    heavyQueue: { priority: 'repairs-first', reservedForRepairs: 1, reservedBorrowAfterMin: 10 },
    drain: { onStepRefusal: 'alert' },
  };
  const values = {
    prCi: { mainStateParity: ['on', 'off'] },
    mergeGate: { recheckWhenMainMoved: ['if-older-than-N-min', 'always', 'off'], recheckMaxAgeMin: [1, 30], onMainRed: ['halt', 'warn', 'off'] },
    dispatchGate: { overlapOverride: ['off', 'logged', 'free'] },
    heavyQueue: { priority: ['repairs-first', 'fifo'], reservedForRepairs: [0, 1, 2], reservedBorrowAfterMin: [1, 10] },
    drain: { onStepRefusal: ['alert', 'log'] },
  };

  it('types every listed value in complete and partial inline policies and extendsFlavor overrides through the public barrel', () => {
    const fixture = resolve('config/__tests__/delivery-policy-contract.fixture.ts');
    const names = { prCi: 'PrCiPolicyValue', mergeGate: 'MergeGatePolicyValue', dispatchGate: 'DispatchGatePolicyValue', heavyQueue: 'HeavyQueuePolicyValue', drain: 'DrainPolicyValue' };
    const lines = [`import { defineConfig, extendsFlavor, type WebEverythingConfig, ${Object.values(names).map(name => `type ${name}`).join(', ')} } from '../index';`];
    for (const [dimension, fields] of Object.entries(values)) {
      lines.push(`const ${dimension}: ${names[dimension as keyof typeof names]} = ${JSON.stringify(defaults[dimension as keyof typeof defaults])};`);
      lines.push(`defineConfig({ ${dimension}: {} });`);
      for (const [field, options] of Object.entries(fields)) {
        for (const value of options) {
          const inline = { ...defaults[dimension as keyof typeof defaults], [field]: value };
          lines.push(`defineConfig({ ${dimension}: ${JSON.stringify(inline)} });`);
          lines.push(`defineConfig({ ${dimension}: ${JSON.stringify({ [field]: value })} });`);
          lines.push(`const partial_${dimension}_${field}_${options.indexOf(value)}: WebEverythingConfig = { ${dimension}: ${JSON.stringify({ [field]: value })} };`);
          lines.push(`defineConfig({ ${dimension}: extendsFlavor('platform', ${JSON.stringify({ [field]: value })}) });`);
        }
        lines.push(`// @ts-expect-error invalid policy field must be rejected even with the open dimension index`);
        lines.push(`const invalid_${dimension}_${field}: WebEverythingConfig = { ${dimension}: { ...${dimension}, ${field}: 'unknown' } };`);
      }
    }
    const host = ts.createCompilerHost({});
    // Module discovery must stay in this checkout rather than probing sibling lanes for ambient types.
    const directoryExists = host.directoryExists!.bind(host);
    host.directoryExists = directory => directory.startsWith(process.cwd()) && directoryExists(directory);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fixture
      ? ts.createSourceFile(name, lines.join('\n'), languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([fixture], { types: [], noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }, host);
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    for (const [dimension, fields] of Object.entries(values)) {
      for (const [field, options] of Object.entries(fields)) {
        for (const value of options) {
          const config = { [dimension]: { ...defaults[dimension as keyof typeof defaults], [field]: value } };
          expect(defineConfig(config)).toBe(config);
          const partial = { [dimension]: { [field]: value } };
          expect(defineConfig(partial)).toBe(partial);
          const descriptor = extendsFlavor('platform', { [field]: value });
          expect(defineConfig({ [dimension]: descriptor })[dimension]).toBe(descriptor);
        }
      }
    }
  });

  it('equals all nine Defaults-column values exactly', () => {
    expect(PLATFORM_DELIVERY_POLICY_DEFAULTS).toEqual(defaults);
  });

  it('replays the failure with halt, alert and overlap override off by default', () => {
    expect(PLATFORM_DELIVERY_POLICY_DEFAULTS?.mergeGate.onMainRed).toBe('halt');
    expect(PLATFORM_DELIVERY_POLICY_DEFAULTS?.drain.onStepRefusal).toBe('alert');
    expect(PLATFORM_DELIVERY_POLICY_DEFAULTS?.dispatchGate.overlapOverride).toBe('off');
  });

  it('has only type imports so ungated modules cannot supply default values', () => {
    const source = ts.createSourceFile('deliveryPolicyDefaults.ts', readFileSync(resolve('config/deliveryPolicyDefaults.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = source.statements.filter(ts.isImportDeclaration);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every(node => node.importClause?.isTypeOnly === true)).toBe(true);
    expect(source.statements.some(node => ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)).toBe(false);
    expect(source.parseDiagnostics).toEqual([]);
  });
});
