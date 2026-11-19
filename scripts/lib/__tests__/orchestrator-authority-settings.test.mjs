import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOrchestratorAuthority } from '../orchestrator-authority-settings.mjs';
import * as settings from '../settings-files.mjs';
import { readDeclaredSettings, readSettingsChecked } from '../settings-files.mjs';
import { LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH, operatorPreferencesPath } from '../policy-cascade.mjs';

const checkedReader = readSettingsChecked;
const scratch = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'authority-'));
  scratch.push(dir);
  return dir;
};
const platformFiles = operator => {
  const paths = [...LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH, operatorPreferencesPath({})];
  return vi.fn(path => {
    if (LEGACY_PLATFORM_PREFERENCES_PATHS.includes(path)) throw Object.assign(new Error('missing legacy file'), { code: 'ENOENT' });
    if (paths.includes(path)) {
      if (path !== paths.at(-1)) return '{}';
      if (operator instanceof Error) throw operator;
      return operator;
    }
    throw new Error(`unexpected preferences path: ${path}`);
  });
};

const block = redMainQuarantine => ({ authority: { redMainQuarantine } });
const load = options => resolveOrchestratorAuthority({ env: {}, platform: {}, tool: {}, ...options });

describe('orchestrator authority settings', () => {
  it('defaults to false and registers its repo default through feature discovery', () => {
    expect(load()).toEqual({ redMainQuarantine: false });
    const declared = readDeclaredSettings();
    expect(declared.settings.authority.redMainQuarantine).toBe(false);
    expect(declared.owners['authority.redMainQuarantine']).toBe('settings/orchestrator-authority.json');
  });
  it.each([false, null, 'true', 1, {}, []])('fails closed for invalid or false grants (%j), even over a lower true', value => {
    expect(load({ platform: block(value), tool: block(true) }).redMainQuarantine).toBe(false);
    expect(load({ tool: block(value) }).redMainQuarantine).toBe(false);
    if (value !== false) expect(load({ platform: block(true), tool: block(value) }).redMainQuarantine).toBe(false);
  });
  it('platform true overrides repo false and platform false overrides repo true', () => {
    expect(load({ platform: block(true), tool: block(false) }).redMainQuarantine).toBe(true);
    expect(load({ platform: block(false), tool: block(true) }).redMainQuarantine).toBe(false);
    expect(load({ tool: block(true) }).redMainQuarantine).toBe(true);
  });
  it('reads the default platform grant without an environment path override', () => {
    const readFile = platformFiles(JSON.stringify({ orchestrator: block(true) }));
    expect(resolveOrchestratorAuthority({ env: {}, tool: block(false), readFile })).toEqual({ redMainQuarantine: true });
  });
  it('accepts current platform grant when optional legacy files are absent', () => {
    const readFile = vi.fn(path => {
      if (LEGACY_PLATFORM_PREFERENCES_PATHS.includes(path)) throw Object.assign(new Error('missing legacy file'), { code: 'ENOENT' });
      if (path === PLATFORM_PREFERENCES_PATH) return JSON.stringify({ orchestrator: block(true) });
      if (path === operatorPreferencesPath({})) return '{}';
      throw new Error(`unexpected preferences path: ${path}`);
    });
    expect(resolveOrchestratorAuthority({ env: {}, tool: block(false), readFile })).toEqual({ redMainQuarantine: true });
    for (const path of LEGACY_PLATFORM_PREFERENCES_PATHS) expect(readFile).toHaveBeenCalledWith(path, 'utf8');
  });
  it('denies missing current platform evidence even with an operator grant', () => {
    const readFile = platformFiles(JSON.stringify({ orchestrator: block(true) }));
    const read = (path, encoding) => {
      if (path === PLATFORM_PREFERENCES_PATH) throw Object.assign(new Error('missing current file'), { code: 'ENOENT' });
      return readFile(path, encoding);
    };
    expect(resolveOrchestratorAuthority({ env: {}, tool: block(true), readFile: read }).redMainQuarantine).toBe(false);
  });
  it.each(['unreadable', 'invalid JSON'])('denies %s optional legacy evidence', kind => {
    const readFile = platformFiles(JSON.stringify({ orchestrator: block(true) }));
    const read = (path, encoding) => {
      if (LEGACY_PLATFORM_PREFERENCES_PATHS.includes(path)) {
        if (kind === 'unreadable') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return '{ invalid JSON';
      }
      return readFile(path, encoding);
    };
    expect(resolveOrchestratorAuthority({ env: {}, tool: block(true), readFile: read }).redMainQuarantine).toBe(false);
  });
  it.each(['grant', 'missing'])('ignores an environment platform path redirect to %s and preserves the default revocation', redirect => {
    const file = join(temp(), 'preferences.json');
    if (redirect === 'grant') writeFileSync(file, JSON.stringify({ orchestrator: block(true) }));
    const read = platformFiles(JSON.stringify({ orchestrator: block(false) }));
    expect(resolveOrchestratorAuthority({ env: { WE_PLATFORM_PREFERENCES_FILE: file }, tool: block(true), readFile: read })).toEqual({ redMainQuarantine: false });
    expect(read.mock.calls.some(([path]) => path === file)).toBe(false);
    expect(read.mock.calls.some(([path]) => path === operatorPreferencesPath({}))).toBe(true);
  });
  it.each([
    ['missing', Object.assign(new Error('missing'), { code: 'ENOENT' })],
    ['unreadable', Object.assign(new Error('denied'), { code: 'EACCES' })],
    ['invalid JSON', '{ invalid JSON'],
    ['invalid root', '[]'],
    ['invalid grant', JSON.stringify({ orchestrator: block('true') })],
  ])('refuses %s default platform evidence instead of accepting a repo grant', (_, evidence) => {
    const readFile = platformFiles(evidence);
    expect(resolveOrchestratorAuthority({ env: {}, tool: block(true), readFile }).redMainQuarantine).toBe(false);
  });
  it.each([
    ['conflicting owners', JSON.stringify(block(false))],
    ['duplicate owners', JSON.stringify(block(true))],
    ['duplicate keys', '{"authority":{"redMainQuarantine":false,"redMainQuarantine":true}}'],
    ['invalid JSON', '{ invalid JSON'],
    ['invalid grant', JSON.stringify(block('true'))],
    ['unreadable file', null],
  ])('denies %s in discovered repo settings even with a platform grant', (kind, evidence) => {
    const dir = temp();
    if (kind !== 'invalid grant') writeFileSync(join(dir, 'orchestrator-authority.json'), JSON.stringify(block(true)));
    const other = join(dir, 'other.json');
    if (evidence === null) mkdirSync(other);
    else writeFileSync(other, evidence);
    vi.spyOn(settings, 'readSettingsChecked').mockImplementation(options => checkedReader({ ...options, dir, legacyPath: null }));
    for (const platform of [{}, block(true)]) {
      expect(resolveOrchestratorAuthority({ env: {}, platform }).redMainQuarantine).toBe(false);
    }
  });
  it('accepts an unambiguous discovered repo grant', () => {
    const dir = temp();
    writeFileSync(join(dir, 'orchestrator-authority.json'), JSON.stringify(block(true)));
    vi.spyOn(settings, 'readSettingsChecked').mockImplementation(options => checkedReader({ ...options, dir, legacyPath: null }));
    expect(resolveOrchestratorAuthority({ env: {}, platform: {} }).redMainQuarantine).toBe(true);
  });
  it.each([null, 'true', []])('denies malformed authority blocks above a repo grant (%j)', authority => {
    expect(load({ platform: { authority }, tool: block(true) }).redMainQuarantine).toBe(false);
  });
  it('logs the effective value with its actual layer provenance', () => {
    const lines = [];
    load({ env: { WE_POLICY_CASCADE_LOG: '1' }, platform: block(true), tool: block(false), log: line => lines.push(line) });
    expect(lines.join('\n')).toContain('redMainQuarantine=true (platform)');
  });
});
