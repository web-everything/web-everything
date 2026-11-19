import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOrchestratorAuthority } from '../orchestrator-authority-settings.mjs';
import { readDeclaredSettings } from '../settings-files.mjs';

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
  });
  it('platform true overrides repo false and platform false overrides repo true', () => {
    expect(load({ platform: block(true), tool: block(false) }).redMainQuarantine).toBe(true);
    expect(load({ platform: block(false), tool: block(true) }).redMainQuarantine).toBe(false);
    expect(load({ tool: block(true) }).redMainQuarantine).toBe(true);
  });
  it('reads orchestrator authority through the normal platform accessor', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'authority-')), 'preferences.json');
    writeFileSync(file, JSON.stringify({ orchestrator: block(true) }));
    expect(resolveOrchestratorAuthority({ env: { WE_PLATFORM_PREFERENCES_FILE: file }, tool: block(false) })).toEqual({ redMainQuarantine: true });
    writeFileSync(file, JSON.stringify({ orchestrator: block(false) }));
    expect(resolveOrchestratorAuthority({ env: { WE_PLATFORM_PREFERENCES_FILE: file }, tool: block(true) })).toEqual({ redMainQuarantine: false });
  });
  it('refuses unreadable platform evidence instead of accepting a repo grant', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'authority-')), 'preferences.json');
    writeFileSync(file, '{ invalid JSON');
    expect(resolveOrchestratorAuthority({ env: { WE_PLATFORM_PREFERENCES_FILE: file }, tool: block(true) }).redMainQuarantine).toBe(false);
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
