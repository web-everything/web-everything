import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, createReadStream, existsSync } from 'node:fs';
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
  mkdirSync(join(reference, 'backlog'));
  writeFileSync(join(reference, 'backlog', '9999-item.md'), '---\nstatus: resolved\n---\n');
  readGit(['add', 'backlog'], { cwd: reference });
  readGit(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base'], { cwd: reference });
  readGit(['clone', '-q', '--bare', reference, origin]);
  readGit(['remote', 'add', 'origin', origin], { cwd: reference });
  readGit(['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: reference });
  mkdirSync(join(base, 'pool', 'keep'), { recursive: true });
  readGit(['clone', '-q', origin, dir]);
  const args = [`--origin=${origin}`, `--reference=${reference}`, '--name=keep', '--branch=main', '--no-install'];
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'lsof'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = withGhStub({ ...process.env, LANE_POOL_ROOT: join(base, 'pool'),
    PATH: `${bin}:${process.env.PATH}`, WE_LANE_SALVAGE_QUIET_MIN: '0', WE_LANE_SALVAGE_DIR: join(base, 'salvage') });
  const script = resolve('scripts/lane-pool.mjs');
  return { base, dir, args, env, script, origin, reference,
    marker: join(dir, '.git', '.lane-lease'),
    run(command, ...extra) {
      return spawnSync(process.execPath, [script, command, ...args, '--lane=1', ...extra],
        { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    },
    close() { rmSync(base, { recursive: true, force: true }); },
  };
}

export async function renewalRace(pool, renewedAt = new Date().toISOString()) {
  return removalRace(pool, { renewedAt });
}

// Every stale-verdict deletion runs through the real CLI, with a FIFO at the verdict or moved-marker guard.
export async function removalRace(pool, { path = 'acquire', stage = 'verdict', ttlOnly = false,
  renewedAt = new Date().toISOString() } = {}) {
  const lease = { session: 'conveyor-9999', holder: 'original-holder', acquiredAt: new Date(Date.now() - 5 * 3600_000).toISOString(), ttlMinutes: 240 };
  writeFileSync(pool.marker, JSON.stringify(lease));
  if (path === 'reap' && !existsSync(join(pool.dir, '..', 'lane-2'))) readGit(['clone', '-q', pool.origin, join(pool.dir, '..', 'lane-2')]);
  if (path === 'salvage') writeFileSync(join(pool.dir, 'unsaved.txt'), 'holder work\n');
  const command = path === 'trim' ? ['trim', '--max=0', '--json']
    : path === 'reclaim' || path === 'salvage' ? ['reclaim', '--lane=1', ...(path === 'salvage' ? ['--salvage'] : []), '--json']
      : ['acquire', `--lane=${path === 'reap' ? 2 : 1}`, '--session=takeover', ...(path === 'reap' ? [] : ['--no-reap']), '--no-reset'];
  const seam = stage === 'moved' ? 'LANE_POOL_MOVED_LEASE_TEST_BARRIER'
    : ({ acquire: 'LANE_POOL_ACQUIRE_RECLAIM_TEST_BARRIER', reap: 'LANE_POOL_REAP_TEST_BARRIER',
      trim: 'LANE_POOL_TRIM_TEST_BARRIER', reclaim: 'LANE_POOL_RECLAIM_TEST_BARRIER', salvage: 'LANE_POOL_RECLAIM_TEST_BARRIER' })[path];
  const barrier = join(pool.base, `barrier-${path}-${stage}-${ttlOnly}`);
  let observer, timer, child;
  const ready = new Promise((resolveReady, reject) => {
    execFileSync('mkfifo', [`${barrier}.ready`]);
    observer = createReadStream(`${barrier}.ready`);
    observer.once('end', resolveReady).once('error', reject).resume();
    timer = setTimeout(() => reject(new Error('reclaim barrier not reached')), 15_000);
  });
  try {
    child = spawn(process.execPath, [pool.script, ...command, ...pool.args],
      { env: { ...pool.env, [seam]: barrier }, stdio: 'ignore' });
    const done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveDone({ code, signal })); });
    await ready;
    const renewed = ttlOnly ? { ...lease, ttlMinutes: 1440 } : renewedLease(lease, renewedAt);
    writeFileSync(stage === 'moved' ? `${pool.marker}.trim-${child.pid}` : pool.marker, JSON.stringify(renewed));
    writeFileSync(`${barrier}.go`, '');
    const { code, signal } = await done;
    return { code, signal, expected: renewed, actual: JSON.parse(readFileSync(pool.marker, 'utf8')) };
  } finally { clearTimeout(timer); observer?.destroy(); if (child?.exitCode === null) child.kill('SIGTERM'); }
}

export default {
  id: 'lease-keeps-while-renewed', title: 'a working holder renews during stale takeover and retains its lane',
  card: 'lease-keeps-while-renewed', fixedBy: { sha: 'lease-keeps-while-renewed', where: 'working-tree' },
  fixPresent: () => true,
  async run() {
    const pool = leasePool();
    try {
      const reports = [];
      for (const path of ['acquire', 'reap', 'trim', 'reclaim', 'salvage']) {
        for (const ttlOnly of [false, true]) reports.push({ path, ttlOnly, ...await removalRace(pool, { path, stage: 'moved', ttlOnly }) });
      }
      return { reports };
    } finally { pool.close(); }
  },
  judge: (report) => {
    if (report.reports !== undefined) {
      const keys = Array.isArray(report.reports) ? report.reports.map(r => `${r.path}:${r.ttlOnly}`) : [];
      const required = ['acquire', 'reap', 'trim', 'reclaim', 'salvage'].flatMap(p => [`${p}:false`, `${p}:true`]);
      if (keys.length !== required.length || !required.every(k => keys.includes(k))) return ['incomplete removal-race matrix'];
    }
    return (report.reports || [report]).flatMap(({ path, code, signal, expected, actual }) =>
      typeof code === 'number' && (['trim', 'reap'].includes(path) || code !== 0) && signal === null && JSON.stringify(expected) === JSON.stringify(actual)
        ? [] : [`${path || 'acquire'}: renewed lease was taken over`]);
  },
};
