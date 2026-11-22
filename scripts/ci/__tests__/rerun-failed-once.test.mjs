// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { rerunOnce, resolvePolicy } from '../rerun-failed-once.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readSettingsChecked } from '../../lib/settings-files.mjs';

const policy = { enabled: true, maxFiles: 10, flakeAllowlist: ['a.test.mjs'] };
const report = (status = 'failed') => JSON.stringify({
  numUnhandledErrors: 0,
  testResults: [{ name: 'a.test.mjs', status,
    assertionResults: [{ fullName: 'suite fails', status }] }],
});
const identity = JSON.stringify({ runId: '123', sha: 'abc' });
const fixture = ({ sidecar = identity, ...overrides } = {}) => ({
  shard: '2', mode: 'nocov', firstExit: 1, root: process.cwd(), policy,
  env: { GITHUB_SHA: 'abc', GITHUB_RUN_ID: '123' },
  teardownFailed: () => false,
  write: vi.fn(), remove: vi.fn(), run: vi.fn(() => ({ status: 0 })),
  listFiles: vi.fn(async () => ['a.test.mjs']), warn: vi.fn(), error: vi.fn(),
  ...overrides,
  read: vi.fn(file => {
    if (file.includes('first-run')) {
      if (sidecar instanceof Error) throw sidecar;
      return sidecar;
    }
    return overrides.read ? overrides.read(file) : report(file.includes('timing') ? 'failed' : 'passed');
  }),
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
  it('an allowlisted flaky file passing its only retry is recorded and the shard goes green', async () => {
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
  it('default policy refuses retries', async () => {
    const io = fixture({ policy: resolvePolicy({ tool: {}, platform: {}, log: vi.fn() }) });
    expect(io.policy.enabled).toBe(false);
    expect(resolvePolicy({ env: {}, log: vi.fn() }).enabled).toBe(false);
    expect(await rerunOnce(io)).toBe(1);
    expect(io.run).not.toHaveBeenCalled();
  });
  it('invalid whole policies, unknown keys and malformed leaves disable retries', async () => {
    for (const layer of ['platform', 'tool']) {
      for (const value of [null, false, [], 'on', { enable: false }, { enabled: 'flase' }, { maxFiles: 0 }, { flakeAllowlist: ['../a.test.mjs'] }]) {
        const resolved = resolvePolicy({ tool: policy, platform: {}, [layer]: value, log: vi.fn() });
        expect(resolved.enabled, `${layer}: ${JSON.stringify(value)}`).toBe(false);
        const io = fixture({ policy: resolved });
        expect(await rerunOnce(io)).toBe(1);
        expect(io.run).not.toHaveBeenCalled();
      }
    }
    for (const env of [{ WE_CI_UNIT_RERUN_ENABLED: 'flase' }, { WE_CI_UNIT_RERUN_MAX_FILES: '0' }]) {
      expect(resolvePolicy({ tool: policy, platform: {}, env, log: vi.fn() }).enabled).toBe(false);
    }
  });
  it('checked settings and preference read errors cannot fall back to an enabled policy', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'ci-unit-rerun-'));
    const file = join(dir, 'policy.json');
    try {
      for (const unreadable of [false, true]) {
        if (unreadable) { rmSync(file); mkdirSync(file); }
        else writeFileSync(file, '{');
        const log = vi.fn();
        const readSettings = () => readSettingsChecked({ dir, legacyPath: null });
        expect(resolvePolicy({ platform: policy, readSettings, log }).enabled).toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('settings read/shape error'));
        expect(resolvePolicy({ tool: policy, env: { WE_PLATFORM_PREFERENCES_FILE: file }, log }).enabled).toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('preference read error'));
      }
      rmSync(file, { recursive: true });
      for (const value of [policy, null, false, { enable: false }]) {
        writeFileSync(file, JSON.stringify({ ciUnitRerun: value }));
        const readSettings = () => readSettingsChecked({ dir, legacyPath: null });
        expect(resolvePolicy({ platform: {}, readSettings, log: vi.fn() }).enabled).toBe(value === policy);
        expect(resolvePolicy({ tool: {}, env: { WE_PLATFORM_PREFERENCES_FILE: file }, log: vi.fn() }).enabled).toBe(value === policy);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('env cannot enable platform/tool-disabled retries or raise the file cap', () => {
    const resolve = options => resolvePolicy({ tool: policy, platform: {}, log: vi.fn(), ...options });
    for (const layer of ['platform', 'tool']) {
      expect(resolve({ tool: {}, [layer]: { enabled: false }, env: { WE_CI_UNIT_RERUN_ENABLED: 'true' } }).enabled).toBe(false);
    }
    expect(resolve({ tool: { enabled: true, maxFiles: 2 }, env: { WE_CI_UNIT_RERUN_MAX_FILES: '3' } }).maxFiles).toBe(2);
    expect(resolve({ env: { WE_CI_UNIT_RERUN_ENABLED: 'false', WE_CI_UNIT_RERUN_MAX_FILES: '1' } })).toMatchObject({ enabled: false, maxFiles: 1 });
  });
  it('missing, malformed or stale sidecars and empty run identity leave the shard failed', async () => {
    for (const overrides of [
      { sidecar: new Error('missing sidecar') }, { sidecar: '{' }, { sidecar: '{}' },
      { sidecar: JSON.stringify({ runId: 'old', sha: 'abc' }) },
      { sidecar: JSON.stringify({ runId: '123', sha: 'old' }) },
      { env: { GITHUB_RUN_ID: '', GITHUB_SHA: 'abc' } }, { env: { GITHUB_RUN_ID: '123', GITHUB_SHA: '' } },
    ]) {
      const io = fixture(overrides);
      expect(await rerunOnce(io)).toBe(1);
      expect(io.run).not.toHaveBeenCalled();
      expect(io.error).toHaveBeenCalledWith(expect.stringContaining('shard remains failed'));
    }
  });
  it('non-allowlisted passing retries are recorded as flakes but still fail', async () => {
    for (const flakeAllowlist of [undefined, [], ['other.test.mjs']]) {
      const io = fixture({ policy: { ...policy, flakeAllowlist } });
      expect(await rerunOnce(io)).toBe(1);
      expect(record(io).files[0].rerun).toBe('passed');
      expect(io.warn).toHaveBeenCalledWith('::warning::flaky test file a.test.mjs');
    }
  });
  it('one allowlisted recovery cannot hide another non-allowlisted flake', async () => {
    const text = status => {
      const data = JSON.parse(report(status));
      data.testResults.push({ ...data.testResults[0], name: 'b.test.mjs' });
      return JSON.stringify(data);
    };
    const io = fixture({ read: file => text(file.includes('timing') ? 'failed' : 'passed'),
      listFiles: async () => ['a.test.mjs', 'b.test.mjs'] });
    expect(await rerunOnce(io)).toBe(1);
    expect(record(io).files.map(f => f.rerun)).toEqual(['passed', 'passed']);
    expect(io.warn).toHaveBeenCalledTimes(2);
  });
  it('a teardown failure marker prevents any retry', async () => {
    const io = fixture({ teardownFailed: vi.fn(() => true) });
    expect(await rerunOnce(io)).toBe(1);
    expect(io.teardownFailed).toHaveBeenCalledWith('coverage/teardown-failed-unit-2');
    expect(io.run).not.toHaveBeenCalled();
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
