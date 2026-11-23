import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './red-main-quarantine-soft-timeout.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { breakById } from './index.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
defineBreakTest(b);

it('discovers the break and the fix is present on this tree (decided by behaviour)', () => {
  expect(breakById(b.id)).toBe(b);
  expect(b.fixPresent(ROOT)).toBe(true);
});

it('plans an immediate add for the soft-timed-out soak file', async () => {
  const report = await b.run({});
  expect(b.judge(report)).toEqual([]);
  expect(report.plan.tests).toEqual(['scripts/conveyor/soak/daemon-soak.soak.test.mjs']);
});
