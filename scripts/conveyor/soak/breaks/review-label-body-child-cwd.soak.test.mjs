import { it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import scenario from './review-label-body-child-cwd.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(scenario);

it('keeps fix presence true when the body-file allowlist regresses', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const fixture = mkdtempSync(join(tmpdir(), 'review-label-refusal-'));
  try {
    mkdirSync(join(fixture, 'scripts'));
    symlinkSync(join(root, 'scripts/operations'), join(fixture, 'scripts/operations'), 'dir');
    writeFileSync(join(fixture, 'scripts/review-set-label.mjs'), `
      export { bodyFileRoots } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/review-set-label.mjs')).href)};
      export const checkBodyFileLocation = () => ({ ok: false });
    `);
    expect(scenario.fixPresent(fixture)).toBe(true);
    const report = await scenario.run({ sourceRoot: fixture });
    expect(scenario.judge(report)).toContain('real CLI allowlist refused body');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

it('refuses fix presence when the sink cannot be loaded', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'review-label-missing-'));
  try { expect(scenario.fixPresent(fixture)).toBe(false); }
  finally { rmSync(fixture, { recursive: true, force: true }); }
});
