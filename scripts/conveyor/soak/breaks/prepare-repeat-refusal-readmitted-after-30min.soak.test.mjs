import { expect, it } from 'vitest';
import b from './prepare-repeat-refusal-readmitted-after-30min.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('live reload preserves the repeat-refusal hold through expiry and a matching operator release lifts it', async () => {
  const report = await b.run();
  report.etLogs.forEach(line => console.info(line));
  expect(b.judge(report)).toEqual([]);
  expect(report.etLogs).toHaveLength(3);
  expect(report.etLogs.slice(0, 2).every(line => /EST: loaded #5028 held=true offered=0 dispatched=0$/.test(line))).toBe(true);
  expect(report.etLogs[2]).toMatch(/EST: loaded #5028 held=false offered=1 dispatched=1$/);
});
it('reports a card planned or admitted again within 24h', () => {
  const report = { refusals: [1, 1], initialOffers: 2, offered: 1, planned: [{ num: '5028' }], dispatched: 0, held: false };
  expect(b.judge(report)).toContain('twice-refused card planned/admitted again within 24h');
  expect(b.judge({ ...report, offered: 0, planned: [], dispatched: 1 })).toContain('twice-refused card planned/admitted again within 24h');
});
it('fails closed when the behaviour probe cannot import the target daemon', () => {
  expect(b.fixPresent(new URL('./absent-daemon-root/', import.meta.url).pathname)).toBe(false);
});
