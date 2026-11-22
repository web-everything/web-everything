// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { rerunOnce, resolvePolicy } from '../rerun-failed-once.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const policy = { enabled: true, maxFiles: 10 };
const report = (status = 'failed') => JSON.stringify({
  numUnhandledErrors: 0,
  testResults: [{ name: 'a.test.mjs', status,
    assertionResults: [{ fullName: 'suite fails', status }] }],
});
const fixture = (overrides = {}) => ({
  shard: '2', mode: 'nocov', firstExit: 1, root: process.cwd(), policy,
  env: { GITHUB_SHA: 'abc', GITHUB_RUN_ID: '123' },
  teardownFailed: () => false,
  read: vi.fn(file => report(file.includes('timing') ? 'failed' : 'passed')),
  write: vi.fn(), remove: vi.fn(), run: vi.fn(() => ({ status: 0 })),
  listFiles: vi.fn(async () => ['a.test.mjs']), warn: vi.fn(), error: vi.fn(),
  ...overrides,
});
const record = io => JSON.parse(io.write.mock.calls[0][1]);

describe('single failed-file retry', () => {
  it('a real failure stays red after exactly one retry, never a second retry', async () => {
    const io = fixture({ read: vi.fn(() => report()), run: vi.fn(() => ({ status: 1 })) });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).toHaveBeenCalledTimes(1);
    expect(io.write).toHaveBeenCalledTimes(1);
    expect(record(io).files).toEqual([{
      file: 'a.test.mjs', firstRun: 'failed', rerun: 'failed', failedTests: ['suite fails'],
    }]);
    expect(io.warn).not.toHaveBeenCalled();
  });
  it('a flaky file passing its only retry is recorded and the shard goes green', async () => {
    const io = fixture();
    expect(await rerunOnce(io)).toBe(0);
    expect(io.run).toHaveBeenCalledTimes(1);
    expect(io.remove).toHaveBeenCalledWith('coverage/rerun-unit-2.json');
    expect(io.remove.mock.invocationCallOrder[0]).toBeLessThan(io.run.mock.invocationCallOrder[0]);
    expect(io.write).toHaveBeenCalledWith('coverage/flaky-unit-2.json', expect.any(String));
    expect(record(io)).toEqual({ shard: '2', sha: 'abc', runId: '123', files: [{
      file: 'a.test.mjs', firstRun: 'failed', rerun: 'passed', failedTests: ['suite fails'],
    }] });
    expect(io.warn).toHaveBeenCalledWith('::warning::flaky test file a.test.mjs');
  });
  it('a disabled setting keeps the original failure without launching a retry', async () => {
    const disabled = resolvePolicy({ platform: {}, tool: { enabled: false }, env: {}, log: vi.fn() });
    const io = fixture({ policy: disabled });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/disabled.*inspect original run/));
  });
  it.each([
    ['rejects retry missing an originally passing assertion', 'passed', undefined],
    ['rejects retry skipping an originally failing assertion', 'failed', 'skipped'],
  ])('%s', async (_name, status, retryStatus) => {
    const first = JSON.parse(report()), retry = JSON.parse(report('passed'));
    first.testResults[0].assertionResults.push({ fullName: 'original assertion', status });
    if (retryStatus) retry.testResults[0].assertionResults.push({ fullName: 'original assertion', status: retryStatus });
    const io = fixture({ read: vi.fn(file => JSON.stringify(file.includes('timing') ? first : retry)) });
    expect(await rerunOnce(io)).toBe(1);
    expect(record(io).files[0].rerun).toBe('failed');
  });
  it.each([
    ['platform', 'enabled', 'flase'], ['platform', 'maxFiles', 0],
    ['tool', 'enabled', 'flase'], ['tool', 'maxFiles', 0],
    ['env', 'enabled', 'flase'], ['env', 'maxFiles', '0'],
    ['loaded-platform', 'enabled', 'flase'], ['loaded-platform', 'maxFiles', 0],
  ])('malformed %s %s disables recovery without launching a retry', async (layer, key, value) => {
    const options = { platform: {}, env: {}, log: vi.fn() };
    let dir;
    try {
      if (layer === 'loaded-platform') {
        dir = mkdtempSync(join(process.env.TMPDIR, 'ci-unit-rerun-'));
        const file = join(dir, 'preferences.json');
        writeFileSync(file, JSON.stringify({ ciUnitRerun: { [key]: value } }));
        delete options.platform;
        options.env.WE_PLATFORM_PREFERENCES_FILE = file;
      } else if (layer === 'env') {
        options.env[key === 'enabled' ? 'WE_CI_UNIT_RERUN_ENABLED' : 'WE_CI_UNIT_RERUN_MAX_FILES'] = value;
      } else options[layer] = { [key]: value };
      const resolved = resolvePolicy(options);
      expect(resolved.enabled).toBe(false);
      expect(options.log).toHaveBeenCalledWith(expect.stringContaining(`invalid ${key}`));
      const io = fixture({ policy: resolved });
      expect(await rerunOnce(io)).toBe(1);
      expect(io.run).not.toHaveBeenCalled();
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([undefined, 0, 2, 137])('non-test first-exit code %s is never retried', async firstExit => {
    const io = fixture({ firstExit });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/not a plain test failure/));
  });
  it('a missing or unreadable first report never launches a retry', async () => {
    const io = fixture({ read: vi.fn(() => { throw new Error('unreadable report'); }) });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.listFiles).not.toHaveBeenCalled();
    expect(io.run).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/unreadable report.*inspect original run/));
  });
  it('a missing retry report records failure after one retry without launching another', async () => {
    const io = fixture({ read: vi.fn(file => {
      if (file.includes('timing')) return report();
      throw new Error('missing retry report');
    }) });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).toHaveBeenCalledTimes(1);
    expect(record(io).files[0].rerun).toBe('failed');
    expect(io.warn).not.toHaveBeenCalled();
  });
  it('skip args are preserved alongside covered retry arguments', async () => {
    const skipArgs = ['--exclude=quarantined.test.mjs'];
    const io = fixture({ mode: 'covered', skipArgs });
    expect(await rerunOnce(io)).toBe(0);
    expect(io.run).toHaveBeenCalledTimes(1);
    expect(io.run).toHaveBeenCalledWith([
      'run', 'test:coverage:shard', '--', '--coverage.reportOnFailure=true',
      '--coverage.reportsDirectory=coverage-rerun-2', '--reporter=default',
      '--reporter=./scripts/ci/unit-json-reporter.mjs',
      '--outputFile.json=coverage/rerun-unit-2.json', 'a.test.mjs', ...skipArgs,
    ]);
  });
  it('oversized failed-file evidence refuses retry and tells the operator to rerun manually', async () => {
    const text = JSON.stringify({ numUnhandledErrors: 0, testResults: Array.from({ length: 11 },
      (_, i) => ({ name: `f${i}.test.mjs`, status: 'failed', assertionResults: [] })) });
    const io = fixture({ read: vi.fn(() => text) });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/cap 10 exceeded.*rerun manually/));
  });
});
