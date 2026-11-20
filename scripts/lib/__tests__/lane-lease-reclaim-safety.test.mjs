import { it, expect, vi } from 'vitest';
import { holderPidAlive, laneReclaimDecision, probeLaneReclaim } from '../lane-lease-liveness.mjs';
import { applyReclaimSafety } from '../../conveyor/lease-reaper.mjs';
import { laneGitConfigArgs, laneGitHardeningEnv, scrubGitRepoEnv, LANE_CONFIG_LIST_ARGS } from '../lane-git-hardening.mjs';
import { leaseBody } from '../lane-lease.mjs';

it.each(['clean', 'smudge', 'process'])('refuses lane-defined %s filters before status in the conveyor', driver => {
  const run = vi.fn((_file, args) => args.includes('config')
    ? { status: 0, stdout: `local\0filter.redteam.${driver}\ncommand\0` }
    : { status: 0, stdout: '' });
  const candidate = { dir: 'lane', lease: {}, reason: 'pr-merged' };
  const plan = applyReclaimSafety({ reap: [candidate], keep: [] }, {
    check: (dir, lease) => probeLaneReclaim(dir, lease, { run }),
  });
  expect(run.mock.calls.some(([, args]) => args.includes('status'))).toBe(false);
  expect(plan.reap).toEqual([]);
  expect(plan.keep).toEqual([{ ...candidate, reason: 'stale-but-dirty' }]);
});

it.each(['local', 'worktree'])('reads included filter config in %s scope before status', scope => {
  const run = vi.fn(() => ({ status: 0, stdout: `${scope}\0filter.name.with.dots.clean\ncommand\0` }));
  expect(probeLaneReclaim('lane', {}, { run })).toEqual({ safe: false, reason: 'stale-but-dirty' });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith('git', [...laneGitConfigArgs(), ...LANE_CONFIG_LIST_ARGS],
    expect.objectContaining({ timeout: 5000, maxBuffer: 1024 * 1024 }));
});

it('scrubs inherited config overrides before both config and status', () => {
  const run = vi.fn(() => ({ status: 0, stdout: '' }));
  try {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/lane/config');
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/lane/config');
    vi.stubEnv('GIT_CONFIG', '/lane/innocent-config');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'filter.redteam.clean');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'command');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'filter.redteam.process=command'");
    expect(probeLaneReclaim('lane', {}, { run }).safe).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    for (const [, , { env }] of run.mock.calls) {
      expect(env).toEqual(laneGitHardeningEnv({ ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' }));
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
      expect(env.GIT_CONFIG_SYSTEM).toBeUndefined();
      expect(env.GIT_CONFIG).toBeUndefined();
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(Object.values(env)).not.toContain('filter.redteam.clean');
    }
  } finally { vi.unstubAllEnvs(); }
});

it.each([
  { status: 1, stdout: '' },
  { status: null, error: Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }), stdout: '' },
  { status: 0, error: Object.assign(Error('overflow'), { code: 'ENOBUFS' }), stdout: '' },
  { status: 0, stdout: null },
  { status: 0, stdout: 'local\0filter.redteam.clean\ncommand' },
])('does not run status after incomplete config evidence: %j', config => {
  const run = vi.fn(() => config);
  expect(probeLaneReclaim('lane', {}, { run })).toEqual({ safe: false, reason: 'stale-but-dirty' });
  expect(run).toHaveBeenCalledTimes(1);
});

it('refuses failed status after successful config evidence', () => {
  const run = vi.fn().mockReturnValueOnce({ status: 0, stdout: '' })
    .mockReturnValueOnce({ status: 0, stdout: '' })
    .mockReturnValueOnce({ status: null, error: Error('timeout'), stdout: '' });
  expect(probeLaneReclaim('lane', {}, { run })).toEqual({ safe: false, reason: 'stale-but-dirty' });
  expect(run).toHaveBeenCalledTimes(3);
});

it.each([
  { status: 0, stdout: `160000 ${'a'.repeat(40)} 0\tsubmodule\0` },
  { status: 0, stdout: 'truncated index listing' },
  { status: 0, error: Error('overflow'), stdout: '' },
  { status: 1, stdout: '' },
])('refuses nested or unreadable index evidence before status: %j', staged => {
  const run = vi.fn().mockReturnValueOnce({ status: 0, stdout: '' }).mockReturnValueOnce(staged);
  expect(probeLaneReclaim('lane', {}, { run })).toEqual({ safe: false, reason: 'stale-but-dirty' });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.some(([, args]) => args.includes('status'))).toBe(false);
});

it.each([[true, false, 'stale-but-live'], [false, true, 'stale-but-dirty'],
  [null, false, 'stale-but-live'], [false, null, 'stale-but-dirty']])(
  'refuses unsafe evidence pid=%s dirty=%s', (pidAlive, dirty, reason) => {
    expect(laneReclaimDecision({ pidAlive, dirty })).toEqual({ safe: false, reason });
  });
it('allows a dead holder with a clean tree (including legacy leases without a pid)', () => {
  expect(probeLaneReclaim('lane', {}, { run: () => ({ status: 0, stdout: '' }) })).toEqual({ safe: true, reason: null });
});
it.each([['EPERM', true], ['ESRCH', false], ['EIO', null]])('pid probe handles %s', (code, alive) => {
  const kill = vi.fn(() => { throw Object.assign(Error(code), { code }); });
  expect(holderPidAlive({ pid: 123 }, { kill })).toBe(alive);
  expect(kill).toHaveBeenCalledWith(123, 0);
});
it('observes the live holder with kill(pid, 0)', () => {
  expect(holderPidAlive({ pid: process.pid })).toBe(true);
});
it('refuses foreign-host PID evidence', () => {
  expect(holderPidAlive({ pid: 123, host: 'elsewhere' }, { host: 'here' })).toBe(null);
});
it('uses the boot identity when DHCP changes the hostname', () => {
  const kill = vi.fn();
  expect(holderPidAlive({ pid: 123, host: 'old-name', hostBootId: 'ABCD' }, {
    host: 'new-name', bootId: 'abcd', kill,
  })).toBe(true);
  expect(kill).toHaveBeenCalledWith(123, 0);
});
it('persists boot identity only when the acquire probe supplies it', () => {
  expect(leaseBody({ hostBootId: 'abcd' }).hostBootId).toBe('abcd');
  expect(leaseBody({})).not.toHaveProperty('hostBootId');
});
it.each([null, 'other-boot'])('refuses hostname changes with unknown or foreign boot evidence: %s', bootId => {
  const kill = vi.fn();
  expect(holderPidAlive({ pid: 123, host: 'old-name', hostBootId: 'abcd' }, {
    host: 'new-name', bootId, kill,
  })).toBe(null);
  expect(kill).not.toHaveBeenCalled();
});
it.each([
  () => ({ status: 1, stdout: '' }),
  () => { throw Error('unreadable'); },
  () => ({ status: null, error: Object.assign(Error('overflow'), { code: 'ENOBUFS' }) }),
])('unreadable or oversized git evidence refuses with an operator-visible reason', run => {
  expect(probeLaneReclaim('lane', {}, { run })).toEqual({ safe: false, reason: 'stale-but-dirty' });
});
it('bounds the git probe and detects untracked work', () => {
  const run = vi.fn((_file, args) => ({ status: 0, stdout: args.includes('status') ? '?? work.txt\n' : '' }));
  expect(probeLaneReclaim('lane', {}, { run }).safe).toBe(false);
  expect(run).toHaveBeenCalledWith('git', [...laneGitConfigArgs(), 'status', '--porcelain', '--untracked-files=all'],
    expect.objectContaining({ timeout: 5000, maxBuffer: 1024 * 1024 }));
});
it('hardens the dirty-lane probe environment and argv against lane-controlled fsmonitor', () => {
  const run = vi.fn(() => ({ status: 0, stdout: '' }));
  expect(probeLaneReclaim('lane', {}, { run }).safe).toBe(true);
  const [file, args, options] = run.mock.calls[0];
  expect(file).toBe('git');
  expect(args.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
  expect(options.env).toEqual(laneGitHardeningEnv({ ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' }));
  const pins = Object.fromEntries(Array.from({ length: Number(options.env.GIT_CONFIG_COUNT) }, (_, i) =>
    [options.env[`GIT_CONFIG_KEY_${i}`], options.env[`GIT_CONFIG_VALUE_${i}`]]));
  expect(pins['core.fsmonitor']).toBe('false');
});
it('the conveyor keeps unsafe lanes even with terminal PR evidence', () => {
  const candidate = { dir: 'lane', lease: {}, reason: 'pr-merged' };
  const plan = applyReclaimSafety({ reap: [candidate], keep: [] }, {
    check: () => laneReclaimDecision({ pidAlive: true, dirty: false }),
  });
  expect(plan.reap).toEqual([]);
  expect(plan.keep).toEqual([{ ...candidate, reason: 'stale-but-live' }]);
});
