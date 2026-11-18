// @vitest-environment node
import { expect, it } from 'vitest';
import b from './same-head-send-back-after-referral-resume.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('replays the real planner without import errors and keeps the no-send-back control held', async () => {
  const report = await b.run();
  expect(report.withoutSendBack.dispatch).toEqual([]);
  expect(report.withoutSendBack.refusals).toMatchObject([{ kind: 'already-reviewed-head' }]);
  // An expected failure must reproduce the known refusal, never mask a broken fixture or import.
  if (report.requested.dispatch.length === 0) {
    expect(report.requested.refusals).toMatchObject([{ kind: 'already-reviewed-head' }]);
    expect(b.judge(report)).toEqual([
      'same-head-send-back-not-dispatched: later pinned changes must dispatch exactly one fixer without refusal',
    ]);
  } else {
    expect(b.judge(report)).toEqual([]);
  }
});

it('fails closed on incomplete planner reports', () => {
  expect(b.judge({})).toHaveLength(2);
});
