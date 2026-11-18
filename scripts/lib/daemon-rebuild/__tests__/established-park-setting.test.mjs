import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEstablishedOverlayParkMinutes } from '../established-park-setting.mjs';

describe('resolveEstablishedOverlayParkMinutes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'park-setting-'));
  const env = { HOME: dir };
  it('uses the standard 30 minutes when the settings file is absent', () => {
    expect(resolveEstablishedOverlayParkMinutes(env, { settingsPath: join(dir, 'absent.json') }).value).toBe(30);
  });
  it('fails closed (parking disabled) when the settings file is malformed', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not json');
    expect(resolveEstablishedOverlayParkMinutes(env, { settingsPath: p }).value).toBe(0);
  });
  it('honors a configured 0', () => {
    const p = join(dir, 'zero.json');
    writeFileSync(p, JSON.stringify({ overlay: { establishedParkMinutes: 0 } }));
    expect(resolveEstablishedOverlayParkMinutes(env, { settingsPath: p }).value).toBe(0);
  });
});
