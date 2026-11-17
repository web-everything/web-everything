import b from './unchecked-draft-and-stale-accepted-status.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

import { describe, expect, it } from 'vitest';

defineBreakTest(b);

// Unconditional: runs the real derivation through every scenario, so reverting a guard fails a real assertion.
describe('unchecked draft and stale accepted status — unconditional behaviour', () => {
  it('every scenario holds', async () => {
    const report = await b.run({});
    expect(b.judge(report)).toEqual([]);
  });
});
