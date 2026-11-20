import { describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import b from './overlay-main-sync-killed-run-cause.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
describe('overlay main sync killed-run soak', () => {
  it('fixPresent proves a killed-once then green run proceeds through the production path', () => {
    expect(b.fixPresent(root)).toBe(true);
  }, 35_000);
  it('fixPresent refuses a tree whose runner fails on the first interruption without retrying', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'soak-killed-run-no-retry-'));
    try {
      const source = join(sourceRoot, 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs');
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, `export async function runOverlayMainSync({ deps }) {
        await deps.testRunner({});
        throw new Error('killed without retry');
      }`);
      expect(b.fixPresent(sourceRoot)).toBe(false);
    } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
  }, 35_000);
});

defineBreakTest(b);
