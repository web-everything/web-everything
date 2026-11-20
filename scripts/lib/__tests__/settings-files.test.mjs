/**
 * @file scripts/lib/__tests__/settings-files.test.mjs
 * @description Held item 168 — per-feature settings files (we:scripts/lib/settings-files.mjs). The merge rule, the
 *   on-disk layout guard (the legacy we:scripts/dispatch-settings.json is frozen; a new key goes in
 *   we:scripts/settings/<feature>.json), and that the merged read resolves the same values.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  mergeSettingsLayers, readDeclaredSettings, readSettings, readSettingsChecked, settingsLeaves,
  SETTING_KEY_CLASSES, SETTING_CLASSES, settingKeyClass,
  LEGACY_SETTINGS_LEAVES, LEGACY_SETTINGS_PATH, SETTINGS_DIR, FEATURE_FILE_RE, LEGACY_ONLY_READERS, LEGACY_FILE_GUARD_HINT,
} from '../settings-files.mjs';
import { resolveFixerSlotSettings } from '../../conveyor/fixer-slot-rules.mjs';
import { readCostAdmissionSettings } from '../cost-admission-facts.mjs';
import { resolveHeavyAdmissionCap, resolveCpuIdleMinPct } from '../dispatch-throttle.mjs';

describe('mergeSettingsLayers — pure', () => {
  it('deep-merges plain objects key by key; later layers win on scalars', () => {
    const { settings, owners, duplicates } = mergeSettingsLayers([
      { source: 'legacy', data: { fixDispatch: { borrowBuildSlots: 'on' }, cap: 3 } },
      { source: 'settings/a.json', data: { fixDispatch: { awaitVerifyLoopSeconds: 15 } } },
    ]);
    expect(settings).toEqual({ fixDispatch: { borrowBuildSlots: 'on', awaitVerifyLoopSeconds: 15 }, cap: 3 });
    expect(owners['fixDispatch.awaitVerifyLoopSeconds']).toBe('settings/a.json');
    expect(duplicates).toEqual([]);
  });

  it('reports a leaf set by two files instead of silently picking one', () => {
    const { settings, duplicates } = mergeSettingsLayers([
      { source: 'settings/a.json', data: { x: { y: 1 } } },
      { source: 'settings/b.json', data: { x: { y: 2 } } },
    ]);
    expect(settings.x.y).toBe(2);
    expect(duplicates).toEqual([{ path: 'x.y', sources: ['settings/a.json', 'settings/b.json'] }]);
  });

  it('a top-level $comment is documentation: two feature files each carrying one is not a duplicate leaf', () => {
    const { duplicates, owners } = mergeSettingsLayers([
      { source: 'settings/a.json', data: { $comment: 'about a', a: 1 } },
      { source: 'settings/b.json', data: { $comment: 'about b', b: 2 } },
    ]);
    expect(duplicates).toEqual([]);
    expect(Object.keys(owners).sort()).toEqual(['a', 'b']);
    expect(settingsLeaves({ $comment: 'x', n: { $comment: 'y' } })).toEqual(['n.$comment']);
  });

  it('never lets a settings file write onto Object.prototype (__proto__ / constructor / prototype keys)', () => {
    const data = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},"ok":{"v":1}}');
    const { settings, owners } = mergeSettingsLayers([{ source: 'settings/x.json', data }]);
    expect({}.polluted).toBeUndefined();
    expect({}.polluted2).toBeUndefined();
    expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
    expect(Object.keys(settings).sort()).toEqual(['constructor', 'ok']);
    expect(Object.keys(owners).sort()).toEqual(['constructor.prototype.polluted2', 'ok.v']);
    expect(settingsLeaves(data).sort()).toEqual(['constructor.prototype.polluted2', 'ok.v']);
  });

  it('a top-level $comment owns no leaf, so two feature files may each carry one', () => {
    const { duplicates, owners } = mergeSettingsLayers([
      { source: 'settings/a.json', data: { $comment: 'about a', a: 1 } },
      { source: 'settings/b.json', data: { $comment: 'about b', b: 2 } },
    ]);
    expect(duplicates).toEqual([]);
    expect(Object.keys(owners).sort()).toEqual(['a', 'b']);
    expect(settingsLeaves({ $comment: 'x', n: { $comment: 'nested' } })).toEqual(['n.$comment']);
  });

  it('a leaf named like an Object.prototype member is not a false duplicate', () => {
    const { duplicates } = mergeSettingsLayers([
      { source: 'settings/a.json', data: { toString: 1 } },
      { source: 'settings/b.json', data: { hasOwnProperty: 2 } },
    ]);
    expect(duplicates).toEqual([]);
  });

  it('skips non-object layers and never mutates its inputs', () => {
    const a = { k: { v: 1 } };
    const { settings } = mergeSettingsLayers([{ source: 'a', data: a }, { source: 'b', data: null }, { source: 'c', data: [1] }]);
    settings.k.v = 9;
    expect(a.k.v).toBe(1);
  });
});

describe('readDeclaredSettings — IO', () => {
  it('reads the legacy file first, then every feature file sorted; a broken file is named, not fatal', () => {
    const d = mkdtempSync(join(tmpdir(), 'settings-files-'));
    try {
      const dir = join(d, 'settings');
      mkdirSync(dir);
      writeFileSync(join(d, 'legacy.json'), JSON.stringify({ fixDispatch: { borrowBuildSlots: 'on' } }));
      writeFileSync(join(dir, 'b-feature.json'), JSON.stringify({ fixDispatch: { parkedCapFactor: 2 } }));
      writeFileSync(join(dir, 'a-feature.json'), JSON.stringify({ freeze: { mainRed: 'on' } }));
      writeFileSync(join(dir, 'broken.json'), '{ nope');
      const r = readDeclaredSettings({ dir, legacyPath: join(d, 'legacy.json') });
      expect(r.sources).toEqual(['dispatch-settings.json', 'settings/a-feature.json', 'settings/b-feature.json']);
      expect(r.settings).toEqual({ fixDispatch: { borrowBuildSlots: 'on', parkedCapFactor: 2 }, freeze: { mainRed: 'on' } });
      expect(r.errors.map((e) => e.source)).toEqual(['settings/broken.json']);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('a missing folder and a missing legacy file give an empty object', () => {
    const r = readDeclaredSettings({ dir: '/nonexistent-settings-dir', legacyPath: '/nonexistent.json' });
    expect(r.settings).toEqual({});
    expect(r.errors).toEqual([]);
  });

  it('reports ENOTDIR using only the directory error message and preserves the legacy layer', () => {
    const d = mkdtempSync(join(tmpdir(), 'settings-files-'));
    try {
      const dir = join(d, 'settings');
      const legacyPath = join(d, 'legacy.json');
      const settings = { fixDispatch: { borrowBuildSlots: 'on' } };
      writeFileSync(dir, 'not a directory');
      writeFileSync(legacyPath, JSON.stringify(settings));
      let directoryError;
      try { readdirSync(dir); } catch (e) { directoryError = e; }
      expect(directoryError?.code).toBe('ENOTDIR');
      let r;
      expect(() => { r = readDeclaredSettings({ dir, legacyPath }); }).not.toThrow();
      expect(r).toEqual({
        ...mergeSettingsLayers([{ source: 'dispatch-settings.json', data: settings }]),
        sources: ['dispatch-settings.json'],
        errors: [{ source: 'settings/', error: directoryError.message }],
      });
      expect(readSettings({ dir, legacyPath })).toEqual(settings);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('a missing directory stays silent and preserves the legacy settings', () => {
    const d = mkdtempSync(join(tmpdir(), 'settings-files-'));
    try {
      const dir = join(d, 'missing-settings');
      const legacyPath = join(d, 'legacy.json');
      writeFileSync(legacyPath, JSON.stringify({ cap: 3 }));
      const r = readDeclaredSettings({ dir, legacyPath });
      expect(r.settings).toEqual({ cap: 3 });
      expect(r.errors).toEqual([]);
      expect(readSettings({ dir, legacyPath })).toEqual({ cap: 3 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it.skipIf(process.getuid?.() === 0)('an unreadable directory reports exactly one error without throwing', () => {
    const d = mkdtempSync(join(tmpdir(), 'settings-files-'));
    const dir = join(d, 'settings');
    mkdirSync(dir);
    try {
      const legacyPath = join(d, 'legacy.json');
      writeFileSync(legacyPath, JSON.stringify({ cap: 3 }));
      chmodSync(dir, 0o000);
      let r;
      expect(() => { r = readDeclaredSettings({ dir, legacyPath }); }).not.toThrow();
      expect(r.settings).toEqual({ cap: 3 });
      expect(r.errors).toEqual([{ source: 'settings/', error: expect.stringMatching(/^EACCES:/) }]);
      expect(readSettings({ dir, legacyPath })).toEqual({ cap: 3 });
    } finally {
      chmodSync(dir, 0o700);
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('readSettingsChecked — fail-closed evidence', () => {
  function fixture(run) {
    const root = mkdtempSync(join(tmpdir(), 'settings-checked-'));
    const dir = join(root, 'settings');
    const legacyPath = join(root, 'legacy.json');
    mkdirSync(dir);
    try { run({ root, dir, legacyPath }); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('clean reads select whole trees, subtrees and leaves with empty taint', () => fixture((options) => {
    writeFileSync(options.legacyPath, '{"fixDispatch":{"parkedCapFactor":2}}');
    writeFileSync(join(options.dir, 'a.json'), '{"fixDispatch":{"other":3},"cap":4}');
    expect(readSettingsChecked(options)).toEqual({
      value: { fixDispatch: { parkedCapFactor: 2, other: 3 }, cap: 4 }, taint: [], duplicates: [],
    });
    expect(readSettingsChecked({ ...options, namespace: 'fixDispatch' }).value).toEqual({ parkedCapFactor: 2, other: 3 });
    expect(readSettingsChecked({ ...options, namespace: 'fixDispatch.parkedCapFactor' }).value).toBe(2);
    for (const namespace of ['missing', 'toString', '__proto__.polluted']) {
      expect(readSettingsChecked({ ...options, namespace })).toEqual({ value: undefined, taint: [], duplicates: [] });
    }
  }));

  it('ENOENT directory and legacy file are silent; explicitly disabled legacy is silent', () => fixture((options) => {
    rmSync(options.dir, { recursive: true });
    expect(readSettingsChecked(options)).toEqual({ value: {}, taint: [], duplicates: [] });
    expect(readSettingsChecked({ ...options, legacyPath: null })).toEqual({ value: {}, taint: [], duplicates: [] });
  }));

  it('a listed feature returning ENOENT taints every namespace without changing legacy errors', () => fixture((options) => {
    writeFileSync(options.legacyPath, '{"cap":3}');
    // A dangling link deterministically exercises readdir success followed by read ENOENT.
    symlinkSync(join(options.root, 'vanished'), join(options.dir, 'gone.json'));
    expect(readdirSync(options.dir)).toEqual(['gone.json']);
    for (const namespace of ['', 'cap', 'unrelated.leaf']) {
      expect(readSettingsChecked({ ...options, namespace }).taint).toEqual([
        { source: 'settings/gone.json', reason: 'vanished' },
      ]);
    }
    expect(JSON.stringify(readDeclaredSettings(options))).toBe(JSON.stringify({
      ...mergeSettingsLayers([{ source: 'dispatch-settings.json', data: { cap: 3 } }]),
      sources: ['dispatch-settings.json'], errors: [],
    }));
    expect(JSON.stringify(readSettings(options))).toBe('{"cap":3}');
  }));

  it.each(['legacy', 'feature'])('dotted keys at any depth in %s taint every namespace once per file', (layer) => fixture((options) => {
    const data = { ['secret.'.repeat(100)]: 1 };
    const text = JSON.stringify({ nested: [{ ...data }, { deeper: { 'also.dotted': true } }], $comment: { 'doc.key': 2 } });
    const source = layer === 'legacy' ? 'dispatch-settings.json' : 'settings/x.json';
    writeFileSync(layer === 'legacy' ? options.legacyPath : join(options.dir, 'x.json'), text);
    for (const namespace of ['', 'nested', 'unrelated.leaf']) {
      expect(readSettingsChecked({ ...options, namespace }).taint).toEqual([{ source, reason: 'dotted key' }]);
    }
    const parsed = JSON.parse(text);
    expect(JSON.stringify(readDeclaredSettings(options))).toBe(JSON.stringify({
      ...mergeSettingsLayers([{ source, data: parsed }]), sources: [source], errors: [],
    }));
    expect(JSON.stringify(readSettings(options))).toBe(JSON.stringify(parsed));
  }));

  it.each(['legacy', 'feature'])('repeated decoded keys within %s taint every namespace without changing lenient bytes', (layer) => fixture((options) => {
    const source = layer === 'legacy' ? 'dispatch-settings.json' : 'settings/x.json';
    const path = layer === 'legacy' ? options.legacyPath : join(options.dir, 'x.json');
    for (const text of [
      '{"gate":{"enabled":false,"enabled":true}}',
      String.raw`{"gate":{"enabled":false,"\u0065nabled":true}}`,
      '{"list":[{"gate":false,"gate":true}],"other":{"gate":true}}',
      '{"gate":{"secret.key":false},"gate":true}',
      '{"__proto__":1,"__proto__":2}',
      String.raw`{"quote\"\\":1,"quote\u0022\u005c":2}`,
    ]) {
      writeFileSync(path, text);
      const taint = [
        ...(text.includes('secret.key') ? [{ source, reason: 'dotted key' }] : []),
        { source, reason: 'duplicate key in file' },
      ];
      for (const namespace of ['', 'gate', 'gate.enabled', 'unrelated.leaf']) {
        expect(readSettingsChecked({ ...options, namespace }).taint).toEqual(taint);
      }
      const historical = mergeSettingsLayers([{ source, data: JSON.parse(text) }]);
      expect(JSON.stringify(readDeclaredSettings(options))).toBe(JSON.stringify({ ...historical, sources: [source], errors: [] }));
      expect(JSON.stringify(readSettings(options))).toBe(JSON.stringify(historical.settings));
    }
  }));

  it('scanner ignores braces, key-like text, quotes and escapes in strings and keeps object key scopes separate', () => fixture((options) => {
    const data = {
      text: String.raw`{"gate":false,"gate":true} [ ] " \\ \" .`,
      'quote"\\': [{ gate: true }, { gate: false }, ['{', '}', '[', ']', '"gate":1']],
      gate: { text: 'same key in a different object', gate: true },
      empty: {}, list: [],
    };
    writeFileSync(join(options.dir, 'x.json'), JSON.stringify(data));
    expect(readSettingsChecked(options)).toEqual({ value: data, taint: [], duplicates: [] });
  }));

  it('ENOTDIR taints every namespace and reads no feature layer, preserving legacy evidence', () => fixture((options) => {
    rmSync(options.dir, { recursive: true });
    writeFileSync(options.dir, 'not a directory');
    writeFileSync(options.legacyPath, '{"cap":3}');
    for (const namespace of ['', 'cap', 'unrelated']) {
      const result = readSettingsChecked({ ...options, namespace });
      expect(result.taint).toEqual([{ source: 'settings/', reason: 'ENOTDIR' }]);
      expect(result.value).toEqual(namespace === '' ? { cap: 3 } : namespace === 'cap' ? 3 : undefined);
    }
  }));

  it.each(['feature', 'legacy'])('unreadable %s (EISDIR) taints even unrelated namespaces', (layer) => fixture((options) => {
    const path = layer === 'legacy' ? options.legacyPath : join(options.dir, 'x.json');
    mkdirSync(path);
    for (const namespace of ['', 'fixDispatch', 'unrelated.leaf']) {
      expect(readSettingsChecked({ ...options, namespace }).taint).toEqual([
        { source: layer === 'legacy' ? 'dispatch-settings.json' : 'settings/x.json', reason: 'EISDIR' },
      ]);
    }
  }));

  it.each(['feature', 'legacy'])('invalid JSON in %s uses a fixed reason without leaking file text', (layer) => fixture((options) => {
    const path = layer === 'legacy' ? options.legacyPath : join(options.dir, 'x.json');
    const text = '{"secret-marker-do-not-leak":"private-file-text", broken}';
    writeFileSync(path, text);
    const result = readSettingsChecked({ ...options, namespace: 'unrelated' });
    expect(result.taint).toEqual([
      { source: layer === 'legacy' ? 'dispatch-settings.json' : 'settings/x.json', reason: 'invalid JSON' },
    ]);
    expect(result.taint[0].reason).not.toMatch(/secret-marker|private-file-text|broken/);
    let historicalError;
    try { JSON.parse(text); } catch (e) { historicalError = String(e.message); }
    expect(readDeclaredSettings(options).errors[0].error).toBe(historicalError);
  }));

  it.each(['[]', 'null', '4', '"text"'])('non-object %s taints every namespace', (text) => fixture((options) => {
    writeFileSync(join(options.dir, 'x.json'), text);
    expect(readSettingsChecked({ ...options, namespace: 'unrelated' }).taint).toEqual([
      { source: 'settings/x.json', reason: 'not a JSON object' },
    ]);
  }));

  it('duplicates name every owner, drop the leaf, and filter by exact namespace boundary', () => fixture((options) => {
    writeFileSync(options.legacyPath, '{"fixDispatch":{"cap":1},"fixDispatchExtra":1}');
    writeFileSync(join(options.dir, 'a.json'), '{"fixDispatch":{"cap":2,"keep":true},"fixDispatchExtra":2}');
    writeFileSync(join(options.dir, 'b.json'), '{"fixDispatch":{"cap":3}}');
    const duplicate = { path: 'fixDispatch.cap', sources: ['dispatch-settings.json', 'settings/a.json', 'settings/b.json'] };
    const checked = readSettingsChecked({ ...options, namespace: 'fixDispatch' });
    expect(checked).toEqual({
      value: { keep: true }, duplicates: [duplicate],
      taint: [{ source: 'settings/b.json', reason: `duplicate leaf fixDispatch.cap: ${duplicate.sources.join(', ')}` }],
    });
    expect(readSettingsChecked(options).value).toEqual({ fixDispatch: { keep: true } });
    expect(readSettingsChecked({ ...options, namespace: 'fixDispatch.cap' })).toEqual({ ...checked, value: undefined });
    expect(readSettingsChecked({ ...options, namespace: 'fixDispatch.keep' })).toEqual({ value: true, taint: [], duplicates: [] });
    expect(readSettings(options)).toEqual({ fixDispatch: { cap: 3, keep: true }, fixDispatchExtra: 2 });
  }));

  it.each([
    [false, false], [false, true],
    [[], false], [[], true],
    [null, false], [null, true],
    ['disabled', false], ['disabled', true],
  ])('structural collision with %j (object first reversed: %s) drops the node and taints descendants', (leaf, reversed) => fixture((options) => {
    const values = reversed ? [leaf, { enabled: true }] : [{ enabled: true }, leaf];
    const layers = values.map((gate, i) => ({ source: `settings/${i === 0 ? 'a' : 'b'}.json`, data: { gate } }));
    for (const { source, data } of layers) writeFileSync(join(options.dir, source.slice('settings/'.length)), JSON.stringify(data));
    const duplicate = { path: 'gate', sources: layers.map(({ source }) => source) };
    const taint = [{ source: 'settings/b.json', reason: 'duplicate leaf gate: settings/a.json, settings/b.json' }];
    expect(readSettingsChecked(options)).toEqual({ value: {}, duplicates: [duplicate], taint });
    for (const namespace of ['gate', 'gate.enabled', 'gate.enabled.child']) {
      expect(readSettingsChecked({ ...options, namespace })).toEqual({ value: undefined, duplicates: [duplicate], taint });
    }
    expect(readSettingsChecked({ ...options, namespace: 'gateExtra.enabled' })).toEqual({ value: undefined, duplicates: [], taint: [] });
    // Pin the historical last-wins tree and its lack of structural duplicate evidence byte for byte.
    const historical = JSON.stringify({ settings: { gate: values[1] }, owners: Object.assign(Object.create(null),
      reversed ? { gate: 'settings/a.json', 'gate.enabled': 'settings/b.json' }
        : { 'gate.enabled': 'settings/a.json', gate: 'settings/b.json' }), duplicates: [] });
    expect(JSON.stringify(mergeSettingsLayers(layers))).toBe(historical);
    expect(JSON.stringify(readDeclaredSettings(options))).toBe(historical.slice(0, -1)
      + ',"sources":["settings/a.json","settings/b.json"],"errors":[]}');
    expect(JSON.stringify(readSettings(options))).toBe(JSON.stringify({ gate: values[1] }));
  }));

  it('structural collisions retain every object and leaf owner across later layers', () => fixture((options) => {
    writeFileSync(options.legacyPath, '{"gate":{"enabled":true}}');
    writeFileSync(join(options.dir, 'a.json'), '{"gate":false}');
    writeFileSync(join(options.dir, 'b.json'), '{"gate":{"other":true}}');
    const sources = ['dispatch-settings.json', 'settings/a.json', 'settings/b.json'];
    expect(readSettingsChecked({ ...options, namespace: 'gate.other' })).toEqual({
      value: undefined, duplicates: [{ path: 'gate', sources }],
      taint: [{ source: 'settings/b.json', reason: `duplicate leaf gate: ${sources.join(', ')}` }],
    });
  }));

  it('a duplicate leaf taints deeper namespaces using segment boundaries', () => fixture((options) => {
    writeFileSync(options.legacyPath, '{"gate":{"enabled":true,"enabledExtra":7}}');
    writeFileSync(join(options.dir, 'a.json'), '{"gate":{"enabled":false}}');
    const result = readSettingsChecked({ ...options, namespace: 'gate.enabled' });
    expect(result.value).toBeUndefined();
    expect(result.duplicates).toEqual([{ path: 'gate.enabled', sources: ['dispatch-settings.json', 'settings/a.json'] }]);
    expect(result.taint).toHaveLength(1);
    expect(readSettingsChecked({ ...options, namespace: 'gate.enabled.child' })).toEqual(result);
    expect(readSettingsChecked({ ...options, namespace: 'gate.enabledExtra' })).toEqual({ value: 7, duplicates: [], taint: [] });
  }));

  it('removes duplicate literal dotted keys without removing the nested path, while tainting every namespace', () => fixture((options) => {
    writeFileSync(options.legacyPath, '{"gate.enabled":1,"gate":{"enabled":true}}');
    writeFileSync(join(options.dir, 'a.json'), '{"gate.enabled":2}');
    const duplicate = { path: 'gate.enabled', sources: ['dispatch-settings.json', 'settings/a.json'] };
    const globalTaint = [
      { source: 'dispatch-settings.json', reason: 'dotted key' },
      { source: 'settings/a.json', reason: 'dotted key' },
    ];
    const taint = [...globalTaint, { source: 'settings/a.json', reason: 'duplicate leaf gate.enabled: dispatch-settings.json, settings/a.json' }];
    expect(readSettingsChecked(options)).toEqual({ value: { gate: { enabled: true } }, duplicates: [duplicate], taint });
    expect(readSettingsChecked({ ...options, namespace: 'gate.enabled' })).toEqual({ value: undefined, duplicates: [duplicate], taint });
    expect(readSettingsChecked({ ...options, namespace: 'gate' })).toEqual({ value: { enabled: true }, duplicates: [], taint: globalTaint });
    expect(readSettingsChecked({ ...options, namespace: 'gate.enabled.child' })).toEqual({ value: undefined, duplicates: [], taint: globalTaint });
  }));

  it('distinguishes a single literal dotted key from the same dotted nested path', () => fixture((options) => {
    writeFileSync(options.legacyPath, '{"gate.enabled":1}');
    writeFileSync(join(options.dir, 'a.json'), '{"gate":{"enabled":true}}');
    const taint = [{ source: 'dispatch-settings.json', reason: 'dotted key' }];
    expect(readSettingsChecked(options)).toEqual({ value: { 'gate.enabled': 1, gate: { enabled: true } }, duplicates: [], taint });
    expect(readSettingsChecked({ ...options, namespace: 'gate.enabled' })).toEqual({ value: 1, duplicates: [], taint });
    expect(readDeclaredSettings(options).duplicates).toEqual([{ path: 'gate.enabled', sources: ['dispatch-settings.json', 'settings/a.json'] }]);
  }));

  it('sorts taint by source then reason, including global failures and duplicate leaves', () => fixture((options) => {
    writeFileSync(options.legacyPath, '[]');
    writeFileSync(join(options.dir, 'z.json'), '{ bad');
    writeFileSync(join(options.dir, 'a.json'), '{"z":1,"a":1}');
    writeFileSync(join(options.dir, 'b.json'), '{"z":2,"a":2}');
    const expected = [
      { source: 'dispatch-settings.json', reason: 'not a JSON object' },
      { source: 'settings/b.json', reason: 'duplicate leaf a: settings/a.json, settings/b.json' },
      { source: 'settings/b.json', reason: 'duplicate leaf z: settings/a.json, settings/b.json' },
      { source: 'settings/z.json', reason: 'invalid JSON' },
    ];
    expect(readSettingsChecked(options).taint).toEqual(expected);
    expect(readSettingsChecked(options).taint).toEqual(expected);
  }));

  it('bounds oversized duplicate reasons at 200 characters while retaining full duplicate evidence', () => fixture((options) => {
    const path = 'x'.repeat(300);
    for (const name of ['a', 'b']) writeFileSync(join(options.dir, `${name}.json`), JSON.stringify({ [path]: 1 }));
    const result = readSettingsChecked(options);
    expect(result.value).toEqual({});
    expect(result.taint[0].reason).toHaveLength(200);
    expect(result.duplicates).toEqual([{ path, sources: ['settings/a.json', 'settings/b.json'] }]);
  }));

  it.each(['clean', 'invalid', 'array', 'duplicate', 'directory-error', 'missing'])('lenient output stays identical on %s fixtures', (kind) => fixture((options) => {
    writeFileSync(options.legacyPath, '{"cap":1}');
    if (kind === 'directory-error') {
      rmSync(options.dir, { recursive: true });
      writeFileSync(options.dir, 'file');
    } else if (kind === 'missing') rmSync(options.dir, { recursive: true });
    else writeFileSync(join(options.dir, 'a.json'), kind === 'invalid' ? '{ bad' : kind === 'array' ? '[]' : kind === 'duplicate' ? '{"cap":2}' : '{"other":2}');
    expect(JSON.stringify(readSettings(options))).toBe(JSON.stringify(readDeclaredSettings(options).settings));
  }));

  it('exports frozen, empty classification registry with unclassified own and prototype paths', () => {
    expect(SETTING_KEY_CLASSES).toEqual({});
    expect(Object.isFrozen(SETTING_KEY_CLASSES)).toBe(true);
    expect(SETTING_CLASSES).toEqual(['safety', 'tuning']);
    expect(Object.isFrozen(SETTING_CLASSES)).toBe(true);
    for (const path of ['fixDispatch.parkedCapFactor', 'toString', '__proto__']) expect(settingKeyClass(path)).toBeUndefined();
    const header = readFileSync(join(SETTINGS_DIR, '..', 'lib', 'settings-files.mjs'), 'utf8').split('*/')[0];
    expect(header).toMatch(/R969 F2: safety keys will REFUSE \(throw\) on taint; tuning keys use the default plus a health smell/);
    expect(header).toMatch(/empty in S1 and filled by S2/);
    expect(header).toMatch(/unlisted = unclassified/);
  });
});

describe('the real layout (we:scripts/settings/ + legacy dispatch-settings.json)', () => {
  const real = readDeclaredSettings();

  it('every file parses, and no leaf has two owner files', () => {
    expect(real.errors).toEqual([]);
    expect(real.duplicates).toEqual([]);
  });

  it('feature files are kebab-case <feature>.json objects', () => {
    for (const f of readdirSync(SETTINGS_DIR)) expect(f).toMatch(FEATURE_FILE_RE);
  });

  it('the legacy shared file holds only its frozen keys — a new setting goes in scripts/settings/<feature>.json', () => {
    const leaves = settingsLeaves(JSON.parse(readFileSync(LEGACY_SETTINGS_PATH, 'utf8')));
    const extra = leaves.filter((l) => !LEGACY_SETTINGS_LEAVES.includes(l));
    expect(extra, `new keys in scripts/dispatch-settings.json: ${extra.join(', ')} — ${LEGACY_FILE_GUARD_HINT}`).toEqual([]);
  });

  it('names every direct legacy-file reader, distinguishing declaration inventories from legacy-only runtime readers', () => {
    // Inventories inspect individual files for ownership, but also read scripts/settings/ through the checked
    // loader. Keep them out of LEGACY_ONLY_READERS: overlay-dropped uses that list to warn about lost settings.
    // settings-registry.test.mjs covers feature-file values, shared ownership and fail-closed checked reads.
    const declarationInventories = ['scripts/lib/settings-registry.mjs'];
    const root = join(SETTINGS_DIR, '..', '..');
    const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const direct = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mjs|cjs|js)$/.test(e.name)) {
          const rel = relative(root, p).split(sep).join('/');
          if (rel === 'scripts/lib/settings-files.mjs') continue;
          if (/['"`][^'"`\n]*dispatch-settings\.json['"`]|defaultDispatchSettingsPath/.test(stripComments(readFileSync(p, 'utf8')))) direct.push(rel);
        }
      }
    };
    walk(join(root, 'scripts'));
    expect(direct.sort(), 'an unclassified script reads scripts/dispatch-settings.json directly: runtime readers should use readSettings() (scripts/lib/settings-files.mjs); classify declaration inventories separately from LEGACY_ONLY_READERS').toEqual([...LEGACY_ONLY_READERS, ...declarationInventories].sort());
  });

  it('the legacy-file guard message does not promise that every reader sees scripts/settings/', () => {
    expect(LEGACY_FILE_GUARD_HINT).toMatch(/readSettings/);
    expect(LEGACY_FILE_GUARD_HINT).toMatch(/LEGACY_ONLY_READERS/);
  });

  it('the merged read resolves the same values as the single-file read did', () => {
    expect(resolveFixerSlotSettings({ env: {} })).toEqual({
      awaitVerifyLoopSeconds: 15, parkedReleasesSlot: true, parkedCapFactor: 2, releaseOnCompletion: true,
    });
    expect(readSettings().fixDispatch).toMatchObject({ borrowBuildSlots: 'on', borrowAfterMinutes: 15, borrowExecutor: 'codex', skipEmptySteps: true });
    expect(real.owners['fixDispatch.skipEmptySteps']).toBe('settings/fix-empty-steps.json');
    expect(resolveHeavyAdmissionCap({ env: {} })).toBe(3);
    expect(resolveCpuIdleMinPct('build', { env: {} })).toBe(15);
    expect(readCostAdmissionSettings({ env: {} })).toBeTruthy();
  });
});
