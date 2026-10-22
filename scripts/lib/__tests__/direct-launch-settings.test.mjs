import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_LAUNCH_PROVIDERS, GEMINI_MODES, resolveDirectLaunchSetting, formatDirectLaunchLog, directLaunchLogLine } from '../direct-launch-settings.mjs';
import { readDeclaredSettings } from '../settings-files.mjs';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const layer = (provider, mode, maxConcurrent) => ({ directLaunch: { build: { provider }, gemini: { mode, maxConcurrent } } });
const environment = (provider, mode, maxConcurrent) => ({
  WE_DIRECT_LAUNCH_BUILD_PROVIDER: provider,
  WE_DIRECT_LAUNCH_GEMINI_MODE: mode,
  WE_DIRECT_LAUNCH_GEMINI_MAX_CONCURRENT: maxConcurrent,
});
const resolve = options => resolveDirectLaunchSetting({ kind: 'build', env: {}, platform: {}, repo: {}, ...options });
const expected = (provider, mode, maxConcurrent, source) => ({
  kind: 'build', provider: { value: provider, source },
  gemini: { mode: { value: mode, source }, maxConcurrent: { value: maxConcurrent, source } },
});

describe('direct-launch settings (observation only)', () => {
  it('declares the allowed providers and modes and returns built-in defaults', () => {
    expect(DIRECT_LAUNCH_PROVIDERS).toEqual(['codex', 'antigravity-gemini', 'claude']);
    expect(GEMINI_MODES).toEqual(['trial', 'open']);
    expect(resolve()).toEqual(expected('codex', 'trial', 1, 'default'));
  });

  it.each([
    ['platform', { platform: layer('claude', 'open', 2) }, 'claude', 'open', 2],
    ['repo', { platform: layer('claude', 'open', 2), repo: layer('antigravity-gemini', 'trial', 3) }, 'antigravity-gemini', 'trial', 3],
    ['env', { platform: layer('claude', 'open', 2), repo: layer('antigravity-gemini', 'trial', 3), env: environment('codex', 'open', '4') }, 'codex', 'open', 4],
  ])('%s overrides all lower layers for each setting', (source, options, provider, mode, max) => {
    expect(resolve(options)).toEqual(expected(provider, mode, max, source));
  });

  for (const source of ['platform', 'repo', 'env']) {
    const withInvalid = (provider, mode, max) => {
      const options = source === 'platform' ? {} : source === 'repo'
        ? { platform: layer('claude', 'open', 2) }
        : { platform: layer('codex', 'trial', 3), repo: layer('claude', 'open', 2) };
      options[source] = source === 'env' ? environment(provider, mode, max) : layer(provider, mode, max);
      return options;
    };
    const lower = source === 'platform' ? expected('codex', 'trial', 1, 'default')
      : expected('claude', 'open', 2, source === 'repo' ? 'platform' : 'repo');

    it.each([undefined, null, '', 'gemini', 'CODEX', true, 1, {}, []].map(raw => [raw]))(`ignores invalid provider at ${source}: %j`, raw => {
      expect(resolve(withInvalid(raw, undefined, undefined))).toEqual(lower);
    });
    it.each([undefined, null, '', 'closed', 'OPEN', true, 1, {}, []].map(raw => [raw]))(`ignores invalid Gemini mode at ${source}: %j`, raw => {
      expect(resolve(withInvalid(undefined, raw, undefined))).toEqual(lower);
    });
    it.each([undefined, null, '', ' ', true, false, 0, -1, 17, 1.5, NaN, Infinity, '0', '17', '1.5', '1x', '1e1', '0x10', ' 2 ', {}, []].map(raw => [raw]))(`ignores invalid or oversized concurrency at ${source}: %j`, raw => {
      expect(resolve(withInvalid(undefined, undefined, raw))).toEqual(lower);
    });
  }

  it.each([1, 16, '1', '16'])('accepts concurrency endpoints: %j', max => {
    expect(resolve({ env: environment(undefined, undefined, max) }).gemini.maxConcurrent)
      .toEqual({ value: Number(max), source: 'env' });
  });

  it('resolves each field independently without losing lower-layer provenance', () => {
    expect(resolve({ platform: layer('claude', 'open', 2), repo: layer('antigravity-gemini', undefined, 3), env: environment(undefined, undefined, '4') }))
      .toEqual({ kind: 'build', provider: { value: 'antigravity-gemini', source: 'repo' }, gemini: {
        mode: { value: 'open', source: 'platform' }, maxConcurrent: { value: 4, source: 'env' },
      } });
  });

  it('maps prepare-item to WE_DIRECT_LAUNCH_PREPARE_ITEM_PROVIDER', () => {
    const result = resolve({ kind: 'prepare-item', env: { WE_DIRECT_LAUNCH_PREPARE_ITEM_PROVIDER: 'claude', WE_DIRECT_LAUNCH_BUILD_PROVIDER: 'codex' } });
    expect(result.kind).toBe('prepare-item');
    expect(result.provider).toEqual({ value: 'claude', source: 'env' });
  });

  it.each([null, [], false, 'invalid', { directLaunch: null }, { directLaunch: { build: null, gemini: null } }].map(raw => [raw]))('ignores malformed layer shapes: %j', raw => {
    expect(resolve({ platform: raw, repo: raw })).toEqual(expected('codex', 'trial', 1, 'default'));
  });

  it.each(['unreadable', 'invalid JSON'])('ignores an %s platform file', failure => {
    if (failure === 'unreadable') vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('unreadable'); });
    else vi.mocked(readFileSync).mockReturnValueOnce('{broken');
    expect(resolveDirectLaunchSetting({ kind: 'build', env: {}, repo: {} })).toEqual(expected('codex', 'trial', 1, 'default'));
  });

  it('the shipped file owns its leaves once and resolves build and fix to codex from repo', () => {
    const declared = readDeclaredSettings();
    expect(declared.errors).toEqual([]);
    expect(declared.duplicates).toEqual([]);
    for (const leaf of ['build.provider', 'fix.provider', 'gemini.mode', 'gemini.maxConcurrent']) {
      expect(declared.owners[`directLaunch.${leaf}`]).toBe('settings/direct-launch.json');
    }
    for (const kind of ['build', 'fix']) {
      const result = resolveDirectLaunchSetting({ kind, env: {}, platform: {} });
      expect(result.provider).toEqual({ value: 'codex', source: 'repo' });
      expect(result.gemini).toEqual({ mode: { value: 'trial', source: 'repo' }, maxConcurrent: { value: 1, source: 'repo' } });
    }
  });
});

describe('direct-launch logs', () => {
  it('formats the exact log line', () => {
    expect(formatDirectLaunchLog({ kind: 'fix', provider: 'claude', reason: 'directLaunch.fix.provider', source: 'env' }))
      .toBe('direct launch fix: provider claude (directLaunch.fix.provider, source env)');
  });

  it('names the built-in default when no layer sets a provider', () => {
    expect(directLaunchLogLine({ kind: 'ci-heal', env: {}, platform: {}, repo: {} }))
      .toBe('direct launch ci-heal: provider codex (built-in default, source default)');
  });

  it('names the setting and includes Gemini mode and max inside the reason', () => {
    expect(directLaunchLogLine({ kind: 'build', env: {}, platform: {}, repo: layer('antigravity-gemini', 'open', 16) }))
      .toBe('direct launch build: provider antigravity-gemini (directLaunch.build.provider, gemini mode open max 16, source repo)');
  });

  it('reports Gemini defaults when only its provider is set', () => {
    expect(directLaunchLogLine({ kind: 'build', env: environment('antigravity-gemini'), platform: {}, repo: {} }))
      .toBe('direct launch build: provider antigravity-gemini (directLaunch.build.provider, gemini mode trial max 1, source env)');
  });
});
