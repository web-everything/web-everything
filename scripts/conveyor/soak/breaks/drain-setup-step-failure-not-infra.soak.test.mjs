import b from './drain-setup-step-failure-not-infra.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
defineBreakTest(b);

it('keeps test failures and unreadable steps held without unexpected fixture IO', async () => {
  const report = await b.run();
  expect(report.violations.filter(line => line !==
    'Checkout failure was held instead of receiving its bounded infrastructure retry')).toEqual([]);
});
