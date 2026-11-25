import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b, { exercise } from './rewaive-request-never-admits.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

it('refuses the head when only a request is filed', async () => {
  const report = await exercise(fileURLToPath(new URL('../../../../', import.meta.url)));
  expect(report.violations).toEqual([]);
});
