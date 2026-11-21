import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import b from './watchdog-pr-list-transient-retry.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('fix presence fails closed: unreadable module', () => {
  const root = mkdtempSync(join(tmpdir(), 'soak-wd-root-'));
  try {
    mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
    writeFileSync(join(root, 'scripts/conveyor/pr-live-owner-watch-io.mjs'), 'export const unrelated = true;');
    expect(b.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
