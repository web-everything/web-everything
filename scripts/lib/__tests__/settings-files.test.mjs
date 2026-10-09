/**
 * @file scripts/lib/__tests__/settings-files.test.mjs
 * @description Held item 168 — per-feature settings files (we:scripts/lib/settings-files.mjs). The merge rule, the
 *   on-disk layout guard (the legacy we:scripts/dispatch-settings.json is frozen; a new key goes in
 *   we:scripts/settings/<feature>.json), and that moving the push-on-green keys out changed no resolved value.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeSettingsLayers, readDeclaredSettings, readSettings, settingsLeaves,
  LEGACY_SETTINGS_LEAVES, LEGACY_SETTINGS_PATH, SETTINGS_DIR, FEATURE_FILE_RE,
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
    expect(extra, `new keys in scripts/dispatch-settings.json: ${extra.join(', ')} — put them in scripts/settings/<feature>.json instead (overlays conflict-drop on this one shared file)`).toEqual([]);
  });

  it('moving the push-on-green keys out changed no resolved value', () => {
    expect(resolveFixerSlotSettings({ env: {} })).toEqual({
      awaitVerifyLoopSeconds: 15, parkedReleasesSlot: true, parkedCapFactor: 2, releaseOnCompletion: true,
    });
    expect(readSettings().fixDispatch).toMatchObject({ borrowBuildSlots: 'on', borrowAfterMinutes: 15, borrowExecutor: 'codex' });
    expect(resolveHeavyAdmissionCap({ env: {} })).toBe(3);
    expect(resolveCpuIdleMinPct('build', { env: {} })).toBe(15);
    expect(readCostAdmissionSettings({ env: {} })).toBeTruthy();
  });
});
