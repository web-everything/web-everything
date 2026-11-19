import { describe, expect, it } from 'vitest';
import scenario, { cases } from './clone-object-maintenance-borrowed-or-busy.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(scenario);

describe('R657 maintenance safety guarantees', () => {
  it.each(cases)('%s', async (caseName) => {
    const report = await scenario.run({ caseName });
    expect(report.observations).toHaveLength(1);
    expect(scenario.judge(report)).toEqual([]);
  });
});
