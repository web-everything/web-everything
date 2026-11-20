import { expect, it } from 'vitest';
import b from './prepare-repeat-refusal-readmitted-after-30min.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('reports a card planned or admitted again within 24h', () => {
  const report = { refusals: [1, 1], initialOffers: 2, offered: 1, planned: [{ num: '5028' }], dispatched: 0, held: false };
  expect(b.judge(report)).toContain('twice-refused card planned/admitted again within 24h');
  expect(b.judge({ ...report, offered: 0, planned: [], dispatched: 1 })).toContain('twice-refused card planned/admitted again within 24h');
});
it('fails closed when the behaviour probe cannot import the target daemon', () => {
  expect(b.fixPresent(new URL('./absent-daemon-root/', import.meta.url).pathname)).toBe(false);
});
