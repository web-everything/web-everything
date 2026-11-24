import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, createReadStream } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { renewedLease } from '../../../lib/lane-lease.mjs';
import { readGit } from '../../../lib/proc-read.mjs';
import { withGhStub } from '../../../__tests__/fixtures/shared-git-fixture.mjs';

// Real CLI and local git clones; no network, daemon, or simulated lease decisions.
export function leasePool() {
  const base = mkdtempSync(join(tmpdir(), 'lease-keep-'));
  const origin = join(base, 'origin.git'), reference = join(base, 'reference');
  const dir = join(base, 'pool', 'keep', 'lane-1');
  mkdirSync(reference);
  readGit(['init', '-q', '--initial-branch=main'], { cwd: reference });
  readGit(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'base'], { cwd: reference });
  readGit(['clone', '-q', '--bare', reference, origin]);
  readGit(['remote', 'add', 'origin', origin], { cwd: reference });
  readGit(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: reference });
  mkdirSync(join(base, 'pool', 'keep'), { recursive: true });
  readGit(['clone', '-q', origin, dir]);
  const args = [`--origin=${origin}`, `--reference=${reference}`, '--name=keep', '--branch=main', '--no-install'];
  const env = withGhStub({ ...process.env, LANE_POOL_ROOT: join(base, 'pool') });
  const script = resolve('scripts/lane-pool.mjs');
  return { base, dir, args, env, script,
    marker: join(dir, '.git', '.lane-lease'),
    run(command, ...extra) {
      return spawnSync(process.execPath, [script, command, ...args, '--lane=1', ...extra],
        { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    },
    close() { rmSync(base, { recursive: true, force: true }); },
  };
}

export async function renewalRace(pool, renewedAt = new Date().toISOString()) {
  const lease = { session: 'still-working', holder: 'original-holder', acquiredAt: new Date(Date.now() - 5 * 3600_000).toISOString(), ttlMinutes: 240 };
  writeFileSync(pool.marker, JSON.stringify(lease));
  const barrier = join(pool.base, 'barrier');
  let observer, timer, child;
  const ready = new Promise((resolveReady, reject) => {
    execFileSync('mkfifo', [`${barrier}.ready`]);
    observer = createReadStream(`${barrier}.ready`);
    observer.once('end', resolveReady).once('error', reject).resume();
    timer = setTimeout(() => reject(new Error('reclaim barrier not reached')), 15_000);
  });
  try {
    child = spawn(process.execPath, [pool.script, 'acquire', ...pool.args, '--lane=1', '--session=takeover', '--no-reap', '--no-reset'],
      { env: { ...pool.env, LANE_POOL_ACQUIRE_RECLAIM_TEST_BARRIER: barrier }, stdio: 'ignore' });
    const done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveDone({ code, signal })); });
    await ready;
    const renewed = renewedLease(lease, renewedAt);
    writeFileSync(pool.marker, JSON.stringify(renewed));
    writeFileSync(`${barrier}.go`, '');
    const { code, signal } = await done;
    return { code, signal, expected: renewed, actual: JSON.parse(readFileSync(pool.marker, 'utf8')) };
  } finally { clearTimeout(timer); observer?.destroy(); if (child?.exitCode === null) child.kill('SIGKILL'); }
}

export default {
  id: 'lease-keeps-while-renewed', title: 'a working holder renews during stale takeover and retains its lane',
  card: 'lease-keeps-while-renewed', fixedBy: { sha: 'lease-keeps-while-renewed', where: 'working-tree' },
  fixPresent: () => true,
  async run() {
    const pool = leasePool();
    try { return await renewalRace(pool); } finally { pool.close(); }
  },
  judge: ({ code, signal, expected, actual }) => typeof code === 'number' && code !== 0 && signal === null && JSON.stringify(expected) === JSON.stringify(actual)
    ? [] : ['renewed lease was taken over'],
};
