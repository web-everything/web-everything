import { describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import b from './overlay-main-sync-chunked-run-budget.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
describe('overlay main sync chunked run-budget soak', () => {
  it('fixPresent proves the production path completes all 30 files within the run budget', () => {
    expect(b.fixPresent(root)).toBe(true);
  }, 35_000);
  it('fixPresent refuses a tree that sends all 30 files in one chunk', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-chunked-budget-old-'));
    try {
      const source = join(sourceRoot, 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs');
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, `export async function runOverlayMainSync({ deps }) {
        const result = await deps.testRunner({ args: Array.from({ length: 30 }, (_, i) => 'worker' + i + '.test.mjs') });
        if (result.status === 124) throw new Error('tests: run killed (timeout 480000ms)');
        return { pushed: true };
      }`);
      expect(b.fixPresent(sourceRoot)).toBe(false);
    } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
  }, 35_000);
});

defineBreakTest(b);
