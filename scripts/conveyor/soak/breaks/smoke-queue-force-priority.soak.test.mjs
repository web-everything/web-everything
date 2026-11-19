import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b, { scenario } from './smoke-queue-force-priority.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('the fix is present in the tree under test', () => expect(b.fixPresent(process.cwd())).toBe(true));

it('priority queues ahead of a routine waiter and never preempts the holder at cap 1', async () => {
  expect((await scenario()).violations).toEqual([]);
});

it('a routine waiter older than 10 minutes is not overtaken by priority', async () => {
  expect((await scenario({ ageMs: 10 * 60_000 + 1 })).violations).toEqual([]);
});

it('fix detection fails closed on missing or incomplete source', () => {
  const root = mkdtempSync(join(tmpdir(), 'soak-smoke-priority-missing-'));
  try {
    expect(b.fixPresent(root)).toBe(false);
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    writeFileSync(join(root, 'scripts/lib/daemon-smoke-slots.mjs'), 'priority = false;');
    expect(b.fixPresent(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
