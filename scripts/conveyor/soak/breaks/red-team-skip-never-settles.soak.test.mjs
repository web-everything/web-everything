// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import b from './red-team-skip-never-settles.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('pre-fix tree with missing settlement module reports violations without crashing', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-skip-pre-fix-'));
  try {
    expect(b.fixPresent(sourceRoot)).toBe(false);
    const report = await b.run({ sourceRoot });
    expect(b.judge(report)).toEqual([
      'missing scripts/lib/red-team-skip-outcome.mjs: skipped/unpublished red teams cannot settle',
    ]);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});
