// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { rerunOnce, resolvePolicy } from '../rerun-failed-once.mjs';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readPlatformPreferences } from '../../lib/policy-cascade.mjs';

const policy = { enabled: true, maxFiles: 10, flakeAllowlist: ['a.test.mjs'] };
const report = (status = 'failed') => JSON.stringify({ numUnhandledErrors: 0,
  testResults: [{ name: 'a.test.mjs', status, assertionResults: [{ fullName: 'fails', status }] }] });
const identity = JSON.stringify({ runId: '123', sha: 'abc' });
const fixture = (overrides = {}) => {
  const saved = new Map();
  return { shard: '2', mode: 'nocov', firstExit: 1, policy,
    env: { GITHUB_SHA: 'abc', GITHUB_RUN_ID: '123' }, teardownFailed: () => false,
    exists: file => saved.has(file), write: vi.fn((file, data) => saved.set(file, data)),
    remove: vi.fn(), run: vi.fn(() => ({ status: 0 })), listFiles: async () => ['a.test.mjs'],
    warn: vi.fn(), error: vi.fn(),
    read: file => file.includes('first-run') ? identity : report(file.includes('timing') ? 'failed' : 'passed'),
    ...overrides };
};
const record = io => JSON.parse(io.write.mock.calls.find(([file]) => file.includes('flaky-unit'))[1]);
const resolve = options => resolvePolicy({ tool: policy, platform: {}, log: vi.fn(), ...options });
const refused = async io => { expect(await rerunOnce(io)).toBe(1); expect(io.run).not.toHaveBeenCalled(); };

it.each(['nocov', 'covered'].flatMap(mode => [false, true].map(unhandled => ({ mode, unhandled }))))(
  'real retry reporter executes $mode tests (unhandled=$unhandled)', async ({ mode, unhandled }) => {
    const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR, 'ci-retry-reporter-')));
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      symlinkSync(join(repo, 'scripts/ci'), join(dir, 'scripts/ci'));
      symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
      writeFileSync(join(dir, 'vitest.config.mjs'), 'export default { test: { environment: "node", poolOptions: { threads: { minThreads: 1, maxThreads: 1 } } } };');
      writeFileSync(join(dir, 'a.test.mjs'), `import { it } from 'vitest';
        it('fails', async () => {
          ${unhandled ? "Promise.reject(new Error('retry unhandled error')); await new Promise(resolve => setTimeout(resolve, 30));" : ''}
        });`);
      let json;
      const io = fixture({ mode, root: dir,
        // Vitest 1 includes the unnamed root suite in JSON assertion fullName.
        read: file => file.includes('first-run') ? identity : file.includes('timing')
          ? report().replace('"fullName":"fails"', '"fullName":" fails"') : json,
        run: vi.fn(args => {
          expect(args[1]).toBe(mode === 'covered' ? 'test:coverage:shard' : 'test:unit');
          const result = spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run',
            ...(mode === 'covered' ? ['--coverage'] : []), ...args.slice(3)],
          { cwd: dir, env: process.env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(unhandled ? 1 : 0);
          json = readFileSync(join(dir, 'coverage/rerun-unit-2.json'), 'utf8');
          return result;
        }),
      });
      expect(await rerunOnce(io), io.error.mock.calls.flat().join('\n')).toBe(unhandled ? 1 : 0);
      expect(io.run).toHaveBeenCalledTimes(1);
      expect(JSON.parse(json).numUnhandledErrors).toBe(unhandled ? 1 : 0);
      expect(record(io).files[0].rerun).toBe(unhandled ? 'failed' : 'passed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 45000);

it('a real failure stays red after one retry', async () => {
  const io = fixture({ read: file => file.includes('first-run') ? identity : report(), run: vi.fn(() => ({ status: 1 })) });
  expect(await rerunOnce(io)).toBe(1);
  expect(io.run).toHaveBeenCalledTimes(1);
  expect(record(io).files[0].rerun).toBe('failed');
  expect(io.warn).not.toHaveBeenCalled();
});
it('default policy keeps retries off', async () => {
  await refused(fixture({ policy: resolve({ tool: {} }) }));
});
it('settings read errors fail closed even with enabled platform policy', async () => {
  await refused(fixture({ policy: resolve({ tool: undefined, platform: policy,
    readSettings: () => ({ value: {}, taint: [{ reason: 'unreadable' }] }) }) }));
});
it('invalid settings fail closed', async () => {
  await refused(fixture({ policy: resolve({ tool: { enabled: 'true' } }) }));
});
it('environment cannot enable disabled retries or raise the cap', () => {
  expect(resolve({ tool: { enabled: false }, env: { WE_CI_UNIT_RERUN_ENABLED: 'true' } }).enabled).toBe(false);
  expect(resolve({ tool: { enabled: true, maxFiles: 2 }, env: { WE_CI_UNIT_RERUN_MAX_FILES: '3' } }).maxFiles).toBe(2);
});
it('missing or stale sidecar refuses a launch', async () => {
  await refused(fixture({ read: () => { throw Error('missing sidecar'); } }));
  await refused(fixture({ read: () => JSON.stringify({ runId: 'old', sha: 'abc' }) }));
});
it('non-allowlisted flake still fails', async () => {
  const io = fixture({ policy: { ...policy, flakeAllowlist: [] } });
  expect(await rerunOnce(io)).toBe(1);
  expect(record(io).files[0].rerun).toBe('passed');
});
it('allowlisted flake recovers and records its identity', async () => {
  const io = fixture();
  expect(await rerunOnce(io)).toBe(0);
  expect(record(io)).toMatchObject({ shard: '2', sha: 'abc', runId: '123' });
  expect(io.warn).toHaveBeenCalledWith('::warning::flaky test file a.test.mjs');
});
it('second invocation with the same evidence launches nothing', async () => {
  const io = fixture();
  expect(await rerunOnce(io)).toBe(0);
  expect(io.write).toHaveBeenCalledWith('coverage/rerun-used-2.json', identity, { flag: 'wx' });
  expect(io.write.mock.invocationCallOrder[0]).toBeLessThan(io.run.mock.invocationCallOrder[0]);
  io.run.mockClear();
  await refused(io);
  expect(io.error).toHaveBeenCalledWith(expect.stringContaining('allowance already used'));
});
it('aggregate count of two with only one failed assertion refuses retry', async () => {
  const io = fixture({ read: file => file.includes('first-run') ? identity
    : JSON.stringify({ ...JSON.parse(report()), numFailedTests: 2 }) });
  await refused(io);
  expect(io.error).toHaveBeenCalledWith(expect.stringContaining('numFailedTests mismatch'));
});
it('duplicate enabled keys in platform JSON disable retries', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'ci-unit-rerun-'));
  try {
    const file = join(dir, 'policy.json');
    writeFileSync(file, '{"ciUnitRerun":{"enabled":false,"enabled":true}}');
    const log = vi.fn();
    await refused(fixture({ policy: resolve({ platform: undefined, env: { WE_PLATFORM_PREFERENCES_FILE: file }, log }) }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('platform preference read error'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('shared preferences preserve stricter lanes with an unrelated duplicate key and no errors', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'ci-unit-rerun-'));
  try { const file = join(dir, 'policy.json');
    writeFileSync(file, '{"lanes":{"maxConcurrent":1},"unrelated":{"key":false,"key":true}}');
    expect(readPlatformPreferences({ env: { WE_PLATFORM_PREFERENCES_FILE: file } })).toEqual({ prefs: { lanes: { maxConcurrent: 1 }, unrelated: { key: true } }, errors: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('oversized evidence refuses retry with a manual fallback', async () => {
  const io = fixture({ policy: { ...policy, maxFiles: 1 }, read: file => file.includes('first-run') ? identity
    : JSON.stringify({ numUnhandledErrors: 0, testResults: ['a.test.mjs', 'b.test.mjs'].map(name => ({ name, status: 'failed' })) }) });
  await refused(io);
  expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/cap 1 exceeded.*rerun manually/));
});
