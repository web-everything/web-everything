import { describe, expect, it } from 'vitest';
import { timeoutRetryFiles, isolatedRetryFailures, describeIsolatedRetry, isolatedRetryAudit, FLAKY_OUTSIDE_DIFF,
  MAX_TIMEOUT_LOG_BYTES } from '../gate-timeout-retry.mjs';
import { createFailureCollector } from '../verify-failures.mjs';

function evidence(messages = ['Error: Test timed out in 5000ms.'], files = ['a.test.mjs']) {
  const stderr = messages.map((m, i) => ` FAIL  ${files[i] || files[0]} > case ${i}\n${m}\n`).join('');
  const stdout = ` Test Files  ${new Set(files).size} failed\n Tests  ${messages.length} failed\n Duration  5.1s\n`;
  const collector = createFailureCollector({ cwd: '/repo' });
  collector.push(stderr, 'stderr'); collector.push(stdout);
  return { stdout, stderr, failureDetails: collector.finish(), changedFiles: ['source.mjs'], cwd: '/repo' };
}

describe('timeout retry inventory', () => {
  it('deduplicates complete timeout-only failures in untouched files', () => {
    const e = evidence(Array(3).fill('Error: Test timed out in 5000ms.'), ['a.test.mjs', 'a.test.mjs', 'b.test.mjs']);
    expect(timeoutRetryFiles(e)).toEqual(['a.test.mjs', 'b.test.mjs']);
  });
  it('normalizes absolute and relative edited paths', () => {
    expect(timeoutRetryFiles({ ...evidence(), changedFiles: ['./a.test.mjs'] })).toEqual([]);
    const e = evidence(undefined, ['/repo/a.test.mjs']);
    expect(timeoutRetryFiles(e)).toEqual(['a.test.mjs']);
    expect(timeoutRetryFiles({ ...e, changedFiles: ['a.test.mjs'] })).toEqual([]);
  });
  it.each([
    ['mixed', e => { e.stderr += 'AssertionError: wrong value\n'; }],
    ['truncated', e => { e.failureDetails.truncated = true; }],
    ['missing totals', e => { e.stdout = ''; }],
    ['unknown diff', e => { e.changedFiles = null; }],
    ['unhandled error', e => { e.stderr += 'Unhandled Errors\n'; }],
    ['suite failure', e => { e.stderr += ' FAIL  collection.test.mjs\n'; }],
    ['missing failure', e => { e.stdout = e.stdout.replace('Tests  1', 'Tests  2'); }],
    ['oversized log', e => { e.stdout += 'x'.repeat(MAX_TIMEOUT_LOG_BYTES); }],
  ])('refuses %s', (_, alter) => {
    const e = evidence(); alter(e); expect(timeoutRetryFiles(e)).toEqual([]);
  });
  it('does not authorize from a timeout substring in an assertion', () => {
    expect(timeoutRetryFiles(evidence(['AssertionError: expected Test timed out in 5000ms.']))).toEqual([]);
  });
  it('refuses an inventory truncated by the actual collector', () => {
    const e = evidence(Array(21).fill('Error: Test timed out in 5000ms.'), Array.from({ length: 21 }, (_, i) => `${i}.test.mjs`));
    expect(e.failureDetails.truncated).toBe(true);
    expect(timeoutRetryFiles(e)).toEqual([]);
  });
});

// 75c — the isolated re-run covers any failure kind, but only when EVERY failing file is outside the diff.
describe('isolated retry of failures in untouched files (75c)', () => {
  const assertion = 'AssertionError: expected 303 to be less than 250';
  it('assertion failure in an untouched file is retried, classified per file', () => {
    expect(isolatedRetryFailures(evidence([assertion]))).toEqual([{ file: 'a.test.mjs', kind: 'assertion' }]);
    const mixed = evidence([assertion, 'Error: Test timed out in 5000ms.'], ['a.test.mjs', 'b.test.mjs']);
    expect(isolatedRetryFailures(mixed)).toEqual([{ file: 'a.test.mjs', kind: 'assertion' }, { file: 'b.test.mjs', kind: 'timeout' }]);
  });
  it('assertion failure in an untouched file: an edited failing file refuses the whole retry', () => {
    const e = evidence([assertion, assertion], ['a.test.mjs', 'b.test.mjs']);
    expect(isolatedRetryFailures({ ...e, changedFiles: ['source.mjs', 'b.test.mjs'] })).toEqual([]);
  });
  it('assertion failure in an untouched file: more than 3 failing files is not a flake', () => {
    const three = ['a', 'b', 'c'].map(n => `${n}.test.mjs`);
    expect(isolatedRetryFailures(evidence(Array(3).fill(assertion), three))).toHaveLength(3);
    const four = ['a', 'b', 'c', 'd'].map(n => `${n}.test.mjs`);
    expect(isolatedRetryFailures(evidence(Array(4).fill(assertion), four))).toEqual([]);
  });
  it('keeps every completeness guard in untouched mode', () => {
    for (const alter of [e => { e.failureDetails.truncated = true; }, e => { e.stderr += 'Unhandled Errors\n'; },
      e => { e.changedFiles = null; }, e => { e.stdout = e.stdout.replace('Tests  1', 'Tests  2'); }]) {
      const e = evidence([assertion]); alter(e); expect(isolatedRetryFailures(e)).toEqual([]);
    }
  });
  it("mode 'timeouts' is the pre-75c rule and 'off' never retries", () => {
    expect(isolatedRetryFailures({ ...evidence([assertion]), mode: 'timeouts' })).toEqual([]);
    expect(isolatedRetryFailures({ ...evidence(), mode: 'timeouts' })).toEqual([{ file: 'a.test.mjs', kind: 'timeout' }]);
    expect(isolatedRetryFailures({ ...evidence(), mode: 'off' })).toEqual([]);
  });
  it('records a pass alone as flaky-outside-diff, and keeps the old field for timeout files', () => {
    const audit = isolatedRetryAudit([{ file: 'a.test.mjs', kind: 'assertion' }, { file: 'b.test.mjs', kind: 'timeout' }], FLAKY_OUTSIDE_DIFF);
    expect(audit).toEqual({ retriedFailures: expect.any(Array), isolatedRetry: 'flaky-outside-diff', retriedTimeouts: ['b.test.mjs'] });
    expect(describeIsolatedRetry(audit)).toContain('a.test.mjs (assertion)');
    expect(describeIsolatedRetry(audit)).toContain('flaky-outside-diff');
    expect(describeIsolatedRetry({ ...audit, isolatedRetry: 'still-red' })).toContain('still failed alone');
    expect(isolatedRetryAudit([], FLAKY_OUTSIDE_DIFF)).toEqual({});
    expect(describeIsolatedRetry({ retriedTimeouts: ['x.test.mjs'] })).toContain('timeout-only failures');
  });
});
