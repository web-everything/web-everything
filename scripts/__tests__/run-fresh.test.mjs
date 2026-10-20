// @vitest-environment node
/**
 * @file scripts/__tests__/run-fresh.test.mjs
 * @description `run-fresh.mjs` — runs an operation from a freshly leased lane at origin/main, refuses when the lane
 *   is not exactly at origin/main, and always releases the lane by its holder slug.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseAcquire, runFresh, withSignalsDeferred } from '../run-fresh.mjs';

const SHA = 'a'.repeat(40);
const lease = { lane: 7, path: '/lanes/lane-7', holder: 'run-fresh-x-lane-7-abcd' };

function fakeSpawn({ head = SHA, main = SHA, acquireStatus = 0, opStatus = 0, fetchStatus = 0 } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') {
      if (args.includes('fetch')) return { status: fetchStatus, stdout: '' };
      if (args.includes('HEAD')) return { status: 0, stdout: `${head}\n` };
      return { status: 0, stdout: `${main}\n` };
    }
    if (args[1] === 'acquire') return { status: acquireStatus, stdout: JSON.stringify(lease) };
    if (args[1] === 'release') return { status: 0 };
    return { status: opStatus };
  };
  return { spawn, calls };
}
const opts = (spawn) => ({ spawn, root: '/repo', log: () => {} });

describe('run-fresh', () => {
  it('parses only a complete acquire payload', () => {
    expect(parseAcquire(JSON.stringify(lease))).toEqual(lease);
    expect(parseAcquire('{"lane":7,"path":"/x"}')).toBeNull();
    expect(parseAcquire('/lanes/lane-7')).toBeNull();
  });
  it('runs the operation inside the lane with the terminal passed through, then releases by holder slug', () => {
    const { spawn, calls } = fakeSpawn({ opStatus: 3 });
    expect(runFresh(['land-human-only', '--pr=5', '--dry-run=true'], opts(spawn))).toBe(3);
    const op = calls.find((c) => String(c.args[0]).endsWith('run.mjs'));
    expect(op.args).toEqual(['/lanes/lane-7/scripts/operations/run.mjs', 'land-human-only', '--pr=5', '--dry-run=true']);
    expect(op.opts).toMatchObject({ cwd: '/lanes/lane-7', stdio: 'inherit' });
    expect(calls.at(-1).args).toEqual(['/repo/scripts/lane-pool.mjs', 'release', '--lane=7', `--session=${lease.holder}`, '--repo=/repo']);
  });
  it.each([
    ['a lane behind origin/main', { head: 'b'.repeat(40) }],
    ['a failed fetch', { fetchStatus: 1 }],
  ])('refuses %s without running the operation, and still releases', (_name, over) => {
    const { spawn, calls } = fakeSpawn(over);
    expect(runFresh(['land-human-only'], opts(spawn))).toBe(1);
    expect(calls.some((c) => String(c.args[0]).endsWith('run.mjs'))).toBe(false);
    expect(calls.at(-1).args[1]).toBe('release');
  });
  it('refuses when no lane can be leased, and when no operation is named', () => {
    const { spawn, calls } = fakeSpawn({ acquireStatus: 1 });
    expect(runFresh(['land-human-only'], opts(spawn))).toBe(1);
    expect(calls).toHaveLength(1);
    expect(runFresh(['--pr=5'], opts(fakeSpawn().spawn))).toBe(1);
  });
  it('holds SIGINT/SIGTERM/SIGHUP listeners only while the run is in flight, so release still happens', () => {
    const proc = new EventEmitter();
    let during;
    expect(withSignalsDeferred(() => { during = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => proc.listenerCount(s)); return 4; }, { proc })).toBe(4);
    expect(during).toEqual([1, 1, 1]);
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => proc.listenerCount(s))).toEqual([0, 0, 0]);
  });
  it('reports a signal-killed operation as 130 and still releases', () => {
    const { spawn, calls } = fakeSpawn();
    const wrapped = (cmd, args, o) => (String(args?.[0]).endsWith('run.mjs') ? { status: null, signal: 'SIGINT' } : spawn(cmd, args, o));
    expect(runFresh(['land-human-only'], opts(wrapped))).toBe(130);
    expect(calls.at(-1).args[1]).toBe('release');
  });
});
