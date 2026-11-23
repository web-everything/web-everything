import { expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import b from './rebuild-reader-never-yields.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

it('reports the fix absent when the real iteration ignores the pending rebuild signal', () => {
  const temp = mkdtempSync(join(process.env.TMPDIR, 'reader-no-yield-'));
  try {
    mkdirSync(join(temp, 'scripts/conveyor'), { recursive: true });
    symlinkSync(join(root, 'scripts/lib'), join(temp, 'scripts/lib'));
    const original = pathToFileURL(join(root, 'scripts/conveyor/ci-heal-loop.mjs')).href;
    writeFileSync(join(temp, 'scripts/conveyor/ci-heal-loop.mjs'), `
      import { runCiHealLoopIteration as iteration } from ${JSON.stringify(original)};
      export const runCiHealLoopIteration = options => iteration({ ...options, pendingRebuild: () => null });
    `);
    expect(b.fixPresent(temp)).toBe(false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

it('detects the fix by running the real iteration with a real foreign writer claim', () => {
  expect(b.fixPresent(root)).toBe(true);
});

defineBreakTest(b);
