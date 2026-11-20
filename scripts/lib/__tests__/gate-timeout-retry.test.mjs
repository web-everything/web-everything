import { describe, expect, it } from 'vitest';
import { timeoutRetryFiles, isolatedRetryFailures, describeIsolatedRetry, isolatedRetryAudit, FLAKY_OUTSIDE_DIFF,
  MAX_TIMEOUT_LOG_BYTES, retryFailedPhase, retryPassedFiles, appendTestFlake, scanFailureDiagnostic } from '../gate-timeout-retry.mjs';
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

describe('failed-file retry', () => {
  const report = (files, status = 'passed') => JSON.stringify({ testResults: files.map((file, i) => ({ name: `/repo/${file}`, status: 'passed', assertionResults: [{ fullName: `case ${i}`, status }] })) });
  const red = () => ({ ...{ output: evidence(), failureDetails: evidence().failureDetails }, exitCode: 1 });
  const invoke = (options = {}) => retryFailedPhase({ result: red(), attempts: 1, cwd: '/repo', infrastructureFailure: () => false,
    run: async () => ({ exitCode: 0, retryReportText: report(['a.test.mjs']) }), ...options });
  it('retries edited failures with all completeness guards and the three-file bound intact', () => {
    expect(isolatedRetryFailures({ ...evidence(), mode: 'all', changedFiles: ['a.test.mjs'] })).toHaveLength(1);
    expect(isolatedRetryFailures({ ...evidence(Array(4).fill('AssertionError: bad'), ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs']), mode: 'all' })).toEqual([]);
    expect(isolatedRetryFailures({ ...evidence(), mode: 'all', failureDetails: { ...evidence().failureDetails, truncated: true } })).toEqual([]);
  });
  it('recovers only executed passing assertions, and emits one flake per file', async () => {
    const rows = [];
    const r = await invoke({ onFlake: e => rows.push(e) });
    expect(r.result.exitCode).toBe(0);
    expect(r.flakes).toEqual([{ file: 'a.test.mjs' }]);
    expect(rows).toEqual([{ file: 'a.test.mjs', test: 'case 0' }]);
  });
  it.each(['pending', 'skipped', 'todo', 'failed'])('keeps nominal green red when the original assertion is %s', async status => {
    const r = await invoke({ run: async () => ({ exitCode: 0, retryReportText: report(['a.test.mjs'], status) }) });
    expect(r.result.exitCode).toBe(1);
    expect(r.flakes).toEqual([]);
  });
  it.each(['pending', 'skipped', 'todo', 'failed'])('a %s original plus a passing namesake stays red', async status => {
    const retryReport = JSON.parse(report(['a.test.mjs'], status));
    retryReport.testResults[0].assertionResults.push({ fullName: 'case 0', status: 'passed' });
    const r = await invoke({ run: async () => ({ exitCode: 0, retryReportText: JSON.stringify(retryReport) }) });
    expect(r.result.exitCode).toBe(1);
    expect(r.flakes).toEqual([]);
  });
  it('accepts duplicate names only when every assertion passes', async () => {
    const retryReport = JSON.parse(report(['a.test.mjs']));
    retryReport.testResults[0].assertionResults.push({ fullName: 'case 0', status: 'passed' });
    expect((await invoke({ run: async () => ({ exitCode: 0, retryReportText: JSON.stringify(retryReport) }) })).result.exitCode).toBe(0);
  });
  it('cannot use a passing duplicate file report to hide a skipped original', () => {
    const retryReport = JSON.parse(report(['a.test.mjs']));
    retryReport.testResults.push(JSON.parse(report(['a.test.mjs'], 'pending')).testResults[0]);
    expect(retryPassedFiles(JSON.stringify(retryReport), [{ file: 'a.test.mjs', names: ['case 0'] }], '/repo')).toEqual([]);
  });
  it.each([null, '{}', report([]), report(['other.test.mjs']), report(['a.test.mjs']).replace('case 0', 'other case')])(
    'keeps nominal green red without the exact assertion inventory (%s)', async retryReportText => {
      const r = await invoke({ run: async () => ({ exitCode: 0, retryReportText }) });
      expect(r.result.exitCode).toBe(1);
      expect(r.flakes).toEqual([]);
    });
  it.each(['off', 'timeouts'])('%s refuses assertion retries', async mode => {
    const e = evidence(['AssertionError: wrong value']);
    const r = await invoke({ mode, result: { exitCode: 1, output: e, failureDetails: e.failureDetails },
      run: async () => { throw Error('must not run'); } });
    expect(r.result.exitCode).toBe(1);
    expect(r.retried).toEqual([]);
  });
  it('off refuses timeout retries too', async () => {
    expect((await invoke({ mode: 'off', run: async () => { throw Error('must not run'); } })).retried).toEqual([]);
  });
  it('timeouts allows timeout recovery but stops if a later attempt fails an assertion', async () => {
    expect((await invoke({ mode: 'timeouts' })).result.exitCode).toBe(0);
    const e = evidence(['AssertionError: wrong value']);
    let calls = 0;
    const r = await invoke({ mode: 'timeouts', attempts: 2, run: async () => {
      calls++;
      return { exitCode: 1, output: e, failureDetails: e.failureDetails };
    } });
    expect(calls).toBe(1);
    expect(r.result.exitCode).toBe(1);
  });
  it('refuses unreadable, empty and wrong-file execution reports', () => {
    for (const text of [null, '{bad', '{}', report(['other.test.mjs']), JSON.stringify({ testResults: [{ name: '/repo/a.test.mjs', status: 'passed' }] })])
      expect(retryPassedFiles(text, [{ file: 'a.test.mjs', names: ['case 0'] }], '/repo')).toEqual([]);
  });
  it('matches nested Vitest suite identities using ancestor titles and test title', () => {
    const text = JSON.stringify({ testResults: [{ name: '/repo/a.test.mjs', status: 'passed', assertionResults: [{ ancestorTitles: ['', 'suite', 'nested'], title: 'case', fullName: 'suite nested case', status: 'passed' }] }] });
    expect(retryPassedFiles(text, [{ file: 'a.test.mjs', names: ['suite > nested > case'] }], '/repo')).toHaveLength(1);
  });
  it('retains a repeat red and bounds attempts exactly', async () => {
    let calls = 0;
    const r = await invoke({ attempts: 2, run: async () => { calls++; return red(); } });
    expect(calls).toBe(2);
    expect(r.result.exitCode).toBe(1);
    expect(r.flakes).toEqual([]);
  });
  it.each([{ signal: 'SIGKILL' }, { timedOut: true }, { infrastructure: true }])('never retries infrastructure failures %j', async fields => {
    const r = await invoke({ result: { ...red(), ...fields }, infrastructureFailure: r => r.infrastructure, run: async () => { throw Error('must not run'); } });
    expect(r.retried).toEqual([]);
  });
  it('zero attempts leaves the red untouched', async () => {
    expect((await invoke({ attempts: 0, run: async () => { throw Error('must not run'); } })).retried).toEqual([]);
  });
  it('shrinks the next attempt to only files that remain red', async () => {
    const initial = evidence(['AssertionError: a', 'AssertionError: b'], ['a.test.mjs', 'b.test.mjs']);
    const remaining = evidence(['AssertionError: b'], ['b.test.mjs']);
    remaining.stderr = remaining.stderr.replace('case 0', 'case 1');
    remaining.failureDetails.tests[0].name = 'case 1';
    const calls = [];
    const r = await invoke({ result: { exitCode: 1, output: initial, failureDetails: initial.failureDetails }, attempts: 2,
      run: async files => {
        calls.push(files);
        return calls.length === 1
          ? { exitCode: 1, output: remaining, failureDetails: remaining.failureDetails, retryReportText: report(['a.test.mjs']) }
          : { exitCode: 0, retryReportText: report(['b.test.mjs']).replace('case 0', 'case 1') };
      } });
    expect(calls).toEqual([['a.test.mjs', 'b.test.mjs'], ['b.test.mjs']]);
    expect(r.result.exitCode).toBe(0);
    expect(r.flakes).toHaveLength(2);
  });
  it('requires every original failing assertion across later attempts, even if it stops appearing in red output', async () => {
    const initial = evidence(['AssertionError: a', 'AssertionError: b'], ['a.test.mjs', 'a.test.mjs']);
    const partial = evidence(['AssertionError: b'], ['a.test.mjs']);
    partial.stderr = partial.stderr.replace('case 0', 'case 1');
    partial.failureDetails.tests[0].name = 'case 1';
    let attempts = 0;
    const r = await invoke({ attempts: 2, result: { exitCode: 1, output: initial, failureDetails: initial.failureDetails }, run: async () => {
      attempts++;
      return attempts === 1 ? { exitCode: 1, output: partial, failureDetails: partial.failureDetails }
        : { exitCode: 0, retryReportText: report(['a.test.mjs']).replace('case 0', 'case 1') };
    } });
    expect(attempts).toBe(2);
    expect(r.result.exitCode).toBe(1);
    expect(r.flakes).toEqual([]);
  });
  it('writes JSONL with host metadata and never throws on append or root failure', () => {
    const rows = [];
    expect(appendTestFlake({ file: 'a.test.mjs', test: null, sha: 'abc' }, { root: '/coord', mkdir() {}, append(path, row) { rows.push([path, JSON.parse(row)]); } })).toBe(true);
    expect(rows[0][0]).toBe('/coord/.operations/test-flakes.jsonl');
    expect(rows[0][1]).toMatchObject({ file: 'a.test.mjs', test: null, host: expect.any(String), load: expect.any(Number), at: expect.any(String) });
    expect(appendTestFlake({}, { root: () => { throw Error('root'); } })).toBe(false);
    expect(appendTestFlake({}, { root: '/coord', mkdir() {}, append() { throw Error('full'); } })).toBe(false);
  });
  it('prints the failing scan check and first error, with command fallback', () => {
    expect(scanFailureDiagnostic({ ...red(), output: { stderr: ' FAIL a.test.mjs > case 0\nAssertionError: bad policy\n', stdout: '' } }, 'scanner')).toBe('FAIL a.test.mjs > case 0: AssertionError: bad policy\n');
    expect(scanFailureDiagnostic({ exitCode: 1, output: { stderr: 'Error: loader failed' } }, 'policy scan')).toBe('FAIL policy scan: Error: loader failed\n');
  });
});
