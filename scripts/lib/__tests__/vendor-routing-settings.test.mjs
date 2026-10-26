import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readVendorRoutingSettings, resolveVendorForTask, VENDORS, VENDOR_TASK_TYPES,
} from '../vendor-routing-settings.mjs';
import { resetCascadeLogForTest } from '../policy-cascade.mjs';
import { FEATURE_FILE_RE, readDeclaredSettings, SETTINGS_DIR } from '../settings-files.mjs';

const defaults = {
  'backlog-sort': 'gemini', 'backlog-triage': 'gemini', 'prepare-research': 'gemini',
  'second-opinion-audit': 'gemini', 'report-draft': 'gemini',
  'code-edit': 'codex', 'test-fix': 'codex', build: 'codex',
  judgment: 'claude', decision: 'claude', 'design-review': 'claude', orchestration: 'claude',
};
const base = { env: {}, read: () => ({}), platform: {} };
const block = byTaskType => ({ byTaskType });
afterEach(() => resetCascadeLogForTest());

describe('vendor routing settings', () => {
  it('exports the complete task and vendor vocabularies', () => {
    expect(VENDOR_TASK_TYPES).toEqual(Object.keys(defaults));
    expect(VENDORS).toEqual(['gemini', 'codex', 'claude']);
  });

  it.each(Object.entries(defaults))('defaults %s to %s and reports standard source', (task, vendor) => {
    expect(resolveVendorForTask(task, base)).toEqual({ vendor, source: 'standard' });
  });

  it('allows a platform override per leaf without losing other defaults', () => {
    const result = readVendorRoutingSettings({ ...base, platform: block({ build: 'gemini' }) });
    expect(result.value).toEqual({ ...defaults, build: 'gemini' });
    expect(result.sources.build).toBe('platform');
    expect(result.sources.judgment).toBe('standard');
  });

  it('reads the platform vendorRouting key through the shared preference loader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-routing-'));
    try {
      const path = join(dir, 'preferences.json');
      writeFileSync(path, JSON.stringify({ vendorRouting: block({ build: 'claude' }) }));
      expect(resolveVendorForTask('build', {
        env: { WE_PLATFORM_PREFERENCES_FILE: path }, read: base.read,
      })).toEqual({ vendor: 'claude', source: 'platform' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('lets tool settings override platform preferences and reports tool source', () => {
    expect(resolveVendorForTask('build', {
      ...base, platform: block({ build: 'gemini' }),
      read: () => ({ vendorRouting: block({ build: 'claude' }) }),
    })).toEqual({ vendor: 'claude', source: 'tool' });
  });

  it('lets environment override tool per leaf and logs the effective vendor and source', () => {
    const lines = [];
    const result = readVendorRoutingSettings({
      ...base, platform: block({ judgment: 'codex' }),
      read: () => ({ vendorRouting: block({ build: 'claude' }) }),
      env: { WE_VENDOR_ROUTING: '{"build":"gemini"}', WE_POLICY_CASCADE_LOG: '1' },
      log: line => lines.push(line),
    });
    expect(result.value).toEqual({ ...defaults, build: 'gemini', judgment: 'codex' });
    expect(result.sources.build).toBe('env');
    expect(result.sources.judgment).toBe('platform');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('vendorRouting.byTaskType:');
    expect(lines[0]).toContain('build="gemini" (env)');
  });

  it('ignores invalid vendors and unknown tasks at every layer, retaining lower leaves', () => {
    const result = readVendorRoutingSettings({
      ...base,
      platform: block({ build: 'claude', judgment: 'invalid', unknown: 'gemini' }),
      read: () => ({ vendorRouting: block({ build: false, judgment: 'codex', unknown: 'claude' }) }),
      env: { WE_VENDOR_ROUTING: '{"build":"remote","judgment":null,"unknown":"codex","code-edit":"claude"}' },
    });
    expect(result.value).toEqual({ ...defaults, build: 'claude', judgment: 'codex', 'code-edit': 'claude' });
    expect(result.sources.build).toBe('platform');
    expect(result.sources.judgment).toBe('tool');
    expect(result.sources['code-edit']).toBe('env');
    expect(result.sources).not.toHaveProperty('unknown');
  });

  it.each(['{', 'null', '[]', '42', '"codex"', '{"build":{}}'])('ignores malformed env %s and unreadable tool settings', raw => {
    expect(resolveVendorForTask('build', {
      ...base, platform: block({ build: 'claude' }), env: { WE_VENDOR_ROUTING: raw },
      read: () => { throw new Error('unreadable'); },
    })).toEqual({ vendor: 'claude', source: 'platform' });
  });

  it.each([null, [], 'codex', { byTaskType: [] }, { byTaskType: 'codex' }])('ignores malformed platform/tool blocks %j', value => {
    expect(readVendorRoutingSettings({ ...base, platform: value, read: () => ({ vendorRouting: value }) }).value)
      .toEqual(defaults);
  });

  it.each(['unknown', '__proto__', 'constructor', '', null, undefined])('returns null for unknown task %s', task => {
    expect(resolveVendorForTask(task, base)).toBeNull();
  });

  it('discovers the tool file automatically and preserves the settings layout guards', () => {
    const declared = readDeclaredSettings();
    expect(declared.sources).toContain('settings/vendor-routing.json');
    expect(declared.errors).toEqual([]);
    expect(declared.duplicates).toEqual([]);
    for (const name of readdirSync(SETTINGS_DIR)) expect(name).toMatch(FEATURE_FILE_RE);
    const file = JSON.parse(readFileSync(join(SETTINGS_DIR, 'vendor-routing.json'), 'utf8'));
    expect(Object.keys(file).sort()).toEqual(['$comment', 'vendorRouting']);
    expect(file.vendorRouting).toEqual(block({}));
    expect(declared.settings.vendorRouting).toEqual(block({}));
  });
});
