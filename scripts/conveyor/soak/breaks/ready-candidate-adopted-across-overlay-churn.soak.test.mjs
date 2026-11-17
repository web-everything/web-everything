import { expect, it } from 'vitest';
import { matchReadyCandidate as baseline } from '../fixtures/ready-candidate-ref-only-matcher.mjs';
import b from './ready-candidate-adopted-across-overlay-churn.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('reproduces the descendant adoption failure with the pinned origin/main matcher', async () => {
  const report = await b.run({ matchCandidate: baseline });
  expect(report.violations.map((v) => v.invariant)).toEqual(['descendant-advanced']);
  expect(b.judge(report)).toHaveLength(1);
});
