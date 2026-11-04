import { describe, expect, it } from 'vitest';
import { timeoutRetryFiles, isolatedRetryFailures, describeIsolatedRetry, isolatedRetryAudit, FLAKY_OUTSIDE_DIFF,
  MAX_TIMEOUT_LOG_BYTES, retryKilledFailures } from '../gate-timeout-retry.mjs';
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

describe('killed-child infrastructure failures', () => {
  it.each([
    'AssertionError: child status: expected null to be 0',
    'AssertionError: child status null',
    'Error: child "signal": "SIGKILL"',
    "Error: signal: 'SIGTERM'",
    'Error: spawnSync node ETIMEDOUT',
    'Error: ETIMEDOUT',
    "Error: ENOENT: no such file, open '/private/var/folders/ab/cd/T/task-1/a'",
    "Error: ENOTDIR: not a directory, chdir '/tmp/task-1'",
    'Error: child was killed',
    'Error: child process was killed',
  ])('classifies explicit infra signature: %s', message => {
    expect(isolatedRetryFailures(evidence([message]))).toEqual([{ file: 'a.test.mjs', kind: 'killed' }]);
    expect(isolatedRetryFailures({ ...evidence([message]), changedFiles: ['a.test.mjs'] })).toEqual([]);
  });
  it.each(['Error: killed', 'AssertionError: child was killed', 'AssertionError: expected worker to be killed', 'AssertionError: expected child process to be killed', 'Error: expected worker to be killed', 'AssertionError: status: expected null to be 0', 'AssertionError: expected null to be 0', 'Error: ENOENT /repo/missing', 'Error: signal handler failed', 'AssertionError: wrong value'])('keeps ordinary failures as assertions: %s', message => {
    expect(isolatedRetryFailures(evidence([message]))[0].kind).toBe('assertion');
  });
  it('requires every error message in every failure of a file to match', () => {
    expect(isolatedRetryFailures(evidence(['Error: child was killed\nCaused by: wrong value']))[0].kind).toBe('assertion');
    expect(isolatedRetryFailures(evidence(['Error: child was killed', 'AssertionError: wrong value'], ['a.test.mjs', 'a.test.mjs']))[0].kind).toBe('assertion');
  });
  const killed = () => ({ exitCode: 1, output: evidence(['Error: child was killed']), failureDetails: evidence(['Error: child was killed']).failureDetails });
  const files = [{ file: 'a.test.mjs', kind: 'killed' }];
  const classify = r => isolatedRetryFailures({ ...r.output, failureDetails: r.failureDetails, changedFiles: ['source.mjs'], cwd: '/repo' });
  it('bounds killed retries and records attempts; a pass becomes flaky', async () => {
    let calls = 0;
    const r = await retryKilledFailures({ result: killed(), retriedFailures: files, maxRetries: 3, classify, run: async () => (++calls === 2 ? { exitCode: 0 } : killed()) });
    expect(calls).toBe(2);
    expect(r).toMatchObject({ infraKilledRetries: 2, isolatedRetry: 'flaky-outside-diff' });
  });
  it('stops at the budget and routes an exhausted killed failure as killed', async () => {
    let calls = 0;
    const r = await retryKilledFailures({ result: killed(), retriedFailures: files, maxRetries: 1, classify, run: async () => { calls++; return killed(); } });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ infraKilledRetries: 1, isolatedRetry: 'still-red', retriedFailures: files });
  });
  it('stops on normal assertions, incomplete evidence, and a newly edited file', async () => {
    for (const final of [{ ...killed(), output: evidence(['AssertionError: wrong value']), failureDetails: evidence(['AssertionError: wrong value']).failureDetails }, { exitCode: 1 }]) {
      let calls = 0;
      const r = await retryKilledFailures({ result: killed(), retriedFailures: files, maxRetries: 3, classify, run: async () => { calls++; return final; } });
      expect(calls).toBe(1);
      expect(r.retriedFailures[0].kind).toBe('assertion');
      expect(r.isolatedRetry).toBe('still-red');
    }
    let calls = 0;
    await retryKilledFailures({ result: killed(), retriedFailures: files, maxRetries: 3, classify: () => [], run: async () => { calls++; } });
    expect(calls).toBe(0);
  });
  it.each([{ exitCode: null, signal: 'SIGKILL' }, { exitCode: null, code: 'ETIMEDOUT' }])('retries a signalled or timed out runner: %j', async result => {
    const r = await retryKilledFailures({ result, retriedFailures: files, maxRetries: 1, classify, run: async () => ({ exitCode: 0 }) });
    expect(r.infraKilledRetries).toBe(1);
    expect(r.isolatedRetry).toBe('flaky-outside-diff');
  });
  it('zero disables extra retries', async () => {
    const r = await retryKilledFailures({ result: killed(), retriedFailures: files, maxRetries: 0, classify, run: async () => { throw Error('must not run'); } });
    expect(r.infraKilledRetries).toBe(0);
  });
});

it('an oversized retry budget fails closed to no extra attempts', async () => {
  const r = await retryKilledFailures({ result: { exitCode: 1, signal: 'SIGKILL' }, retriedFailures: [{ file: 'a.test.mjs', kind: 'killed' }], maxRetries: 4, classify: () => [], run: async () => { throw Error('must not run'); } });
  expect(r).toMatchObject({ infraKilledRetries: 0, isolatedRetry: 'still-red' });
});
it('an edited file blocks even a killed runner from being retried', async () => {
  const r = await retryKilledFailures({ result: { exitCode: 1, signal: 'SIGKILL' }, retriedFailures: [{ file: 'a.test.mjs', kind: 'killed' }], maxRetries: 3, classify: () => [], canRetry: () => false, run: async () => { throw Error('must not run'); } });
  expect(r.infraKilledRetries).toBe(0);
});
