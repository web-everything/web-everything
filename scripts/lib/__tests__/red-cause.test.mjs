import { describe, expect, it } from 'vitest';
import { classifyRedCause, RED_CAUSES } from '../red-cause.mjs';

const red = (phase, tests = [], summary = '') => ({ phase, result: { exitCode: 1, signal: null, failureDetails: { tests, summary, truncated: false } } });
const ok = (phase) => ({ phase, result: { exitCode: 0, signal: null } });

describe('classifyRedCause (item 99)', () => {
  it('returns null for a plain green run', () => {
    expect(classifyRedCause({ exitCode: 0, phaseResults: [ok('vitest'), ok('standards')] })).toBeNull();
  });
  it('in-diff-failure: a failing file the change touched', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'a.test.mjs', name: 'x' }])], changedFiles: ['a.test.mjs'] }))
      .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['a.test.mjs'] });
  });
  it('out-of-diff-flaky: failing outside the diff, passed alone (gate went green)', () => {
    expect(classifyRedCause({ exitCode: 0, phaseResults: [ok('vitest')], isolatedRetry: 'flaky-outside-diff', retriedFailures: [{ file: 'b.test.mjs' }] }))
      .toEqual({ redCause: 'out-of-diff-flaky', redCauseFiles: ['b.test.mjs'] });
  });
  it('out-of-diff-still-red: still red alone, or outside the diff and not retried', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'b.test.mjs', name: 'x' }])], isolatedRetry: 'still-red', retriedFailures: [{ file: 'b.test.mjs' }], changedFiles: ['a.mjs'] }))
      .toEqual({ redCause: 'out-of-diff-still-red', redCauseFiles: ['b.test.mjs'] });
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'c.test.mjs', name: 'x' }])], changedFiles: ['a.mjs'] }).redCause).toBe('out-of-diff-still-red');
  });
  it('test-timeout', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'a.test.mjs', name: 'x' }], 'Error: Test timed out in 5000ms.')], changedFiles: ['a.test.mjs'] }).redCause).toBe('test-timeout');
  });
  it('standards and scan (a red always-run guard is a scan)', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [ok('vitest'), red('standards')] }).redCause).toBe('standards');
    expect(classifyRedCause({ exitCode: 1, phaseResults: [ok('vitest'), red('scan', [{ file: 'g.test.mjs', name: 'y' }])] }))
      .toEqual({ redCause: 'scan', redCauseFiles: ['g.test.mjs'] });
  });
  it('the first red phase names the cause, later reds only add files', () => {
    expect(classifyRedCause({ exitCode: 1, phaseResults: [red('vitest', [{ file: 'a.test.mjs', name: 'x' }]), red('scan', [{ file: 'g.test.mjs', name: 'y' }])], changedFiles: ['a.test.mjs'] }))
      .toEqual({ redCause: 'in-diff-failure', redCauseFiles: ['a.test.mjs'] });
  });
  it('killed-superseded, infra, refused', () => {
    expect(classifyRedCause({ exitCode: 143, infrastructure: { reason: 'verify-signal' } }).redCause).toBe('killed-superseded');
    expect(classifyRedCause({ exitCode: 1, infrastructure: { reason: 'verify-timeout' } }).redCause).toBe('infra');
    expect(classifyRedCause({ refused: true }).redCause).toBe('refused');
  });
  it('every emitted value is declared', () => {
    for (const c of ['in-diff-failure', 'out-of-diff-flaky', 'out-of-diff-still-red', 'test-timeout', 'standards', 'scan', 'killed-superseded', 'refused', 'infra']) expect(RED_CAUSES).toContain(c);
  });
});
