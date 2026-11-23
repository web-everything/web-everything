import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b, { probe } from './orphan-guard-settles.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('settled orphan-guard replay', () => {
  it('requires fewer deferrals on the second bounded pass in the current tree', () => {
    expect(b.judge(b.run({}))).toEqual([]);
  });

  it('rejects the legacy no-cache behavior even when cursor and budget bounds work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orphan-settles-legacy-'));
    try {
      mkdirSync(join(dir, 'scripts/conveyor'), { recursive: true });
      const source = new URL('../../orphan-fix-round.mjs', import.meta.url).href;
      writeFileSync(join(dir, 'scripts/conveyor/orphan-fix-round.mjs'), `
        import { runOrphanFixRoundPass as realPass } from ${JSON.stringify(source)};
        export function runOrphanFixRoundPass({ settled, ...options }) { return realPass(options); }
      `);
      expect(probe(dir).violations.join('\n')).toContain('second pass must defer fewer PRs');
      expect(b.fixPresent(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable checkout as missing fix evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orphan-settles-missing-'));
    try {
      expect(b.fixPresent(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
