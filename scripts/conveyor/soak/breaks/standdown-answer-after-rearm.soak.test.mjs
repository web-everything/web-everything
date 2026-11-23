import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b, { probe } from './standdown-answer-after-rearm.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('stand-down answer after rearm replay', () => {
  it('reopens the window for the newest stand-down in the current tree', () => {
    expect(b.judge(b.run({}))).toEqual([]);
  });

  it.each(['sticky-rearm', 'stale-target'])('rejects legacy %s behavior by observation', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'standdown-after-rearm-legacy-'));
    try {
      mkdirSync(join(dir, 'scripts/conveyor'), { recursive: true });
      for (const name of ['stand-down', 'stand-down-answer-core']) {
        symlinkSync(new URL('../../' + name + '.mjs', import.meta.url), join(dir, 'scripts/conveyor/' + name + '.mjs'));
      }
      const source = new URL('../../rearm-review.mjs', import.meta.url).href;
      writeFileSync(join(dir, 'scripts/conveyor/rearm-review.mjs'), `
        import { rearmWindow as realWindow } from ${JSON.stringify(source)};
        export function rearmWindow(comments) {
          return { ...realWindow(comments), ${mode === 'sticky-rearm' ? 'rearmed: true' : "standDownId: 'old'"} };
        }
      `);
      expect(probe(dir).violations.join('\n')).toContain(mode === 'sticky-rearm'
        ? 'new stand-down must reopen' : 'window must target the newest');
      expect(b.fixPresent(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable checkout as missing fix evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'standdown-after-rearm-missing-'));
    try {
      expect(b.fixPresent(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
