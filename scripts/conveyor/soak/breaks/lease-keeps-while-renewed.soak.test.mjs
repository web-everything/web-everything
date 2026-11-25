import b from './lease-keeps-while-renewed.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
defineBreakTest(b);
it('requires both renewal and TTL-extension cases for every deletion path', () => {
  expect(b.judge({ reports: [] })).not.toEqual([]);
  const lease = { holder: 'original-holder' };
  const reports = ['acquire', 'reap', 'trim', 'reclaim', 'salvage'].flatMap(path => [false, true].map(ttlOnly =>
    ({ path, ttlOnly, code: 1, signal: null, actual: lease, expected: lease })));
  expect(b.judge({ reports })).toEqual([]);
  expect(b.judge({ reports: reports.slice(1) })).not.toEqual([]);
  expect(b.judge({ reports: reports.map(() => reports[0]) })).not.toEqual([]);
});
it('rejects signal termination and missing or zero exit status even when the renewed lease survives', () => {
  const lease = { holder: 'original-holder' };
  const report = { expected: lease, actual: lease };
  for (const exit of [{ code: null, signal: 'SIGKILL' }, { code: null, signal: null }, { code: undefined, signal: null }, { code: '1', signal: null }, { code: 0, signal: null }, { code: 1, signal: 'SIGKILL' }]) {
    expect(b.judge({ ...report, ...exit })).not.toEqual([]);
  }
  expect(b.judge({ ...report, code: 1, signal: null })).toEqual([]);
});
