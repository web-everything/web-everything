import { it, expect } from 'vitest';
import b from './superseded-omits-retired-merged-overlay.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('the fix is present in the tree under test', () => expect(b.fixPresent(process.cwd())).toBe(true));

it('reproduces the permanent discard when only current-tick removals count', async () => {
  const report = await b.run({ prepareSource: `removedForMain: (ref, sha) => {
          return plan.decisions.some((d) => d.ref === ref && d.action === 'remove' && (d.reason === 'pr-merged' || d.reason === 'in-main'));
        },` });
  expect(report.violations).toHaveLength(1);
  expect(report.results[0].result).toMatchObject({ adopt: null, reason: 'superseded-omits-live-overlay: lane/merged-overlay' });
});
