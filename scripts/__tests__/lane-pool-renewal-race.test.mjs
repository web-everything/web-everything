import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { withGhStub } from './fixtures/shared-git-fixture.mjs';
import { renewedLease, sameLeaseVersion, normRenewedAt, isLeaseStale } from '../lib/lane-lease.mjs';

const script = resolve('scripts/lane-pool.mjs');
let base, root, lane, marker, args, env;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'renewal-race-'));
  root = join(base, 'pool');
  const reference = join(base, 'reference');
  const origin = join(base, 'origin.git');
  const git = (a, cwd = base) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(['init', '--quiet', '--initial-branch=trunk', reference]);
  writeFileSync(join(reference, 'file.txt'), 'seed\n');
  git(['add', '.'], reference);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'seed'], reference);
  git(['clone', '--quiet', '--bare', reference, origin]);
  mkdirSync(join(root, 'renewal'), { recursive: true });
  lane = join(root, 'renewal', 'lane-1');
  git(['clone', '--quiet', origin, lane]);
  marker = join(lane, '.git', '.lane-lease');
  args = [`--origin=${origin}`, `--reference=${reference}`, '--name=renewal', '--branch=trunk'];
  env = withGhStub({ ...process.env, LANE_POOL_ROOT: root, LANE_POOL_AUTO_RECOVER: '0', LANE_SESSION: '', CLAUDE_CODE_SESSION_ID: '' });
  writeFileSync(marker, JSON.stringify({ session: 'old', holder: 'old-holder', acquiredAt: new Date(Date.now() - 5 * 3600000).toISOString() }));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

it('stale reclaim keeps a lease renewed after the stale verdict', async () => {
  const barrier = join(base, 'barrier');
  const child = spawn('node', [script, 'acquire', '--lane=1', '--session=new', '--no-reset', '--no-reap', ...args], {
    env: { ...env, LANE_POOL_ACQUIRE_RECLAIM_TEST_BARRIER: barrier }, stdio: 'pipe',
  });
  child.stdout.resume(); child.stderr.resume();
  const done = new Promise(resolve => child.on('exit', resolve));
  try {
    await barrierReady(barrier);
    const renewed = renewedLease(JSON.parse(readFileSync(marker)), new Date().toISOString());
    writeFileSync(marker, JSON.stringify(renewed));
    writeFileSync(`${barrier}.go`, '');
    const code = await done;
    expect(JSON.parse(readFileSync(marker))).toEqual(renewed);
    expect(code).not.toBe(0);
  } finally { child.kill('SIGKILL'); await done; }
}, 30000);

it('a genuinely stale unrenewed lease is still reclaimed', () => {
  const result = spawnSync('node', [script, 'acquire', '--lane=1', '--session=new', '--no-reset', '--no-reap', ...args], { env, encoding: 'utf8', timeout: 20000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(marker)).session).toBe('new');
});

function barrierReady(barrier) {
  return vi.waitFor(() => expect(existsSync(`${barrier}.ready`)).toBe(true), { timeout: 15000, interval: 50 });
}

it.each([false, true])('owner release after its own renewal still works (force=%s)', async force => {
  const lease = JSON.parse(readFileSync(marker));
  lease.acquiredAt = new Date().toISOString(); writeFileSync(marker, JSON.stringify(lease));
  const barrier = join(base, 'release');
  const child = spawn('node', [script, 'release', '--lane=1', '--session=old-holder', ...(force ? ['--force'] : []), ...args], {
    env: { ...env, LANE_POOL_RELEASE_TEST_BARRIER: barrier }, stdio: 'pipe',
  });
  child.stdout.resume(); child.stderr.resume();
  const done = new Promise(resolve => child.on('exit', resolve));
  try {
    await barrierReady(barrier);
    writeFileSync(marker, JSON.stringify(renewedLease(lease, new Date().toISOString())));
    writeFileSync(`${barrier}.go`, '');
    expect(await done).toBe(0); expect(existsSync(marker)).toBe(false);
  } finally { child.kill('SIGKILL'); await done; }
}, 30000);

it.each([[false, null], [true, null], [true, 'session-gone'], [true, 'pr-merged']])('forced foreign release keeps a lease renewed after its verdict (expectations=%s, reason=%s)', async (bound, reason) => {
  if (reason) {
    const lease = { ...JSON.parse(readFileSync(marker)), acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
    writeFileSync(marker, JSON.stringify(lease));
    expect(isLeaseStale(lease, Date.now())).toBe(false);
  }
  const barrier = join(base, 'release');
  const child = spawn('node', [script, 'release', '--lane=1', '--force', '--session=foreign', ...(bound ? ['--expect-holder=old-holder', '--expect-renewed-at=none'] : []), ...(reason ? [`--reason=${reason}`] : []), ...args], {
    env: { ...env, LANE_POOL_RELEASE_TEST_BARRIER: barrier }, stdio: 'pipe',
  });
  child.stdout.resume(); child.stderr.resume();
  const done = new Promise(resolve => child.on('exit', resolve));
  try {
    await barrierReady(barrier);
    const next = renewedLease(JSON.parse(readFileSync(marker)), new Date().toISOString());
    writeFileSync(marker, JSON.stringify(next)); writeFileSync(`${barrier}.go`, '');
    const code = await done; expect(JSON.parse(readFileSync(marker))).toEqual(next);
    if (bound) expect(code).toBe(1);
  } finally { child.kill('SIGKILL'); await done; }
}, 30000);

it.each([['--expect-holder=wrong'], ['--expect-renewed-at=none'], ['--expect-renewed-at=bad']])('release refuses mismatched expectations %s', expected => {
  const lease = renewedLease(JSON.parse(readFileSync(marker)), new Date().toISOString());
  writeFileSync(marker, JSON.stringify(lease));
  const r = spawnSync('node', [script, 'release', '--lane=1', '--session=old-holder', expected, ...args], { env, encoding: 'utf8' });
  expect(r.status).toBe(1); expect(r.stderr).toContain('expected holder/renewedAt');
  expect(JSON.parse(readFileSync(marker))).toEqual(lease);
});

it('version comparison normalizes absent heartbeats and rejects malformed heartbeats', () => {
  const lease = { acquiredAt: 'same', holder: 'same', session: 'same' };
  expect(sameLeaseVersion(lease, { ...lease, renewedAt: null })).toBe(true);
  for (const bad of ['invalid', 42, {}, []]) {
    expect(normRenewedAt(bad)).not.toBe(normRenewedAt(bad));
    expect(sameLeaseVersion({ ...lease, renewedAt: bad }, { ...lease, renewedAt: bad })).toBe(false);
  }
});

it('the reaper binds release to the holder and heartbeat it judged', async () => {
  const { releaseLane } = await import('../conveyor/lease-reaper.mjs');
  let argv;
  releaseLane('renewal', 1, { lease: { holder: 'old-holder', renewedAt: '2026-11-22T00:00:00.000Z' }, exec: (_cmd, args) => { argv = args; } });
  expect(argv).toContain('--expect-holder=old-holder');
  expect(argv).toContain('--expect-renewed-at=2026-11-22T00:00:00.000Z');
  releaseLane('renewal', 1, { lease: { holder: 'old-holder' }, exec: (_cmd, args) => { argv = args; } });
  expect(argv).toContain('--expect-renewed-at=none');
});

it('trim keeps a lease renewed after evaluation', async () => {
  const barrier = join(base, 'trim');
  const child = spawn('node', [script, 'trim', '--max=0', ...args], {
    env: { ...env, LANE_POOL_TRIM_TEST_BARRIER: barrier, LANE_POOL_TRIM_TEST_BARRIER_AT: 'evaluated' }, stdio: 'pipe',
  });
  child.stdout.resume(); child.stderr.resume();
  const done = new Promise(resolve => child.on('exit', resolve));
  try {
    await barrierReady(barrier);
    const next = renewedLease(JSON.parse(readFileSync(marker)), new Date().toISOString());
    writeFileSync(marker, JSON.stringify(next)); writeFileSync(`${barrier}.go`, '');
    await done; expect(JSON.parse(readFileSync(marker))).toEqual(next);
  } finally { child.kill('SIGKILL'); await done; }
}, 30000);

it.each(['session-gone', 'pr-merged'])('reaper releases an unchanged unexpired lease after a %s verdict', async reason => {
  const { releaseLane } = await import('../conveyor/lease-reaper.mjs');
  const lease = { ...JSON.parse(readFileSync(marker)), acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
  writeFileSync(marker, JSON.stringify(lease));
  expect(isLeaseStale(lease, Date.now())).toBe(false);
  releaseLane('renewal', 1, { reason, lease, env, exec: (command, argv, options) =>
    execFileSync(command, [...argv, ...args], { ...options, maxBuffer: 1024 * 1024 }) });
  expect(existsSync(marker)).toBe(false);
});
