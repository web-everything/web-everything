import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import b from './required-admission-gates-deadlock-review.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('behavioral fix detection rejects the old CI-heal-only planner', () => {
  const root = mkdtempSync(join(process.env.TMPDIR, 'admission-gates-'));
  try {
    mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
    writeFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'),
      "export const planReconcile = () => ({ dispatch: [{ kind: 'ci-heal' }] });\n");
    expect(b.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
