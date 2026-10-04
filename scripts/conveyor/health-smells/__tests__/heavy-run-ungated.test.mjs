/** Sustained ungated heavy-run evidence, including the current tick. */
import { expect, it } from 'vitest';
import smell from '../heavy-run-ungated.mjs';
const now = Date.parse('2026-10-04T00:10:00Z');
const processes = [{ pid: 10, ppid: 1, command: 'claude' }, { pid: 11, ppid: 10, command: 'vitest run x' }];
const prior = { at: new Date(now - 60000).toISOString(), count: 1, runs: [{ pid: 11, programName: 'claude', command: 'vitest run x' }] };
const evaluate = (heavyRunSamples = [], config = {}) => smell.evaluate({ processes, heavyRunSamples }, { now, config })[0];
it('requires two breaching samples by default and names the program', () => {
  expect(evaluate().breach).toBe(false);
  const result = evaluate([prior]);
  expect(result).toMatchObject({ subject: 'host', breach: true, measure: { samplesInWindow: 2, breachingSamples: 2, current: 1, programs: [{ programName: 'claude', runs: 2, pids: [11] }] } });
  expect(result.summary).toContain('claude ×2');
  expect(result.recommendation).toContain('claude');
  expect(result.recommendation).toContain('node scripts/readiness/heavy-admission.mjs run -- <cmd>');
});
it('honors all threshold overrides and excludes expired samples', () => {
  expect(evaluate([], { heavyRunUngatedMinSamples: 1 }).breach).toBe(true);
  expect(evaluate([prior], { heavyRunUngatedMinRuns: 3 }).breach).toBe(false);
  expect(evaluate([prior], { heavyRunUngatedWindowMs: 30000 }).breach).toBe(false);
  expect(evaluate([{ ...prior, at: new Date(now - 600001).toISOString() }]).measure.samplesInWindow).toBe(1);
});
it('does not count error samples and returns only the top five programs', () => {
  const result = evaluate([{ at: prior.at, error: 'ps failed' }, ...Array.from({ length: 7 }, (_, i) => ({ ...prior, runs: [{ pid: i, programName: `p${i}` }] }))]);
  expect(result.measure.breachingSamples).toBe(8);
  expect(result.measure.programs).toHaveLength(5);
});
