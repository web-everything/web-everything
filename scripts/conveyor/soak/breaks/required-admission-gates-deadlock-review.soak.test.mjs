import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import b from './required-admission-gates-deadlock-review.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('behavioral fix detection rejects the a classifier that leaves workflow protection owned by CI', () => {
  const root = mkdtempSync(join(process.env.TMPDIR, 'admission-gates-'));
  try {
    mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    writeFileSync(join(root, 'scripts/lib/merge-gate-hold-class.mjs'),
      'export const excusePrMergeGateHolds = prs => prs; export const readMergeGateVerdict = () => ({});');
    writeFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'),
      `export { planReconcile } from ${JSON.stringify(pathToFileURL(resolve(fileURLToPath(import.meta.url), '../../../reconcile-core.mjs')).href)};`);
    expect(b.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('behavioral fix detection confirms admission and real-CI ownership in this tree', () => {
  expect(b.fixPresent(resolve(fileURLToPath(import.meta.url), '../../../../..'))).toBe(true);
});
