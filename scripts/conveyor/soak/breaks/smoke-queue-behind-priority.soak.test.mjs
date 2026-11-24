import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b, { scenario } from './smoke-queue-behind-priority.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('detects the fix by helper behaviour in the tree under test', () => {
  expect(b.fixPresent(process.cwd())).toBe(true);
});

it.each([0, 600001])('behind priority preserves holder and routine aging at age %s', async ageMs => {
  expect((await scenario({ ageMs })).violations).toEqual([]);
});

it('fix detection fails closed on absent, incomplete, and always-priority helpers', () => {
  const root = mkdtempSync(join(tmpdir(), 'soak-behind-missing-'));
  try {
    expect(b.fixPresent(root)).toBe(false);
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    const path = join(root, 'scripts/lib/daemon-smoke-slots.mjs');
    writeFileSync(path, 'export const priority = false;');
    expect(b.fixPresent(root)).toBe(false);
    writeFileSync(path, 'export const behindMainPriority = () => true;');
    expect(b.fixPresent(root)).toBe(false);
    writeFileSync(path, 'export const behindMainPriority = () => false;');
    expect(b.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
