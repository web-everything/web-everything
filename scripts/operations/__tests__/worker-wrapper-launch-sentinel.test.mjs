/** Smoke sentinels must never reach a real worker without deliberate opt-in. */
import { describe, it, expect, vi } from 'vitest';
import { launchWrappedClaudeWorker, WRAPPED_ROLES_DEFAULT_ON } from '../worker-wrapper-launch.mjs';

const options = (launch, over = {}) => ({
  role: 'fix', session: 'fix-900002', pr: 900002, env: {},
  bgArgv: ['--bg', '-n', 'fix-900002', 'PROMPT'], specDir: 'unused-specs', launch, ...over,
});
const refusal = 'operations: refusing to launch a real claude worker for smoke sentinel PR #900002 (set smokeRealWorker.allowSentinel or WE_SMOKE_ALLOW_REAL_WORKER=1 to allow)';

describe('wrapped smoke sentinel refusal', () => {
  it.each(WRAPPED_ROLES_DEFAULT_ON)('refuses default-on role %s before launch', (role) => {
    const launch = vi.fn(() => ({ wrapperPid: 4321 }));
    expect(() => launchWrappedClaudeWorker(options(launch, { role, session: `${role}-900002` }))).toThrow(refusal);
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([null, 5304])('also refuses a sentinel session slug with PR %s', (pr) => {
    const launch = vi.fn(() => ({ wrapperPid: 4321 }));
    expect(() => launchWrappedClaudeWorker(options(launch, { pr }))).toThrow(refusal);
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([{ allowRealSentinel: true }, { env: { WE_SMOKE_ALLOW_REAL_WORKER: '1' } }])('allows explicit opt-in: %j', (over) => {
    const launch = vi.fn(() => ({ wrapperPid: 4321 }));
    expect(launchWrappedClaudeWorker(options(launch, over)).handle).toBe('pid:4321');
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('lets an explicit refusal override an allowing env', () => {
    const launch = vi.fn(() => ({ wrapperPid: 4321 }));
    expect(() => launchWrappedClaudeWorker(options(launch, { allowRealSentinel: false, env: { WE_SMOKE_ALLOW_REAL_WORKER: '1' } }))).toThrow(refusal);
    expect(launch).not.toHaveBeenCalled();
  });
  it('allows a normal PR', () => {
    const launch = vi.fn(() => ({ wrapperPid: 4321 }));
    expect(launchWrappedClaudeWorker(options(launch, { pr: 5304, session: 'fix-5304' })).handle).toBe('pid:4321');
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
