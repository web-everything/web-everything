import b from './stuck-pr-watch-thresholds-settings.mjs';
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

describe('threshold settings break presence', () => {
  it('keeps the installed fix present and fails red after the settings file is deleted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stuck-pr-break-'));
    try {
      mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
      mkdirSync(join(root, 'scripts/settings'), { recursive: true });
      writeFileSync(join(root, 'scripts/conveyor/stuck-pr-watch-core.mjs'),
        readFileSync(new URL('../../stuck-pr-watch-core.mjs', import.meta.url), 'utf8'));
      const settings = join(root, 'scripts/settings/stuck-pr-watch.json');
      writeFileSync(settings, JSON.stringify({ stuckPrWatch: { thresholdMinutes: { review: 45, fix: 45, approved: 30, conflict: 45 } } }));
      expect(b.fixPresent(root)).toBe(true);
      expect(b.judge(await b.run({ root }))).toEqual([]);
      rmSync(settings);
      expect(b.fixPresent(root)).toBe(true);
      expect(b.judge(await b.run({ root }))).toEqual([expect.stringContaining('ENOENT')]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not treat a settings file alone as an installed reader', () => {
    const root = mkdtempSync(join(tmpdir(), 'stuck-pr-break-'));
    try {
      mkdirSync(join(root, 'scripts/settings'), { recursive: true });
      writeFileSync(join(root, 'scripts/settings/stuck-pr-watch.json'), '{}');
      expect(b.fixPresent(root)).toBe(false);
      mkdirSync(join(root, 'scripts/conveyor'));
      writeFileSync(join(root, 'scripts/conveyor/stuck-pr-watch-core.mjs'), '// old core without the settings reader');
      expect(b.fixPresent(root)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
