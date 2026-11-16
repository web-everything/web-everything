import { expect, it } from 'vitest';
import b from './restamp-comment-does-not-retrigger-merge-gate.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('BEFORE: a restamp COMMENT without gate refresh leaves the failed gate stranded', async () => {
  const report = await b.run({ refreshGate: () => ({ ok: true, refreshed: false }) });
  expect(b.judge(report)).toContain('newest gate failed before restamp: restamp did not issue exactly the required refresh calls');
});
