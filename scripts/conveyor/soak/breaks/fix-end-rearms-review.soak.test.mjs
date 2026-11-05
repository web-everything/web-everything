// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import b from './fix-end-rearms-review.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
// origin/main before R618; keep the negative fixture stable after the fix merges.
const PRE_FIX_COMMIT = '163e9fe190bacdf6ebbcdc6786ddc9305e600aa6';

it('pinned pre-fix main reproduces both the missing post-fix review and refused operator repair', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-main-'));
  try {
    const archive = execFileSync('git', ['archive', PRE_FIX_COMMIT, 'scripts', 'src/_data', 'schemas', 'package.json'],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', sourceRoot], { input: archive, maxBuffer: 1024 * 1024 });
    symlinkSync(join(ROOT, 'node_modules'), join(sourceRoot, 'node_modules'), 'dir');
    expect(b.fixPresent(sourceRoot)).toBe(false);
    expect(b.judge(await b.run({ sourceRoot }))).toEqual([
      'trusted fix-end on a new head did not dispatch review',
      'newer operator send-back did not dispatch fix after the same-head advisory',
      'newer operator send-back was refused already-reviewed-head',
    ]);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

it('missing source fails closed with a scenario violation', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-missing-'));
  try {
    expect(b.fixPresent(sourceRoot)).toBe(false);
    expect(b.judge(await b.run({ sourceRoot }))).toEqual([
      expect.stringContaining('scenario failed:'),
    ]);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

it('incomplete reconcile source is not evidence of the fix', () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-r618-incomplete-'));
  try {
    mkdirSync(join(sourceRoot, 'scripts/conveyor'), { recursive: true });
    writeFileSync(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs'), 'function latestHeadReview() {}');
    expect(b.fixPresent(sourceRoot)).toBe(false);
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});
