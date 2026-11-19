import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b from './run-store-stray-entry.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('behavioral fix detection', () => {
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
