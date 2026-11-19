import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import b from './run-store-stray-entry.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('behavioral fix detection', () => {
  // Unconditional gate: unlike the expected-fail break above, a regression in this tree fails here.
  it('this tree tolerates tombstones and stray JSON', () => {
    expect(b.judge(b.run({}))).toEqual([]);
  });

  it('keeps run ids that merely contain tmp as run records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-store-tmp-'));
    try {
      writeFileSync(join(dir, 'review-pr-active.tmp.json'), '{}');
      const out = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { listRunIds } from ${JSON.stringify(new URL('../../../operations/run-store.mjs', import.meta.url).href)}; console.log(JSON.stringify(listRunIds(process.argv[1])));`, dir],
        { encoding: 'utf8', env: { ...process.env, WE_UNDER_TEST: '1' } });
      expect(JSON.parse(out.stdout.trim().split('\n').pop())).toEqual(['review-pr-active.tmp']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a reader that throws on invalid ids, regardless of source markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-store-prefixed-'));
    try {
      mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
      writeFileSync(join(root, 'scripts/conveyor/review-referral-hold.mjs'), `
        // runFileEntries is present as text but the reader still fails.
        export function readReviewRunEvidence() { throw new Error('invalid run id'); }
      `);
      expect(b.fixPresent(root)).toBe(false);
      writeFileSync(join(root, 'scripts/conveyor/review-referral-hold.mjs'), 'export function readReviewRunEvidence() { return []; }');
      expect(b.fixPresent(root)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
