import b from './redteam-pending-label-never-settles.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
describe('pending-label break detection', () => {
  it('requires the replay even when recovery is missing or its exports were deleted', () => {
    const root = mkdtempSync(join(tmpdir(), 'pending-label-fix-present-'));
    try {
      expect(b.fixPresent(root)).toBe(true);
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      writeFileSync(join(root, 'scripts/lib/review-red-team-on-skip.mjs'), '// exports deleted\n');
      expect(b.fixPresent(root)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
