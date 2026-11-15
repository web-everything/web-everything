import { describe, expect, it } from 'vitest';
import scenario, { cases } from './daemon-clone-gc-skips-busy-clone.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(scenario);

describe('daemon clone GC safety guarantees', () => {
  it.each(cases)('%s', async (caseName) => {
    const report = await scenario.run({ caseName });
    expect(report.observations).toHaveLength(1);
    expect(scenario.judge(report)).toEqual([]);
  });
});
