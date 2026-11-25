import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import scenario from './agy-carbon-void-frees-slot.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(scenario);

it('the slot release is behaviorally present in this tree', () => {
  expect(scenario.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

it('the probe fails closed on missing runner evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'soak-agy-void-missing-'));
  try { expect(scenario.fixPresent(root)).toBe(false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
