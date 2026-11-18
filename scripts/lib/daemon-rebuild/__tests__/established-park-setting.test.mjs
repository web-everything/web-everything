import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEstablishedOverlayParkMinutes } from '../established-park-setting.mjs';

describe('resolveEstablishedOverlayParkMinutes fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'park-setting-'));
  const noPlatform = () => ({ HOME: dir, WE_PLATFORM_PREFERENCES_FILE: join(dir, 'absent-platform.json') });
  const tool = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };
  it('uses the standard 30 minutes only when every layer is absent', () => {
    expect(resolveEstablishedOverlayParkMinutes(noPlatform(), { settingsPath: join(dir, 'absent.json') }).value).toBe(30);
  });
  it('honors a configured value and a configured 0', () => {
    expect(resolveEstablishedOverlayParkMinutes(noPlatform(), { settingsPath: tool('v.json', '{"overlay":{"establishedParkMinutes":12}}') }).value).toBe(12);
    expect(resolveEstablishedOverlayParkMinutes(noPlatform(), { settingsPath: tool('z.json', '{"overlay":{"establishedParkMinutes":0}}') }).value).toBe(0);
  });
  it.each([
    ['malformed tool file', '{ not json'],
    ['non-numeric tool value', '{"overlay":{"establishedParkMinutes":"soon"}}'],
    ['negative tool value', '{"overlay":{"establishedParkMinutes":-5}}'],
    ['non-object tool block', '{"overlay":7}'],
  ])('%s disables parking instead of falling back to 30', (name, body) => {
    expect(resolveEstablishedOverlayParkMinutes(noPlatform(), { settingsPath: tool(`${name.replace(/ /g, '-')}.json`, body) }).value).toBe(0);
  });
  it.each([['abc'], ['-1'], ['']])('invalid env value %j disables parking', raw => {
    const env = { ...noPlatform(), WE_DAEMON_ESTABLISHED_OVERLAY_PARK_MINUTES: raw };
    expect(resolveEstablishedOverlayParkMinutes(env, { settingsPath: join(dir, 'absent.json') }).value).toBe(0);
  });
  it('an unreadable (malformed) platform preferences file disables parking', () => {
    const p = tool('platform-bad.json', '{ nope');
    expect(resolveEstablishedOverlayParkMinutes({ HOME: dir, WE_PLATFORM_PREFERENCES_FILE: p }, { settingsPath: join(dir, 'absent.json') }).value).toBe(0);
  });
  it('an invalid platform value disables parking', () => {
    const p = tool('platform-inv.json', '{"overlay":{"establishedParkMinutes":"x"}}');
    expect(resolveEstablishedOverlayParkMinutes({ HOME: dir, WE_PLATFORM_PREFERENCES_FILE: p }, { settingsPath: join(dir, 'absent.json') }).value).toBe(0);
  });
});
