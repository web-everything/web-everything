import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { renewLaneLeaseOnce } from '../../../lib/lane-lease-heartbeat.mjs';
import { laneLeaseLockPath } from '../../../lib/lane-lease-lock.mjs';
import { readGit } from '../../../lib/proc-read.mjs';
import { leasePool } from './lease-keeps-while-renewed.mjs';

// Real lane-pool processes run at the last possible seam: after the heartbeat's
// final read, immediately before its rename. No mocked allocator decisions.
export function heartbeatMutationRace(action) {
  const pool = leasePool();
  try {
    const now = new Date();
    const lease = { session: 'a', acquiredAt: new Date(now.getTime() - 30_000).toISOString(), ttlMinutes: 240 };
    writeFileSync(pool.marker, JSON.stringify(lease));
    pool.env.CLAUDE_CODE_SESSION_ID = 'adopting-worker';
    const args = action === 'release' ? ['--session=a'] : action === 'acquire'
      ? ['--session=a', '--no-reset', '--no-reap'] : [];
    let concurrent;
    const fs = { existsSync, readFileSync, writeFileSync, rmSync,
      renameSync: (from, to) => {
        concurrent = pool.run(action, ...args);
        renameSync(from, to);
      } };
    const renewed = renewLaneLeaseOnce({ cwd: pool.dir, now: () => now, fs });
    const afterRenewal = JSON.parse(readFileSync(pool.marker, 'utf8'));
    const retry = pool.run(action, ...args);
    const read = () => existsSync(pool.marker) ? JSON.parse(readFileSync(pool.marker, 'utf8')) : null;
    const afterRetry = read();
    const nextRenewed = renewLaneLeaseOnce({ cwd: pool.dir,
      owner: `a||${lease.acquiredAt}`, now: () => now });
    return { action, lease, renewed, concurrentCode: concurrent?.status,
      retryCode: retry.status, afterRenewal, afterRetry, nextRenewed, final: read(),
      expectedRenewal: { ...lease, renewedAt: now.toISOString() } };
  } finally { pool.close(); }
}

export function judgeMutationRace(r) {
  if (!r.renewed || typeof r.concurrentCode !== 'number' || r.concurrentCode === 0 || r.retryCode !== 0) {
    return [`${r.action}: concurrent mutation was not excluded or retry failed`];
  }
  if (JSON.stringify(r.afterRenewal) !== JSON.stringify(r.expectedRenewal)) return ['renewal clobbered another mutation'];
  if (r.action === 'release') return !r.nextRenewed && r.final === null ? [] : ['released lease was resurrected'];
  if (r.action === 'acquire') return !r.nextRenewed && r.final?.holder &&
    JSON.stringify(r.final) === JSON.stringify(r.afterRetry) ? [] : ['reacquired lease was overwritten'];
  if (r.action === 'adopt') return r.nextRenewed && r.final?.workerSession === 'adopting-worker' &&
    JSON.stringify(r.final) === JSON.stringify(r.afterRetry) ? [] : ['adopted worker was overwritten'];
  return ['unknown mutation'];
}

// Held and abandoned mutexes must make only their own lane unavailable.
export function busyLeaseCommands() {
  const pool = leasePool();
  try {
    const second = join(pool.dir, '..', 'lane-2');
    readGit(['clone', '-q', pool.origin, second]);
    mkdirSync(laneLeaseLockPath(pool.marker));
    const invoke = (...args) => spawnSync(process.execPath, [pool.script, ...args, ...pool.args],
      { env: { ...pool.env, CLAUDE_CODE_SESSION_ID: 'me' }, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    const acquire = invoke('acquire', '--session=busy-test', '--no-reset', '--no-reap', '--no-free-list', '--wait-ms=0', '--json');
    const held = { session: 'busy-test', acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
    writeFileSync(pool.marker, JSON.stringify(held));
    const release = pool.run('release', '--session=busy-test');
    // Give each bulk mode a real lease to release even if acquire regresses.
    writeFileSync(join(second, '.git', '.lane-lease'), JSON.stringify(held));
    const bulk = invoke('release', '--all', '--session=busy-test', '--json');
    const secondReleased = !existsSync(join(second, '.git', '.lane-lease'));
    writeFileSync(join(second, '.git', '.lane-lease'), JSON.stringify(held));
    const allPools = invoke('release', '--all-pools', '--session=busy-test', '--json');
    const adopt = invoke('adopt', '--lane=2');
    return { acquire, release, bulk, allPools, adopt, secondReleased,
      allPoolsSecondReleased: !existsSync(join(second, '.git', '.lane-lease')),
      heldUnchanged: readFileSync(pool.marker, 'utf8') === JSON.stringify(held) };
  } finally { pool.close(); }
}

export function judgeBusyLeaseCommands(r) {
  const problems = [];
  if (r.acquire.status !== 0 || !/"lane":\s*2/.test(r.acquire.stdout)) problems.push('auto-pick did not skip busy lane-1');
  for (const name of ['release', 'bulk', 'allPools']) {
    const result = r[name];
    if (result.status !== 1 || !/lease mutation busy/.test(result.stderr) || /\n\s+at /.test(result.stderr)) problems.push(`${name} did not report a clean busy refusal`);
  }
  if (!r.secondReleased || !r.allPoolsSecondReleased || !r.heldUnchanged) problems.push('bulk release stopped or changed the busy lease');
  if (r.adopt.status !== 1 || !/✗.*holds no lease/.test(r.adopt.stderr) || /\n\s+at /.test(r.adopt.stderr)) problems.push('adopt refusal has no clean CLI error');
  return problems;
}

export default {
  id: 'heartbeat-renewal-mutation-race', title: 'heartbeat publication excludes concurrent lease release, reacquire and adopt',
  card: 'PR-7488', fixedBy: { sha: 'heartbeat-renewal-mutation-race', where: 'working-tree' },
  fixPresent: (root) => existsSync(join(root, 'scripts/lib/lane-lease-lock.mjs')),
  run: async () => ({ races: ['release', 'acquire', 'adopt'].map(heartbeatMutationRace), busy: busyLeaseCommands() }),
  judge: ({ races, busy }) => races.length === 3 && ['release', 'acquire', 'adopt'].every(a => races.some(r => r.action === a))
    ? [...races.flatMap(judgeMutationRace), ...judgeBusyLeaseCommands(busy)] : ['incomplete mutation matrix'],
};
