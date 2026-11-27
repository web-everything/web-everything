import { it, expect } from 'vitest';
import b from './supersede-bot-author-shapes.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('the bot author identity fix handles 12000 historical closed PRs within the page budget', async () => {
  expect(b.fixPresent(process.cwd())).toBe(true);
  const report = await b.run();
  expect(report.violations).toEqual([]);
  expect(report.closedPages).toBeLessThanOrEqual(6);
  expect(report.results[0].applied[0]).toMatchObject({ pr: 10, by: 20, ok: true });
  expect(report.writes).toBe(1);
});
