// @vitest-environment node
/** Contract tests for the pending remote admission exports; all execution and load IO is injected. */
import { describe, it, expect, vi } from 'vitest';
import { decideRemote, runWithRemoteDecision, resolveAdmissionPolicy } from '../heavy-admission.mjs';

const argv = ['npm', 'run', 'test:unit', '--', 'a file.test.mjs', '$(must-stay-literal)'];
const remoteDefaults = { enabled: false, mode: 'above-threshold', loadPerCoreThreshold: 3 };
const policyFor = (remote = {}) => resolveAdmissionPolicy({
  platform: { remote: { ...remoteDefaults, enabled: true, ...remote } },
});

function expectDecision(result, remote) {
  expect(result).toEqual({ remote, reason: expect.any(String) });
  expect(result.reason.trim()).not.toBe('');
}

function fixture({ remote = {}, load = 4, result = { mode: 'remote', code: 0 } } = {}) {
  return {
    argv: [...argv], policy: policyFor(remote), cwd: 'fixture-checkout',
    loadPerCore: vi.fn(() => load), remoteExec: vi.fn(async () => result), log: vi.fn(),
  };
}

function expectLines(log, count, direction) {
  expect(log).toHaveBeenCalledTimes(count);
  for (const call of log.mock.calls) {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe('string');
    expect(call[0].trim()).not.toBe('');
  }
  expect(log.mock.calls[0][0]).toMatch(new RegExp(direction, 'i'));
}

function expectFallback(log, reason) {
  expectLines(log, 2, 'remote');
  expect(log.mock.calls[1][0]).toMatch(/fallback/i);
  if (reason) expect(log.mock.calls[1][0]).toContain(reason);
  else expect(log.mock.calls[1][0].replace(/fallback/gi, '').replace(/[^a-z0-9]/gi, '')).not.toBe('');
}

describe('remote admission policy', () => {
  it('defaults to disabled, above-threshold, threshold 3, with standard sources', () => {
    const policy = resolveAdmissionPolicy({});
    expect(policy.settings.remote).toEqual(remoteDefaults);
    expect(policy.sources).toMatchObject({
      'remote.enabled': 'standard',
      'remote.mode': 'standard',
      'remote.loadPerCoreThreshold': 'standard',
    });
    expect(policy.invalid).toEqual([]);
  });

  it('resolves valid platform remote settings and their provenance', () => {
    const remote = { enabled: true, mode: 'always', loadPerCoreThreshold: 5 };
    const policy = policyFor(remote);
    expect(policy.settings.remote).toEqual(remote);
    expect(policy.sources).toMatchObject({
      'remote.enabled': 'platform',
      'remote.mode': 'platform',
      'remote.loadPerCoreThreshold': 'platform',
    });
    expect(policy.invalid).toEqual([]);
  });

  it('rejects bogus mode and negative threshold into invalid and keeps defaults', () => {
    const policy = resolveAdmissionPolicy({
      platform: { remote: { mode: 'bogus', loadPerCoreThreshold: -1 } },
    });
    expect(policy.settings.remote).toEqual(remoteDefaults);
    expect(policy.sources).toMatchObject({
      'remote.mode': 'standard', 'remote.loadPerCoreThreshold': 'standard',
    });
    expect(policy.invalid).toEqual(expect.arrayContaining([
      expect.stringContaining('platform.remote.mode'),
      expect.stringContaining('platform.remote.loadPerCoreThreshold'),
    ]));
  });
});

describe('decideRemote', () => {
  it.each([
    ['below threshold -> local', {}, 2.9, false],
    ['at threshold -> local', {}, 3, false],
    ['above -> remote', {}, 3.1, true],
    ['disabled -> local', { enabled: false }, 100, false],
    ['disabled always -> local', { enabled: false, mode: 'always' }, 100, false],
    ['always -> remote', { mode: 'always' }, 0, true],
    ['custom threshold below -> local', { loadPerCoreThreshold: 5 }, 4, false],
    ['custom threshold above -> remote', { loadPerCoreThreshold: 1 }, 2, true],
  ])('%s', (_name, remote, loadPerCore, expected) => {
    expectDecision(decideRemote({ policy: policyFor(remote), loadPerCore, argv }), expected);
  });

  it.each([NaN, Infinity, -Infinity, undefined, null, '4', {}, []])(
    'unreadable load %j -> local with load-unreadable reason', (loadPerCore) => {
      const result = decideRemote({ policy: policyFor(), loadPerCore, argv });
      expectDecision(result, false);
      expect(result.reason).toContain('load-unreadable');
    },
  );
});

describe('runWithRemoteDecision', () => {
  it.each([
    ['below threshold -> local', {}, 2.9],
    ['at threshold -> local', {}, 3],
    ['disabled -> local', { enabled: false }, 100],
    ['unreadable load -> local', {}, NaN],
  ])('%s without calling remoteExec', async (_name, remote, load) => {
    const f = fixture({ remote, load });
    expect(await runWithRemoteDecision(f)).toEqual({ handled: false });
    expect(f.remoteExec).not.toHaveBeenCalled();
    expectLines(f.log, 1, 'local');
    if (Number.isNaN(load)) expect(f.log.mock.calls[0][0]).toContain('load-unreadable');
  });

  it.each([
    ['above -> remote', {}, 4, 0],
    ['always -> remote', { mode: 'always' }, 0, 0],
    ['nonzero remote code stays handled', {}, 4, 7],
  ])('%s and passes the exact argv and cwd through', async (_name, remote, load, code) => {
    const f = fixture({ remote, load, result: { mode: 'remote', code } });
    const originalArgv = [...f.argv];
    expect(await runWithRemoteDecision(f)).toEqual({ handled: true, exitCode: code });
    expect(f.loadPerCore).toHaveBeenCalledTimes(1);
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expect(f.remoteExec).toHaveBeenCalledWith(expect.objectContaining({ argv: originalArgv, cwd: f.cwd }));
    expect(f.remoteExec.mock.calls[0][0].argv).toBe(f.argv);
    expect(f.argv).toEqual(originalArgv);
    expectLines(f.log, 1, 'remote');
  });

  it('remote fails -> local fallback with the returned reason', async () => {
    const reason = 'remote receipt unavailable';
    const f = fixture({ result: { mode: 'fallback', reason } });
    expect(await runWithRemoteDecision(f)).toEqual({ handled: false });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expectFallback(f.log, reason);
  });

  it('remoteExec throws -> local fallback with the error reason', async () => {
    const f = fixture();
    f.remoteExec.mockRejectedValue(new Error('injected transport failure'));
    expect(await runWithRemoteDecision(f)).toEqual({ handled: false });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expectFallback(f.log, 'injected transport failure');
  });

  it.each([
    { mode: 'remote' },
    { mode: 'remote', code: undefined },
    { mode: 'remote', code: null },
    { mode: 'remote', code: '0' },
    { mode: 'remote', code: NaN },
    { mode: 'remote', code: Infinity },
    { mode: 'remote', code: -Infinity },
    { mode: 'remote', code: 0.5 },
    { mode: 'unknown', code: 0 },
    { code: 0 },
    {}, null, undefined, 0, 'remote',
  ].map((result) => [result]))('never green on unconfirmed result %j -> local fallback', async (result) => {
    const f = fixture();
    f.remoteExec.mockResolvedValue(result);
    expect(await runWithRemoteDecision(f)).toEqual({ handled: false });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expectFallback(f.log);
  });
});
