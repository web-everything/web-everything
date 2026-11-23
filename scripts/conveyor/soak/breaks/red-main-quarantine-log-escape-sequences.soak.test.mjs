import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './red-main-quarantine-log-escape-sequences.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { breakById } from './index.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
defineBreakTest(b);

it('discovers the break and the fix is present on this tree (decided by behaviour)', () => {
  expect(breakById(b.id)).toBe(b);
  expect(b.fixPresent(ROOT)).toBe(true);
});

it('names the timed-out soak test from an escape-coded log through a strict gh', async () => {
  const report = await b.run({});
  expect(b.judge(report)).toEqual([]);
  expect(report.read.failures.files).toEqual(['scripts/conveyor/soak/daemon-soak.soak.test.mjs']);
});
