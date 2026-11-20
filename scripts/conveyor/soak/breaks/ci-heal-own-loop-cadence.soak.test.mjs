import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { defineBreakTest } from '../define-break-test.mjs';
import b, { cadenceProbe, completedSliceTimestamps } from './ci-heal-own-loop-cadence.mjs';

defineBreakTest(b);

// defineBreakTest uses it.fails when fixPresent is false. Cadence is now required behaviour:
// always use it so a regression cannot turn this acceptance test into an expected failure.
describe('daemon soak — break ci-heal-own-loop-cadence', () => {
  it('keeps logged gate gaps within 150 seconds through two hours of slow passes', async () => {
    const report = await b.run({});
    expect(b.judge(report)).toEqual([]);
    expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
  });

  it('rejects removal of the hook from the real recovery loop', async () => {
    const report = await cadenceProbe({ dropRecoveryHook: true });
    expect(report.elapsedMs).toBe(7200000);
    expect(report.exercised.recovery).toBe(48);
    expect(report.maxGapMs).toBeGreaterThan(150000);
    expect(b.judge(report).length).toBeGreaterThan(0);
  });

  it('counts only dispatch completion lines and refuses missing or failed evidence', () => {
    const at = '2026-09-25T00:00:00.000Z';
    expect(completedSliceTimestamps([
      `ci-heal-pr-dispatch: gate slice at=${at}`, `ci-heal-slice-failed broken at=${at}`,
      `ci-heal-pr-dispatch: gate slice unknown at=${at}`,
      ...['done', 'admitted', 'refused'].map(outcome => `ci-heal-pr-dispatch: gate slice ${outcome} at=${at}`),
    ])).toEqual(Array(3).fill(Date.parse(at)));
    expect(b.judge({ timestamps: [], elapsedMs: 7200000, maxGapMs: 7200000 }).length).toBeGreaterThan(0);
  });
});
