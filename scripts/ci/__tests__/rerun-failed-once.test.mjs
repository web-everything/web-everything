// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parseReport, planRetry, retryVerdict, rerunOnce, resolvePolicy } from '../rerun-failed-once.mjs';
import UnitJsonReporter from '../unit-json-reporter.mjs';

const root = '/repo';
const policy = { enabled: true, maxFiles: 10 };
const report = (...testResults) => JSON.stringify({ numUnhandledErrors: 0, testResults });
const entry = (name, status = 'failed', extra = {}) => ({ name, status, assertionResults: [], ...extra });
const passingEntry = (name = 'a.test.mjs') => entry(name, 'passed', { assertionResults: [{ fullName: 'suite fails', status: 'passed' }] });
const firstText = report(entry('/repo/a.test.mjs', 'failed', { assertionResults: [{ status: 'failed', fullName: 'suite fails' }] }));
const first = planRetry(firstText, policy, root);
const metadata = { shard: '2', sha: 'abc', runId: '123', root, exitCode: 0 };

describe('single failed-file retry core', () => {
  it.each([undefined, null, '0', -1, 1])('fails closed on missing, invalid or nonzero global error counts (%s)', numUnhandledErrors => {
    const text = JSON.stringify({ ...JSON.parse(firstText), numUnhandledErrors });
    expect(() => planRetry(text, policy, root)).toThrow(/global error/);
  });
  it.each([{ unhandledErrors: [{ message: 'unhandled rejection' }] }, { errors: [{ message: 'runtime error' }] }, { numRuntimeErrorTestSuites: 1 }])('rejects additional report-level failure evidence %j', global => {
    expect(() => planRetry(JSON.stringify({ ...JSON.parse(firstText), ...global }), policy, root)).toThrow(/global error/);
  });
  it('extracts failed assertions and file/collection errors, excluding passed files', () => {
    const text = report(entry('a', 'failed'), entry('b', 'passed'), entry('c', 'passed', { testExecError: { message: 'collection' } }), entry('d', 'passed', { message: 'load failed' }), { name: 'e', errors: [{ message: 'collection failed' }] });
    expect(planRetry(text, policy, root).map(f => f.file)).toEqual(['a', 'c', 'd', 'e']);
    expect(first[0].failedTests).toEqual(['suite fails']);
  });
  it.each([undefined, '', '{', '{}', report(), report(entry('a', 'passed'))])('fails closed on unreadable, empty or non-test failure evidence %s', text => {
    expect(() => planRetry(text, policy, root)).toThrow();
  });
  it('refuses oversized input with an operator-visible manual fallback', () => {
    expect(() => planRetry(report(...Array.from({ length: 11 }, (_, i) => entry(`f${i}`))), policy, root)).toThrow(/cap 10 exceeded.*rerun manually/);
    expect(planRetry(report(...Array.from({ length: 10 }, (_, i) => entry(`f${i}`))), policy, root)).toHaveLength(10);
  });
  it('disabled retry retains the original failure', () => {
    expect(() => planRetry(firstText, { ...policy, enabled: false }, root)).toThrow(/disabled/);
  });
  it.each([entry('../escape'), entry('-option'), entry('a\ncontrol'), entry('a', 'unknown')])('refuses invalid paths/statuses', result => {
    expect(() => parseReport(report(result), root)).toThrow();
  });
  it.each([
    {},
    { assertionResults: [{ status: 'passed' }] },
    { assertionResults: [{ fullName: 'suite fails', status: 'unknown' }] },
    { assertionResults: [{ fullName: 'suite fails', status: 'passed' }, { fullName: 'suite fails', status: 'passed' }] },
  ])('refuses incomplete or ambiguous retry assertion evidence %j', extra => {
    expect(retryVerdict(first, report(entry('a.test.mjs', 'passed', extra)), metadata).passed).toBe(false);
  });
  it('records a passing retry as flaky with portable paths and first-run failed test names', () => {
    expect(retryVerdict(first, report(passingEntry()), metadata)).toEqual({ passed: true, record: {
      shard: '2', sha: 'abc', runId: '123', files: [{ file: 'a.test.mjs', firstRun: 'failed', rerun: 'passed', failedTests: ['suite fails'] }],
    } });
  });
  it.each(['skipped', 'pending', 'todo', 'missing'])('failed assertion becomes %s and remains a real failure', status => {
    const assertionResults = status === 'missing' ? [] : [{ fullName: 'suite fails', status }];
    const verdict = retryVerdict(first, report(entry('a.test.mjs', 'passed', { assertionResults })), metadata);
    expect(verdict.passed).toBe(false);
    expect(verdict.record.files[0].rerun).toBe('failed');
  });
  it('matches failed assertions by ancestorTitles and title when fullName is absent', () => {
    const original = planRetry(report(entry('a.test.mjs', 'failed', { assertionResults: [
      { ancestorTitles: ['suite'], title: 'fails', status: 'failed' },
    ] })), policy, root);
    expect(retryVerdict(original, report(passingEntry()), metadata).passed).toBe(true);
    expect(retryVerdict(original, report(entry('a.test.mjs', 'passed', { assertionResults: [
      { ancestorTitles: ['other'], title: 'fails', status: 'passed' },
    ] })), metadata).passed).toBe(false);
  });
  it('collection-error file recovers with assertions passing and is flaky', () => {
    const original = planRetry(report(entry('a.test.mjs', 'failed', { testExecError: { message: 'collection' } })), policy, root);
    expect(retryVerdict(original, report(passingEntry()), metadata).record.files[0].rerun).toBe('passed');
  });
  it('collection-error recovery requires at least one passed assertion', () => {
    const original = planRetry(report(entry('a.test.mjs')), policy, root);
    expect(retryVerdict(original, report(entry('a.test.mjs', 'passed')), metadata).passed).toBe(false);
  });
  it.each(['skipped', 'pending', 'todo', 'missing'])('collection-error recovery refuses a previously passed assertion becoming %s', status => {
    const original = planRetry(report(entry('a.test.mjs', 'failed', { assertionResults: [
      { fullName: 'previously passed', status: 'passed' },
    ] })), policy, root);
    const retry = passingEntry();
    if (status !== 'missing') retry.assertionResults.push({ fullName: 'previously passed', status });
    expect(retryVerdict(original, report(retry), metadata).passed).toBe(false);
  });
  it.each(['skipped', 'pending', 'todo', 'missing'])('failed-assertion recovery refuses a previously passed assertion becoming %s', status => {
    const original = planRetry(report(entry('a.test.mjs', 'failed', { assertionResults: [
      { fullName: 'suite fails', status: 'failed' }, { fullName: 'previously passed', status: 'passed' },
    ] })), policy, root);
    const retry = passingEntry();
    if (status !== 'missing') retry.assertionResults.push({ fullName: 'previously passed', status });
    expect(retryVerdict(original, report(retry), metadata).passed).toBe(false);
    retry.assertionResults = [{ fullName: 'suite fails', status: 'passed' }, { fullName: 'previously passed', status: 'passed' }];
    expect(retryVerdict(original, report(retry), metadata).passed).toBe(true);
  });
  it.each([report(entry('a.test.mjs')), report(), undefined, report(entry('a.test.mjs', 'skipped')), report(entry('a.test.mjs', 'passed', { testExecError: {} }))])('a second failure or incomplete evidence fails the shard', text => {
    const verdict = retryVerdict(first, text, metadata);
    expect(verdict.passed).toBe(false);
    expect(verdict.record.files[0].rerun).toBe('failed');
  });
  it('a process failure remains red even with passing files', () => {
    expect(retryVerdict(first, report(passingEntry()), { ...metadata, exitCode: 1 }).passed).toBe(false);
  });
  it('mixed flaky and reproducible failures retain both records and fail the shard', () => {
    const files = planRetry(report(entry('a'), entry('b')), policy, root);
    const verdict = retryVerdict(files, report(passingEntry('a'), entry('b')), { ...metadata, exitCode: 1 });
    expect(verdict.passed).toBe(false);
    expect(verdict.record.files.map(f => f.rerun)).toEqual(['passed', 'failed']);
  });
  it('resolves defaults and standard/platform/tool/environment provenance', () => {
    const log = vi.fn();
    expect(resolvePolicy({ platform: {}, log })).toEqual(policy);
    expect(resolvePolicy({ platform: { maxFiles: 4 }, tool: { enabled: false }, env: { WE_CI_UNIT_RERUN_MAX_FILES: '3' }, log })).toEqual({ enabled: false, maxFiles: 3 });
    expect(log.mock.calls.flat().join('\n')).toMatch(/enabled=false \(tool\).*maxFiles=3 \(env\)/);
    expect(resolvePolicy({ platform: {}, tool: { maxFiles: 0 }, env: { WE_CI_UNIT_RERUN_ENABLED: 'bad' }, log })).toEqual(policy);
  });
});

function fixture(overrides = {}) {
  return { shard: '2', mode: 'nocov', firstExit: '1', teardownFailed: vi.fn(() => false), root, env: { GITHUB_SHA: 'abc', GITHUB_RUN_ID: '123' }, policy,
    skipArgs: ['--exclude=quarantined.test.mjs'],
    read: vi.fn(file => file.includes('timing') ? firstText : report(passingEntry())),
    write: vi.fn(), remove: vi.fn(), run: vi.fn(() => ({ status: 0 })),
    listFiles: vi.fn(async () => ['a.test.mjs', 'other.test.mjs']), warn: vi.fn(), error: vi.fn(), ...overrides };
}

describe('retry IO boundary', () => {
  it('runs exactly once without coverage, preserves skip arguments, clears stale evidence and logs each flake', async () => {
    const io = fixture();
    expect(await rerunOnce(io)).toBe(0);
    expect(io.run).toHaveBeenCalledTimes(1);
    expect(io.run).toHaveBeenCalledWith(['run', 'test:unit', '--', '--reporter=default', '--reporter=./scripts/ci/unit-json-reporter.mjs', '--outputFile.json=coverage/rerun-unit-2.json', 'a.test.mjs', '--exclude=quarantined.test.mjs']);
    expect(io.remove).toHaveBeenCalledWith('coverage/rerun-unit-2.json');
    expect(io.remove.mock.invocationCallOrder[0]).toBeLessThan(io.run.mock.invocationCallOrder[0]);
    expect(io.warn).toHaveBeenCalledTimes(1);
    expect(io.warn).toHaveBeenCalledWith('::warning::flaky test file a.test.mjs');
    expect(JSON.parse(io.write.mock.calls[0][1])).toEqual(retryVerdict(first, report(passingEntry()), metadata).record);
  });
  it('covered retry keeps coverage enabled in a separate directory and runs exactly once', async () => {
    const io = fixture({ mode: 'covered' });
    expect(await rerunOnce(io)).toBe(0);
    expect(io.run).toHaveBeenCalledTimes(1);
    expect(io.run).toHaveBeenCalledWith(['run', 'test:coverage:shard', '--',
      '--coverage.reportOnFailure=true', '--coverage.reportsDirectory=coverage-rerun-2',
      '--reporter=default', '--reporter=./scripts/ci/unit-json-reporter.mjs',
      '--outputFile.json=coverage/rerun-unit-2.json', 'a.test.mjs', '--exclude=quarantined.test.mjs']);
  });
  it.each([undefined, '0', '2', '134', '137'])('refuses a first-run exit %s that is not a plain test failure, before any retry', async firstExit => {
    const io = fixture({ firstExit });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/not a plain test failure.*inspect original run/));
  });
  it('the teardown marker is written by the global teardown and set on both unit steps', async () => {
    const { readFileSync } = await import('node:fs');
    const setup = readFileSync(new URL('../../../vitest.globalSetup.mjs', import.meta.url), 'utf8');
    expect(setup).toMatch(/if \(verdict\.failed\) \{[\s\S]*process\.exitCode = 1;[\s\S]*WE_TEARDOWN_FAILURE_FILE[\s\S]*writeFileSync\(marker/);
    const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci.match(/WE_TEARDOWN_FAILURE_FILE="\$PWD\/coverage\/teardown-failed-unit-\$\{\{ matrix\.shard \}\}" npm run test:(coverage:shard|unit) -- /g)).toHaveLength(2);
  });
  it('refuses to retry when the first run left a global-teardown failure marker', async () => {
    const io = fixture({ teardownFailed: vi.fn(file => file === 'coverage/teardown-failed-unit-2') });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/global teardown.*inspect original run/));
  });
  it.each([undefined, 'unknown'])('refuses missing or unknown coverage mode %s before launching a retry', async mode => {
    const io = fixture({ mode });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/retry mode.*inspect original run/));
  });
  it('missing/unreadable first report never launches a retry', async () => {
    const io = fixture({ read: () => { throw new Error('ENOENT'); } });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
  });
  it('a failed file plus a first-run unhandled error cannot recover even if its file retry would pass', async () => {
    const text = JSON.stringify({ ...JSON.parse(firstText), numUnhandledErrors: 1 });
    const io = fixture({ read: file => file.includes('timing') ? text : report(passingEntry()) });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
    expect(io.listFiles).not.toHaveBeenCalled();
    expect(io.warn).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/global error.*inspect original run/));
  });
  it('missing retry report still writes failure records and never retries twice', async () => {
    const io = fixture({ read: file => { if (file.includes('timing')) return firstText; throw new Error('ENOENT'); } });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(io.write.mock.calls[0][1]).files[0].rerun).toBe('failed');
    expect(io.warn).not.toHaveBeenCalled();
  });
  it('refuses substring filters that would rerun extra files', async () => {
    const io = fixture({ listFiles: async () => ['a.test.mjs', 'extra/a.test.mjs'] });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
  });
  it('failure to write the flake record cannot recover the shard', async () => {
    const io = fixture({ write: () => { throw new Error('disk full'); } });
    expect(await rerunOnce(io)).toBe(1);
  });
});

describe('unit JSON evidence producer', () => {
  it.each([{ errors: [] }, { errors: [{ message: 'unrelated unhandled rejection' }] }])('serializes the actual Vitest global error count alongside failed files: %j', async ({ errors }) => {
    const log = vi.fn();
    const reporter = new UnitJsonReporter();
    reporter.onInit({ config: { root }, logger: { log }, state: { getUnhandledErrors: () => errors } });
    await reporter.onFinished([{ type: 'suite', tasks: [], filepath: '/repo/a.test.mjs', result: { state: 'fail' } }]);
    const text = log.mock.calls[0][0];
    expect(JSON.parse(text)).toMatchObject({ numUnhandledErrors: errors.length, testResults: [{ name: '/repo/a.test.mjs', status: 'failed' }] });
    if (errors.length) expect(() => planRetry(text, policy, root)).toThrow(/global error/);
    else expect(planRetry(text, policy, root)).toHaveLength(1);
  });
  it('refuses to emit a clean count when global error evidence is unavailable', async () => {
    const log = vi.fn();
    const reporter = new UnitJsonReporter();
    reporter.onInit({ config: { root }, logger: { log }, state: { getUnhandledErrors: () => undefined } });
    await expect(reporter.onFinished([])).rejects.toThrow(/cannot determine global unit errors/);
    expect(log).not.toHaveBeenCalled();
  });
  it('a passing retry report with global errors cannot pass the verdict', () => {
    const text = JSON.stringify({ ...JSON.parse(report(passingEntry())), numUnhandledErrors: 1 });
    expect(retryVerdict(first, text, metadata).passed).toBe(false);
  });
});
