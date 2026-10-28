// @vitest-environment node
/** Contract tests for the pending remote admission exports; all execution and load IO is injected. */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { decideRemote, runWithRemoteDecision, resolveAdmissionPolicy, DEFAULT_ADMISSION_CEILING_MS, DEFAULT_FAST_RUN_TIMEOUT_MS } from '../heavy-admission.mjs';

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

  it('remoteExec throws -> refuses local rerun with the error reason', async () => {
    const f = fixture();
    f.remoteExec.mockRejectedValue(new Error('injected transport failure'));
    expect(await runWithRemoteDecision(f)).toEqual({ handled: true, exitCode: 124 });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expect(f.log.mock.calls[1][0]).toContain('injected transport failure');
    expect(f.log.mock.calls[1][0]).toContain('refusing local rerun');
  });

  it('a remoteExec pending until confirmed cancellation times out and falls back to local admission', async () => {
    const f = fixture();
    f.remoteExec.mockImplementation(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ mode: 'cancelled', terminated: true }), { once: true });
    }));
    expect(await runWithRemoteDecision({ ...f, timeoutMs: 20 })).toEqual({ handled: false });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expectLines(f.log, 2, 'remote');
    expect(f.log.mock.calls[1][0]).toBe('heavy-admission: remote failed (remote-timeout) - falling back to local admission\n');
  });

  it('confirms active remote execution has stopped before local execution starts', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const events = [];
      let active = false;
      let confirmTermination;
      f.remoteExec.mockImplementation(({ signal }) => new Promise((resolve) => {
        active = true;
        events.push('remote started');
        signal.addEventListener('abort', () => events.push('abort requested'), { once: true });
        confirmTermination = () => {
          active = false;
          events.push('remote stopped');
          resolve({ mode: 'cancelled', terminated: true });
        };
      }));
      const local = vi.fn(() => {
        expect(active).toBe(false);
        events.push('local started');
      });
      const pending = runWithRemoteDecision({ ...f, timeoutMs: 20 }).then((result) => {
        if (!result.handled) local();
        return result;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(active).toBe(true);
      expect(events).toEqual(['remote started', 'abort requested']);
      expect(local).not.toHaveBeenCalled();
      confirmTermination();
      expect(await pending).toEqual({ handled: false });
      expect(local).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['remote started', 'abort requested', 'remote stopped', 'local started']);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['never resolves', 'missing acknowledgement', 'false acknowledgement', 'rejection', 'late success'])(
    'refuses a local rerun after timeout when remote termination is uncertain: %s', async (outcome) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        let signal;
        f.remoteExec.mockImplementation((options) => new Promise((resolve, reject) => {
          signal = options.signal;
          signal.addEventListener('abort', () => {
            if (outcome === 'missing acknowledgement') resolve({ mode: 'cancelled' });
            if (outcome === 'false acknowledgement') resolve({ mode: 'cancelled', terminated: false });
            if (outcome === 'rejection') reject(new Error('transport closed'));
            if (outcome === 'late success') resolve({ mode: 'remote', code: 0 });
          }, { once: true });
        }));
        const local = vi.fn();
        const pending = runWithRemoteDecision({ ...f, timeoutMs: 20 }).then((result) => {
          if (!result.handled) local();
          return result;
        });
        await vi.advanceTimersByTimeAsync(1020);
        expect(await pending).toEqual({ handled: true, exitCode: 124 });
        expect(signal.aborted).toBe(true);
        expect(local).not.toHaveBeenCalled();
        expectLines(f.log, 2, 'remote');
        expect(f.log.mock.calls[1][0]).toContain('remote-timeout');
        expect(f.log.mock.calls[1][0]).toContain('termination unconfirmed; refusing local rerun');
        expect(f.log.mock.calls[1][0]).toContain('Confirm remote termination before retrying');
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    },
  );

  it.each([
    ['default ceiling without env', undefined, ['npm', 'run', 'build'], DEFAULT_ADMISSION_CEILING_MS],
    ['ceiling from env', { WE_HEAVY_ADMISSION_CEILING_MS: '1234' }, ['npm', 'run', 'build'], 1234],
    ['default fast-run timeout', undefined, ['npx', 'vitest', 'run', 'one.test.mjs'], DEFAULT_FAST_RUN_TIMEOUT_MS],
    ['fast-run timeout from env', { WE_HEAVY_ADMISSION_CEILING_MS: '1234', WE_HEAVY_ADMISSION_FAST_RUN_TIMEOUT_MS: '2345' }, ['npx', 'vitest', 'run', 'one.test.mjs'], 2345],
  ])('uses %s', async (_name, env, commandArgv, expectedMs) => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    try {
      const f = fixture();
      expect(await runWithRemoteDecision({ ...f, env, argv: commandArgv })).toEqual({ handled: true, exitCode: 0 });
      expect(setTimer).toHaveBeenCalledTimes(1);
      expect(setTimer).toHaveBeenCalledWith(expect.any(Function), expectedMs);
    } finally { setTimer.mockRestore(); }
  });

  it.each(['success', 'fallback', 'rejection', 'synchronous throw', 'timeout'])(
    'clears the deadline timer after remote %s', async (outcome) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        if (outcome === 'fallback') f.remoteExec.mockResolvedValue({ mode: 'fallback', reason: 'unavailable' });
        if (outcome === 'rejection') f.remoteExec.mockRejectedValue(new Error('unavailable'));
        if (outcome === 'synchronous throw') f.remoteExec.mockImplementation(() => { throw new Error('unavailable'); });
        if (outcome === 'timeout') f.remoteExec.mockImplementation(() => new Promise(() => {}));
        const pending = runWithRemoteDecision({ ...f, timeoutMs: 20 });
        if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(1020);
        const expected = outcome === 'success' ? { handled: true, exitCode: 0 }
          : outcome === 'fallback' ? { handled: false } : { handled: true, exitCode: 124 };
        expect(await pending).toEqual(expected);
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    },
  );

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
    { mode: 'uncertain', reason: 'ambiguous-result', terminated: false },
  ].map((result) => [result]))('refuses local rerun on unconfirmed result %j', async (result) => {
    const f = fixture();
    f.remoteExec.mockResolvedValue(result);
    expect(await runWithRemoteDecision(f)).toEqual({ handled: true, exitCode: 124 });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expectLines(f.log, 2, 'remote');
    expect(f.log.mock.calls[1][0]).toContain('refusing local rerun');
  });
});
