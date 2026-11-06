import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { selectInstaller, runDepsInstaller, markerMatches } from '../lib/lane-deps-installer.mjs';

function select(overrides = {}) {
  return selectInstaller({ which: () => '/bin/pnpm', exec: () => '12.18.0',
    hasPnpmLock: true, hasNpmLock: true, parity: () => true,
    storeDir: '/shared/store', ...overrides });
}
function run(plan, overrides = {}) {
  const exec = vi.fn();
  const remove = vi.fn();
  const result = runDepsInstaller({ plan, hash: 'hash', marker: null,
    hasNodeModules: true, exec, remove, ...overrides });
  return { result, exec, remove };
}

describe('lane deps installer', () => {
  it('probes pnpm version in the OS temp directory instead of the repo', () => {
    const exec = vi.fn(() => '12.18.0');
    expect(select({ exec }).backend).toBe('pnpm');
    expect(exec).toHaveBeenCalledWith('/bin/pnpm', ['--version'], { cwd: tmpdir() });
    expect(exec.mock.calls[0][2].cwd).not.toBe(process.cwd());
  });
  it('pnpm missing falls back to npm', () => {
    expect(select({ which: () => null }).backend).toBe('npm');
  });
  it('unreadable or malformed pnpm version falls back to npm', () => {
    expect(select({ exec: () => { throw Error('probe failed'); } }).backend).toBe('npm');
    expect(select({ exec: () => 'unknown' }).backend).toBe('npm');
  });
  it('invalidates marker before installation, including when npm fails', () => {
    const events = [];
    expect(() => run(select({ which: () => null }), {
      marker: 'npm:old',
      invalidate: () => events.push('invalidate'),
      exec: () => { events.push('install'); throw Error('failure'); },
    })).toThrow('failure');
    expect(events).toEqual(['invalidate', 'install']);
  });
  it('pnpm old falls back to npm', () => {
    expect(select({ exec: () => '11.9.0' }).backend).toBe('npm');
  });
  it('missing pnpm lock falls back to npm', () => {
    expect(select({ hasPnpmLock: false }).backend).toBe('npm');
  });
  it('parity failure or unreadable evidence falls back to npm', () => {
    expect(select({ parity: () => false }).backend).toBe('npm');
    expect(select({ parity: () => { throw Error('unreadable'); } }).backend).toBe('npm');
  });
  it('happy path builds pnpm argv with store-dir and frozen-lockfile', () => {
    expect(select()).toMatchObject({ backend: 'pnpm', command: '/bin/pnpm',
      args: ['install', '--frozen-lockfile', '--store-dir=/shared/store'] });
  });
  it('pnpm non-zero exit wipes partial modules and falls back to npm', () => {
    const exec = vi.fn().mockImplementationOnce(() => { throw Error('exit 1'); });
    const { result, remove } = run(select(), { exec, hasNodeModules: false });
    expect(exec.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['/bin/pnpm', ['install', '--frozen-lockfile', '--store-dir=/shared/store']],
      ['npm', ['ci']],
    ]);
    expect(remove).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ backend: 'npm', marker: 'npm:hash' });
  });
  it.each([['npm:hash', 'pnpm'], ['hash', 'pnpm'], ['pnpm:hash', 'npm']])(
    'marker backend switch %s to %s wipes node_modules before install', (marker, backend) => {
      const plan = backend === 'pnpm' ? select() : select({ which: () => null });
      const events = [];
      run(plan, { marker, remove: () => events.push('remove'), exec: () => events.push('install') });
      expect(events).toEqual(['remove', 'install']);
    });
  it('legacy plain lock hash remains ready for npm and skips install', () => {
    expect(markerMatches('hash', 'hash', 'npm')).toBe(true);
    const { result, exec, remove } = run(select({ which: () => null }), { marker: 'hash' });
    expect(result.state).toBe('ok');
    expect(exec).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('unchanged pnpm marker skips install', () => {
    const { exec } = run(select(), { marker: 'pnpm:hash' });
    expect(exec).not.toHaveBeenCalled();
  });
  it('npm without a lock uses install and propagates npm failure', () => {
    const plan = select({ which: () => null, hasNpmLock: false });
    expect(plan.args).toEqual(['install']);
    expect(() => run(plan, { exec: () => { throw Error('npm failed'); } })).toThrow('npm failed');
  });
});
