import b from './lease-keeps-while-renewed.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
defineBreakTest(b);
it('rejects signal termination and missing or zero exit status even when the renewed lease survives', () => {
  const lease = { holder: 'original-holder' };
  const report = { expected: lease, actual: lease };
  for (const exit of [{ code: null, signal: 'SIGKILL' }, { code: null, signal: null }, { code: undefined, signal: null }, { code: '1', signal: null }, { code: 0, signal: null }, { code: 1, signal: 'SIGKILL' }]) {
    expect(b.judge({ ...report, ...exit })).not.toEqual([]);
  }
  expect(b.judge({ ...report, code: 1, signal: null })).toEqual([]);
});
