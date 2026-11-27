// @vitest-environment node
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolLaneLeased, readPoolLaneStatus } from '../resource-pool-lanes.mjs';
import { readPoolJson } from '../resource-pool-io.mjs';
let root, pool, dir, options;
const nowMs = 2000;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pool-lanes-')); pool = join(root, 'pools', 'web-everything');
  dir = join(pool, 'lane-1'); mkdirSync(dir, { recursive: true });
  options = { cwd: root, readRegistry: () => ({ repos: [{ name: 'web-everything' }] }), env: { LANE_POOL_ROOT: join(root, 'pools') }, nowMs,
    run: vi.fn((command, args) => {
      if (command !== 'git') throw Error('unexpected CLI');
      return args.includes('--show-toplevel') ? join(root, '.lanes', 'web-everything', 'lane-9') : 'unused';
    }), readJson: path => readPoolJson(path).data };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('distinguishes absent, expired, renewed and reserved leases at the TTL boundary', () => {
  const lease = { session: 'fix-1', acquiredAt: new Date(0).toISOString(), ttlMinutes: 1 / 30 };
  expect(readPoolLaneStatus(options).lanes).toEqual([{ path: dir, lease: null, leased: false }]);
  expect(poolLaneLeased(lease, nowMs - 1)).toBe(true); expect(poolLaneLeased(lease, nowMs)).toBe(false);
  for (const patch of [{ renewedAt: new Date(1000).toISOString() }, { reserved: true }]) {
    const renewed = { ...lease, ...patch }; writeFileSync(join(dir, '.lane-lease'), JSON.stringify(renewed));
    expect(readPoolLaneStatus(options).lanes).toEqual([{ path: dir, lease: renewed, leased: true }]);
  }
  expect(options.run.mock.calls.every(([command]) => command === 'git')).toBe(true);
});
it.each(['{', '{}', 'directory', 'symlink', 'missing-pool', 'lane-file'])('fails closed for disk shape %s', shape => {
  const file = join(dir, '.lane-lease');
  if (shape === 'directory') mkdirSync(file);
  else if (shape === 'symlink') symlinkSync(join(root, 'absent'), file);
  else if (shape === 'missing-pool') rmSync(pool, { recursive: true });
  else if (shape === 'lane-file') { rmSync(dir, { recursive: true }); writeFileSync(dir, ''); }
  else writeFileSync(file, shape);
  expect(() => readPoolLaneStatus(options)).toThrow();
});
it('does not mistake a disappearing lane for an absent lease', () => {
  expect(() => readPoolLaneStatus({ ...options, readJson: () => {
    rmSync(dir, { recursive: true }); throw Object.assign(Error('gone'), { code: 'ENOENT' });
  } })).toThrow();
});
it('refuses malformed lease fields and clocks before expiry or reservation filtering', () => {
  const lease = { session: 'fix-1', acquiredAt: new Date(1000).toISOString(), reserved: true };
  for (const patch of [{ session: '' }, { purpose: 1 }, { reserved: 'true' }, { ttlMinutes: 0 },
    { ttlMinutes: null }, { ttlMinutes: 1e308 }, { renewedAt: new Date(0).toISOString() }])
    expect(() => poolLaneLeased({ ...lease, ...patch }, nowMs)).toThrow(/inspect/);
  for (const clock of [NaN, -1]) expect(() => poolLaneLeased(null, clock)).toThrow(/clock/);
});

it('all repo pools counted, including a live fixer outside the checkout pool', () => {
  const sibling = join(root, 'pools', 'sibling', 'lane-7'); mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, '.lane-lease'), JSON.stringify({ session: 'fix-7', acquiredAt: new Date(1000).toISOString() }));
  const readRegistry = () => ({ repos: [{ name: 'web-everything' }, { name: 'sibling' }] });
  expect(readPoolLaneStatus({ ...options, readRegistry }).lanes).toMatchObject([
    { path: dir, leased: false }, { path: sibling, leased: true },
  ]);
});
it('missing configured pool and unreadable or malformed registry refuse with an inspect fallback', () => {
  for (const readRegistry of [() => ({ repos: [{ name: 'absent' }] }),
    () => { throw Error('unreadable registry; inspect registry manually'); },
    () => ({}), () => ({ repos: [] }), () => ({ repos: [{ name: '../escape' }] }),
    () => ({ repos: [{ name: 'web-everything' }, { name: 'web-everything' }] })])
    expect(() => readPoolLaneStatus({ ...options, readRegistry })).toThrow(/inspect|ENOENT/);
});
