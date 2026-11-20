import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import scenario from './review-seat-starved-by-repo-order.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(scenario);

it('behavioral fix probe requires the real tree to serve both repos', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  expect(scenario.fixPresent(root)).toBe(true);
});

it('fix probe fails closed when the review daemon is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'soak-review-seat-missing-'));
  try { expect(scenario.fixPresent(root)).toBe(false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
